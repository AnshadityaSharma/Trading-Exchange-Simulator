// bots.ts — in-process liquidity bots: a market maker that keeps both sides
// of every book quoted, and a noise trader whose small market orders create
// trades — and therefore a moving price — for the tape, stats, and charts.
// Why: an empty book makes the demo dead on arrival (CLAUDE.md §3). Bots are
// ordinary users to the exchange — same submit/cancel path, same funds
// checks, same persistence — so nothing downstream needs a special case.
// Key tradeoff: strategies poll on timers instead of subscribing to exchange
// events; at bot scale (a few actions/sec) polling is simpler, and the
// diff-based requote only touches orders that actually need to change, so
// steady state writes nothing.

import type { Side } from '../engine/index.js';
import type { InstrumentMeta } from '../server/config.js';
import type { Exchange } from '../server/exchange.js';
import { NOISE_QTY_PER_INSTRUMENT, type BotIds } from './seed.js';

export interface BotConfig {
  /** Quote levels per side. */
  levels: number;
  /** Quantity per quote level, in lots. */
  sizePerLevel: number;
  /** Distance from mid to the innermost quote, in ticks. */
  halfSpreadTicks: number;
  /** Distance between successive quote levels, in ticks. */
  levelGapTicks: number;
  /** Market-maker quote-maintenance interval. */
  refreshMs: number;
  /** Mean interval between noise trades, per instrument. */
  noiseIntervalMs: number;
  /** Noise trades are 1..noiseMaxQty lots. */
  noiseMaxQty: number;
}

export const DEFAULT_BOT_CONFIG: BotConfig = {
  levels: 3,
  sizePerLevel: 10,
  halfSpreadTicks: 2,
  levelGapTicks: 2,
  refreshMs: 750,
  noiseIntervalMs: 3000,
  noiseMaxQty: 5,
};

/** Nearest tick multiple, floored at one tick (prices must stay positive). */
export function roundToTick(price: number, tickSize: number): number {
  return Math.max(tickSize, Math.round(price / tickSize) * tickSize);
}

export interface Quote {
  side: Side;
  price: number;
}

/** The quote set a maker wants around `mid` (a tick multiple). Pure. */
export function desiredQuotes(mid: number, tickSize: number, cfg: BotConfig): Quote[] {
  const quotes: Quote[] = [];
  for (let i = 0; i < cfg.levels; i++) {
    const offset = (cfg.halfSpreadTicks + i * cfg.levelGapTicks) * tickSize;
    if (mid - offset > 0) quotes.push({ side: 'buy', price: mid - offset });
    quotes.push({ side: 'sell', price: mid + offset });
  }
  return quotes;
}

/**
 * Market maker: each tick converges the bot's live quotes to the desired set
 * around the current mid (last trade price, or the instrument's reference
 * price on a fresh book). Quotes already at a desired price are left alone —
 * an untouched book writes no orders, no cancels, no DB rows.
 */
export class MarketMaker {
  constructor(
    private readonly exchange: Exchange,
    readonly userId: number,
    private readonly cfg: BotConfig,
  ) {}

  tick(meta: InstrumentMeta): void {
    const last = this.exchange.stats(meta.symbol).lastPrice;
    const mid = roundToTick(last ?? meta.referencePrice, meta.tickSize);

    const wanted = new Map<string, Quote>();
    for (const q of desiredQuotes(mid, meta.tickSize, this.cfg)) wanted.set(`${q.side}:${q.price}`, q);

    // Cancel stale quotes FIRST so a recentered bid can never cross the
    // bot's own old ask. A live quote at a desired price is kept even when
    // partially filled — it still provides the level, and once fully
    // consumed it leaves the open set and is replaced on the next tick.
    for (const rec of this.exchange.openOrdersFor(this.userId, meta.symbol)) {
      const key = `${rec.side}:${rec.price}`;
      if (wanted.has(key)) wanted.delete(key);
      else this.exchange.cancel(this.userId, rec.id, async () => null).catch(() => {});
    }

    for (const q of wanted.values()) {
      try {
        this.exchange.submit(this.userId, {
          instrument: meta.symbol,
          side: q.side,
          type: 'limit',
          price: q.price,
          qty: this.cfg.sizePerLevel * meta.lotSize,
        });
      } catch {
        // Out of cash or inventory on this side: quote one-sided this tick.
      }
    }
  }
}

/**
 * Noise trader: fires small market orders so trades print and the price
 * moves. Side selection mean-reverts toward the seeded inventory (65/35),
 * so the bot never bleeds out its shares or its cash — the price walk comes
 * from the 35% contrarian ticks, not from a drifting inventory.
 */
export class NoiseTrader {
  constructor(
    private readonly exchange: Exchange,
    readonly userId: number,
    private readonly cfg: BotConfig,
    private readonly targetQty: number,
    private readonly rng: () => number = Math.random,
  ) {}

  tick(meta: InstrumentMeta): void {
    const qty = (1 + Math.floor(this.rng() * this.cfg.noiseMaxQty)) * meta.lotSize;
    const pos = this.exchange.accounts.position(this.userId, meta.symbol);
    const toward: Side = pos.qty < this.targetQty ? 'buy' : 'sell';
    const side: Side = this.rng() < 0.65 ? toward : toward === 'buy' ? 'sell' : 'buy';
    try {
      this.exchange.submit(this.userId, { instrument: meta.symbol, side, type: 'market', qty });
    } catch {
      // Empty book or insufficient funds/position: skip this tick.
    }
  }
}

/** Owns the timers: one maker interval per instrument, one jittered noise loop. */
export class Bots {
  private readonly maker: MarketMaker;
  private readonly noise: NoiseTrader;
  private readonly makerTimers: NodeJS.Timeout[] = [];
  private readonly noiseTimers = new Map<string, NodeJS.Timeout>();
  private stopped = false;

  constructor(
    private readonly exchange: Exchange,
    ids: BotIds,
    private readonly cfg: BotConfig = DEFAULT_BOT_CONFIG,
    rng: () => number = Math.random,
  ) {
    this.maker = new MarketMaker(exchange, ids.makerUserId, cfg);
    this.noise = new NoiseTrader(exchange, ids.noiseUserId, cfg, NOISE_QTY_PER_INSTRUMENT, rng);
  }

  start(): void {
    for (const meta of this.exchange.instrumentMetas()) {
      this.safeTick(() => this.maker.tick(meta)); // quote immediately: the book must never be empty
      const t = setInterval(() => this.safeTick(() => this.maker.tick(meta)), this.cfg.refreshMs);
      t.unref();
      this.makerTimers.push(t);
      this.scheduleNoise(meta);
    }
  }

  stop(): void {
    this.stopped = true;
    for (const t of this.makerTimers) clearInterval(t);
    for (const t of this.noiseTimers.values()) clearTimeout(t);
    this.makerTimers.length = 0;
    this.noiseTimers.clear();
  }

  private scheduleNoise(meta: InstrumentMeta): void {
    if (this.stopped) return;
    // 0.5–1.5× the mean interval: irregular trades look like a market, and
    // instruments never tick in lockstep.
    const delay = this.cfg.noiseIntervalMs * (0.5 + Math.random());
    const t = setTimeout(() => {
      this.safeTick(() => this.noise.tick(meta));
      this.scheduleNoise(meta);
    }, delay);
    t.unref();
    this.noiseTimers.set(meta.symbol, t);
  }

  /** A bot bug must not take down the exchange with it — log and keep serving. */
  private safeTick(fn: () => void): void {
    try {
      fn();
    } catch (err) {
      console.error('bot tick failed', err);
    }
  }
}
