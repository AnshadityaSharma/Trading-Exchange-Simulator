// exchange.ts — the coordinator: one MatchingEngine per instrument, plus
// everything that has to happen around a match — funds/position reservations,
// order records, market-data sequencing (book + trade, independent per
// docs/decisions.md D12), the trade tape, 24h stats, WebSocket fan-out, and
// write-behind persistence.
// Why: the engine is pure and knows nothing about users' money or the outside
// world (CLAUDE.md §3); this module is the single place where a matching
// result is translated into account mutations, events, and DB rows.
// Key tradeoff: submit/cancel are fully synchronous (memory only, DB queued),
// so the whole exchange stays single-threaded and deterministic; the price is
// that a crash can lose the last unflushed persistence window (~100ms).

import { MatchingEngine, type OrderType, type Side } from '../engine/index.js';
import type { WriteBehind } from '../db/write-behind.js';
import { Accounts } from './accounts.js';
import type { InstrumentMeta } from './config.js';
import { ApiError, validation } from './errors.js';
import { newFillId, newOrderId } from './ids.js';

export type OrderStatus = 'open' | 'partially_filled' | 'filled' | 'canceled';

export interface OrderRecord {
  id: string;
  userId: number;
  symbol: string;
  side: Side;
  type: OrderType;
  price: number | null;
  qty: number;
  filledQty: number;
  filledNotional: number;
  status: OrderStatus;
  createdAt: Date;
  updatedAt: Date;
  engineOrderId: number;
}

export interface ApiOrder {
  id: string;
  instrument: string;
  side: Side;
  type: OrderType;
  price: number | null;
  qty: number;
  filledQty: number;
  filledNotional: number;
  status: OrderStatus;
  createdAt: string;
}

export interface ApiFill {
  id: string;
  orderId: string;
  instrument: string;
  side: Side;
  price: number;
  qty: number;
  role: 'maker' | 'taker';
  ts: string;
}

export interface TapeTrade {
  price: number;
  qty: number;
  takerSide: Side;
  seq: number;
  ts: Date;
}

/** Fan-out hooks; the WS server registers itself here. Defaults: no-ops. */
export interface ExchangeEvents {
  bookDelta(symbol: string, msg: object): void;
  trade(symbol: string, msg: object): void;
  user(userId: number, msg: object): void;
}

interface MinuteBucket {
  minute: number; // epoch minutes
  first: number;
  high: number;
  low: number;
  volume: number;
}

const TAPE_LIMIT = 200;
const BOOK_DEPTH = 50;

interface InstrumentState {
  meta: InstrumentMeta;
  engine: MatchingEngine;
  bookSeq: number;
  tradeSeq: number;
  tape: TapeTrade[];
  buckets: MinuteBucket[];
  lastPrice: number | null;
  /** Engine order ID → live order record (for maker lookups on fills). */
  byEngineId: Map<number, OrderRecord>;
  /**
   * The top-50 window as of the last broadcast delta (price → qty per side).
   * Deltas are computed by diffing this against the engine's current top 50,
   * which makes the contract's window semantics exact: levels entering or
   * leaving the window produce correct absolute-qty entries, and nothing
   * outside the window is ever sent.
   */
  lastBids: Map<number, number>;
  lastAsks: Map<number, number>;
}

export interface SubmitParams {
  instrument: string;
  side: Side;
  type: OrderType;
  price?: number;
  qty: number;
}

export class Exchange {
  private readonly instruments = new Map<string, InstrumentState>();
  /** Public order ID → live (open/partially_filled) order record. */
  private readonly openOrders = new Map<string, OrderRecord>();

  events: ExchangeEvents = { bookDelta() {}, trade() {}, user() {} };

  constructor(
    metas: readonly InstrumentMeta[],
    readonly accounts: Accounts,
    private readonly wb: WriteBehind,
  ) {
    for (const meta of metas) {
      this.instruments.set(meta.symbol, {
        meta,
        engine: new MatchingEngine(),
        bookSeq: 0,
        tradeSeq: 0,
        tape: [],
        buckets: [],
        lastPrice: null,
        byEngineId: new Map(),
        lastBids: new Map(),
        lastAsks: new Map(),
      });
    }
  }

  // ------------------------------------------------------------- boot state

  /** Continue the persistent trade sequence after a restart (from max(seq)). */
  initTradeSeq(symbol: string, seq: number): void {
    this.inst(symbol).tradeSeq = seq;
  }

  /** Replay a persisted trade (boot only) into stats/tape state. */
  loadHistoricalTrade(symbol: string, t: TapeTrade): void {
    const inst = this.inst(symbol);
    inst.lastPrice = t.price;
    this.pushTapeAndStats(inst, t);
  }

  // ------------------------------------------------------------ public API

  instrumentMetas(): InstrumentMeta[] {
    return [...this.instruments.values()].map((i) => i.meta);
  }

  meta(symbol: string): InstrumentMeta | undefined {
    return this.instruments.get(symbol)?.meta;
  }

  bookSnapshot(symbol: string, depth: number): { seq: number; bids: [number, number][]; asks: [number, number][] } {
    const inst = this.inst(symbol);
    const d = inst.engine.depth(depth);
    return {
      seq: inst.bookSeq,
      bids: d.bids.map((l) => [l.price, l.qty]),
      asks: d.asks.map((l) => [l.price, l.qty]),
    };
  }

  tape(symbol: string, limit: number): TapeTrade[] {
    const t = this.inst(symbol).tape;
    return t.slice(Math.max(0, t.length - limit)).reverse(); // most recent first
  }

  stats(symbol: string): {
    lastPrice: number | null;
    open24h: number | null;
    high24h: number | null;
    low24h: number | null;
    volume24h: number;
  } {
    const inst = this.inst(symbol);
    this.pruneBuckets(inst, Date.now());
    let open: number | null = null;
    let high: number | null = null;
    let low: number | null = null;
    let volume = 0;
    for (const b of inst.buckets) {
      if (open === null) open = b.first;
      high = high === null ? b.high : Math.max(high, b.high);
      low = low === null ? b.low : Math.min(low, b.low);
      volume += b.volume;
    }
    return { lastPrice: inst.lastPrice, open24h: open, high24h: high, low24h: low, volume24h: volume };
  }

  /**
   * Submit an order: reserve funds/position, match synchronously, fan out
   * events, queue persistence. Throws ApiError on business rejections —
   * a rejected order is never created (api-contract.md).
   */
  submit(userId: number, p: SubmitParams): { order: ApiOrder; fills: { price: number; qty: number; ts: string }[] } {
    const inst = this.instruments.get(p.instrument);
    if (!inst) throw new ApiError(404, 'UNKNOWN_INSTRUMENT', `unknown instrument ${p.instrument}`);
    const { meta, engine } = inst;

    if (!Number.isInteger(p.qty) || p.qty <= 0) throw validation('qty must be a positive integer');
    if (p.qty % meta.lotSize !== 0) throw validation(`qty must be a multiple of lot size ${meta.lotSize}`);
    if (p.type === 'limit') {
      if (p.price === undefined) throw validation('limit orders require a price');
      if (!Number.isInteger(p.price) || p.price <= 0) throw validation('price must be a positive integer');
      if (p.price % meta.tickSize !== 0) throw validation(`price must be a multiple of tick size ${meta.tickSize}`);
    } else if (p.price !== undefined) {
      throw validation('market orders must not carry a price');
    }

    // Funds / position checks (and reservations) BEFORE touching the engine.
    const limitPrice = p.type === 'limit' ? p.price! : null;
    if (p.side === 'buy') {
      if (p.type === 'limit') {
        if (!this.accounts.tryReserveCash(userId, limitPrice! * p.qty)) {
          throw new ApiError(400, 'INSUFFICIENT_FUNDS', 'insufficient cash for buy order');
        }
      } else {
        // Market buy: nothing rests and matching is synchronous, so check the
        // exact sweep cost against the live book instead of reserving.
        const cost = this.marketBuyCost(inst, userId, p.qty);
        if (cost === null) throw validation('cannot market-buy: order book is empty');
        if (this.accounts.get(userId).cash < cost) {
          throw new ApiError(400, 'INSUFFICIENT_FUNDS', 'insufficient cash for market buy');
        }
      }
    } else {
      if (!this.accounts.tryReservePosition(userId, p.instrument, p.qty)) {
        throw new ApiError(400, 'INSUFFICIENT_POSITION', 'insufficient position for sell order (no short selling)');
      }
    }

    const now = new Date();
    const result = engine.submit({
      userId,
      side: p.side,
      type: p.type,
      price: limitPrice ?? undefined,
      qty: p.qty,
    });

    const taker: OrderRecord = {
      id: newOrderId(),
      userId,
      symbol: p.instrument,
      side: p.side,
      type: p.type,
      price: limitPrice,
      qty: p.qty,
      filledQty: 0,
      filledNotional: 0,
      status: 'open',
      createdAt: now,
      updatedAt: now,
      engineOrderId: result.orderId,
    };

    // Self-trade prevention releases: the engine canceled our own resting
    // orders on the opposite side; release their reservations and notify.
    for (const engId of result.selfTradeCanceledOrderIds) {
      const rec = inst.byEngineId.get(engId)!;
      this.releaseRemainder(rec);
      this.finishOrder(inst, rec, 'canceled', now);
      this.events.user(rec.userId, { type: 'order_update', order: toApiOrder(rec) });
    }

    const takerFills: { price: number; qty: number; ts: string }[] = [];
    for (const fill of result.fills) {
      const maker = inst.byEngineId.get(fill.makerOrderId)!;
      inst.tradeSeq++;
      const trade: TapeTrade = { price: fill.price, qty: fill.qty, takerSide: p.side, seq: inst.tradeSeq, ts: now };
      inst.lastPrice = fill.price;
      this.pushTapeAndStats(inst, trade);
      this.wb.insertTrade({ symbol: p.instrument, seq: trade.seq, price: trade.price, qty: trade.qty, takerSide: trade.takerSide, ts: now });
      this.events.trade(p.instrument, {
        type: 'trade', symbol: p.instrument, price: trade.price, qty: trade.qty,
        takerSide: trade.takerSide, seq: trade.seq, ts: now.toISOString(),
      });

      // Maker side: account, order record, private events.
      if (maker.side === 'buy') {
        this.accounts.applyBuyFill(maker.userId, p.instrument, fill.price, fill.qty, maker.price);
      } else {
        this.accounts.applySellFill(maker.userId, p.instrument, fill.price, fill.qty);
      }
      maker.filledQty += fill.qty;
      maker.filledNotional += fill.price * fill.qty;
      maker.updatedAt = now;
      const makerDone = maker.filledQty === maker.qty;
      if (makerDone) this.finishOrder(inst, maker, 'filled', now);
      else {
        maker.status = 'partially_filled';
        this.persistOrder(maker);
      }
      this.emitFill(maker, fill.price, fill.qty, 'maker', trade.seq, now);
      this.events.user(maker.userId, { type: 'order_update', order: toApiOrder(maker) });
      this.persistAccount(maker.userId, p.instrument);

      // Taker side: account + response fills (order_update sent once, below).
      if (p.side === 'buy') {
        this.accounts.applyBuyFill(userId, p.instrument, fill.price, fill.qty, limitPrice);
      } else {
        this.accounts.applySellFill(userId, p.instrument, fill.price, fill.qty);
      }
      taker.filledQty += fill.qty;
      taker.filledNotional += fill.price * fill.qty;
      this.emitFill(taker, fill.price, fill.qty, 'taker', trade.seq, now);
      takerFills.push({ price: fill.price, qty: fill.qty, ts: now.toISOString() });
    }

    // Classify the taker's terminal/resting state.
    if (result.status === 'filled') {
      taker.status = 'filled';
    } else if (result.status === 'resting' || result.status === 'partial-resting') {
      taker.status = taker.filledQty > 0 ? 'partially_filled' : 'open';
      this.openOrders.set(taker.id, taker);
      inst.byEngineId.set(taker.engineOrderId, taker);
    } else {
      // Market remainder canceled ('canceled' | 'partial-canceled'). A market
      // sell reserved the full qty; release what didn't execute.
      taker.status = 'canceled';
      if (p.side === 'sell') this.accounts.releasePosition(userId, p.instrument, p.qty - taker.filledQty);
    }
    this.persistOrder(taker);
    this.persistAccount(userId, p.instrument);
    this.events.user(userId, { type: 'order_update', order: toApiOrder(taker) });

    this.broadcastDelta(inst);
    return { order: toApiOrder(taker), fills: takerFills };
  }

  /** Cancel an open order. Async only for the not-in-memory error path. */
  async cancel(userId: number, orderId: string, lookupClosed: (id: string) => Promise<{ userId: number } | null>): Promise<ApiOrder> {
    const rec = this.openOrders.get(orderId);
    if (!rec || rec.userId !== userId) {
      // Distinguish "never yours/existed" from "yours but already terminal".
      const row = await lookupClosed(orderId);
      if (row && row.userId === userId) throw new ApiError(409, 'ORDER_NOT_OPEN', 'order is already filled or canceled');
      throw new ApiError(404, 'NOT_FOUND', 'order not found');
    }
    const inst = this.inst(rec.symbol);
    inst.engine.cancel(rec.engineOrderId);
    this.releaseRemainder(rec);
    const now = new Date();
    this.finishOrder(inst, rec, 'canceled', now);
    this.events.user(userId, { type: 'order_update', order: toApiOrder(rec) });
    this.persistAccount(userId, rec.symbol);
    this.broadcastDelta(inst);
    return toApiOrder(rec);
  }

  // -------------------------------------------------------------- internals

  private inst(symbol: string): InstrumentState {
    const inst = this.instruments.get(symbol);
    if (!inst) throw new ApiError(404, 'UNKNOWN_INSTRUMENT', `unknown instrument ${symbol}`);
    return inst;
  }

  /**
   * Exact cost to sweep `qty` off the current asks; null if book is empty.
   * The submitter's own resting asks are EXCLUDED: self-trade prevention will
   * cancel them, so the order actually fills against deeper (possibly
   * pricier) levels. Counting own liquidity here once allowed an order to
   * pass the check and then spend more than the user had (negative cash) —
   * the precheck must model exactly what the engine will do, STP included.
   * The own-order scan is O(resting orders on this instrument); market buys
   * are user-frequency events, nowhere near the matching hot path.
   */
  private marketBuyCost(inst: InstrumentState, userId: number, qty: number): number | null {
    const asks = inst.engine.depth(Number.MAX_SAFE_INTEGER).asks;
    if (asks.length === 0) return null;
    const ownAskQty = new Map<number, number>();
    for (const rec of inst.byEngineId.values()) {
      if (rec.userId === userId && rec.side === 'sell') {
        ownAskQty.set(rec.price!, (ownAskQty.get(rec.price!) ?? 0) + (rec.qty - rec.filledQty));
      }
    }
    let remaining = qty;
    let cost = 0;
    for (const level of asks) {
      const available = level.qty - (ownAskQty.get(level.price) ?? 0);
      if (available <= 0) continue;
      const take = Math.min(remaining, available);
      cost += take * level.price;
      remaining -= take;
      if (remaining === 0) break;
    }
    return cost; // remainder beyond (non-own) book depth is canceled, costs nothing
  }

  /** Release the reservation covering an order's unfilled remainder. */
  private releaseRemainder(rec: OrderRecord): void {
    const remaining = rec.qty - rec.filledQty;
    if (remaining === 0) return;
    if (rec.side === 'buy') this.accounts.releaseCash(rec.userId, rec.price! * remaining);
    else this.accounts.releasePosition(rec.userId, rec.symbol, remaining);
  }

  /** Move an order to a terminal state and drop it from the live maps. */
  private finishOrder(inst: InstrumentState, rec: OrderRecord, status: OrderStatus, now: Date): void {
    rec.status = status;
    rec.updatedAt = now;
    this.openOrders.delete(rec.id);
    inst.byEngineId.delete(rec.engineOrderId);
    this.persistOrder(rec);
  }

  private emitFill(rec: OrderRecord, price: number, qty: number, role: 'maker' | 'taker', tradeSeq: number, ts: Date): void {
    const fill: ApiFill = {
      id: newFillId(), orderId: rec.id, instrument: rec.symbol, side: rec.side,
      price, qty, role, ts: ts.toISOString(),
    };
    this.wb.insertFill({
      id: fill.id, orderId: rec.id, userId: rec.userId, symbol: rec.symbol,
      side: rec.side, role, price, qty, tradeSeq, ts,
    });
    this.events.user(rec.userId, { type: 'fill', fill });
  }

  private persistOrder(rec: OrderRecord): void {
    this.wb.upsertOrder({
      id: rec.id, userId: rec.userId, symbol: rec.symbol, side: rec.side, type: rec.type,
      price: rec.price, qty: rec.qty, filledQty: rec.filledQty,
      filledNotional: rec.filledNotional, status: rec.status,
      createdAt: rec.createdAt, updatedAt: rec.updatedAt,
    });
  }

  private persistAccount(userId: number, symbol: string): void {
    const acct = this.accounts.get(userId);
    this.wb.upsertBalance({ userId, cash: acct.cash, reservedCash: acct.reservedCash });
    const pos = this.accounts.position(userId, symbol);
    this.wb.upsertPosition({
      userId, symbol, qty: pos.qty, reservedQty: pos.reservedQty,
      costBasis: pos.costBasis, realizedPnl: pos.realizedPnl,
    });
  }

  private pushTapeAndStats(inst: InstrumentState, t: TapeTrade): void {
    inst.tape.push(t);
    if (inst.tape.length > TAPE_LIMIT) inst.tape.shift();
    const minute = Math.floor(t.ts.getTime() / 60_000);
    const last = inst.buckets[inst.buckets.length - 1];
    if (last && last.minute === minute) {
      last.high = Math.max(last.high, t.price);
      last.low = Math.min(last.low, t.price);
      last.volume += t.qty;
    } else {
      inst.buckets.push({ minute, first: t.price, high: t.price, low: t.price, volume: t.qty });
    }
    this.pruneBuckets(inst, t.ts.getTime());
  }

  private pruneBuckets(inst: InstrumentState, nowMs: number): void {
    const cutoff = Math.floor(nowMs / 60_000) - 24 * 60;
    while (inst.buckets.length > 0 && inst.buckets[0]!.minute < cutoff) inst.buckets.shift();
  }

  /**
   * One book_delta message per submit/cancel: diff the engine's current
   * top-50 window against the window as of the last broadcast. Absolute
   * quantities; [price, 0] marks a level that left the window.
   */
  private broadcastDelta(inst: InstrumentState): void {
    const cur = inst.engine.depth(BOOK_DEPTH);
    const bids = diffWindow(inst.lastBids, cur.bids);
    const asks = diffWindow(inst.lastAsks, cur.asks);
    if (bids.length === 0 && asks.length === 0) return;
    inst.bookSeq++;
    this.events.bookDelta(inst.meta.symbol, {
      type: 'book_delta', symbol: inst.meta.symbol, seq: inst.bookSeq, bids, asks,
    });
  }
}

/** Diff the previous window (mutated in place to the new one) against current levels. */
function diffWindow(prev: Map<number, number>, cur: { price: number; qty: number }[]): [number, number][] {
  const out: [number, number][] = [];
  for (const level of cur) {
    if (prev.get(level.price) !== level.qty) out.push([level.price, level.qty]);
    prev.delete(level.price);
  }
  for (const price of prev.keys()) out.push([price, 0]); // left the window
  prev.clear();
  for (const level of cur) prev.set(level.price, level.qty);
  return out;
}

export function toApiOrder(rec: OrderRecord): ApiOrder {
  return {
    id: rec.id, instrument: rec.symbol, side: rec.side, type: rec.type,
    price: rec.price, qty: rec.qty, filledQty: rec.filledQty,
    filledNotional: rec.filledNotional, status: rec.status,
    createdAt: rec.createdAt.toISOString(),
  };
}
