// write-behind.ts — asynchronous persistence queue between the in-memory
// exchange and Postgres.
// Why: the matching hot path must never await the database (CLAUDE.md §3).
// Mutations are enqueued here in-memory and flushed in batches on a timer;
// the engine's latency is decoupled from the DB's.
// Key tradeoff: a crash loses the last unflushed window (≤ ~100ms) of
// history/balances. Acceptable for paper trading, and stated honestly —
// the alternative (synchronous commit per order) would put a ~1ms+ DB
// round-trip inside every order submission.
//
// Coalescing: rows whose final state is all we need (orders, balances,
// positions) live in latest-wins maps — an order that goes open→filled within
// one flush window writes ONE row, not two. Append-only events (fills,
// trades) queue as plain inserts with ON CONFLICT DO NOTHING so a retried
// flush after a mid-transaction failure can never duplicate them.

import type pg from 'pg';

export interface OrderRow {
  id: string;
  userId: number;
  symbol: string;
  side: string;
  type: string;
  price: number | null;
  qty: number;
  filledQty: number;
  filledNotional: number;
  status: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface FillRow {
  id: string;
  orderId: string;
  userId: number;
  symbol: string;
  side: string;
  role: 'maker' | 'taker';
  price: number;
  qty: number;
  tradeSeq: number;
  ts: Date;
}

export interface TradeRow {
  symbol: string;
  seq: number;
  price: number;
  qty: number;
  takerSide: string;
  ts: Date;
}

export interface BalanceRow {
  userId: number;
  cash: number;
  reservedCash: number;
}

export interface PositionRow {
  userId: number;
  symbol: string;
  qty: number;
  reservedQty: number;
  costBasis: number;
  realizedPnl: number;
}

const FLUSH_INTERVAL_MS = 50;

export class WriteBehind {
  private orders = new Map<string, OrderRow>();
  private fills: FillRow[] = [];
  private trades: TradeRow[] = [];
  private balances = new Map<number, BalanceRow>();
  private positions = new Map<string, PositionRow>();
  private timer: NodeJS.Timeout | null = null;
  /** All flushes serialize through this chain — timer and explicit callers alike. */
  private chain: Promise<void> = Promise.resolve();

  constructor(private readonly pool: pg.Pool) {}

  start(): void {
    this.timer = setInterval(() => void this.flush(), FLUSH_INTERVAL_MS);
    this.timer.unref(); // never keep the process alive just to flush
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.flush();
  }

  upsertOrder(row: OrderRow): void {
    this.orders.set(row.id, row);
  }

  insertFill(row: FillRow): void {
    this.fills.push(row);
  }

  insertTrade(row: TradeRow): void {
    this.trades.push(row);
  }

  upsertBalance(row: BalanceRow): void {
    this.balances.set(row.userId, row);
  }

  upsertPosition(row: PositionRow): void {
    this.positions.set(`${row.userId}:${row.symbol}`, row);
  }

  /**
   * Drain everything queued into one transaction. Called on a timer; callable
   * directly by tests (and by shutdown) to make persistence deterministic —
   * when the returned promise resolves, everything enqueued before the call
   * is durably committed (or re-queued after a failure).
   * On failure the batch is re-queued at the front and retried next tick —
   * ordering within each category is preserved, and all statements are
   * idempotent upserts / conflict-ignoring inserts, so a partially-committed
   * retry is harmless.
   */
  flush(): Promise<void> {
    // doFlush never throws by design, but the chain must survive even if it
    // somehow does: a rejected chain would silently stop ALL future flushes
    // (`.then(fn)` never runs on a rejected promise) and leak unhandled
    // rejections from the timer. Caught in phase review.
    this.chain = this.chain.then(
      () => this.doFlush(),
      () => this.doFlush(),
    );
    return this.chain;
  }

  private async doFlush(): Promise<void> {
    if (
      this.orders.size === 0 &&
      this.fills.length === 0 &&
      this.trades.length === 0 &&
      this.balances.size === 0 &&
      this.positions.size === 0
    ) {
      return;
    }

    // Take ownership of the current batch; new writes go to fresh buffers.
    const orders = this.orders;
    const fills = this.fills;
    const trades = this.trades;
    const balances = this.balances;
    const positions = this.positions;
    this.orders = new Map();
    this.fills = [];
    this.trades = [];
    this.balances = new Map();
    this.positions = new Map();

    // connect() must be INSIDE the try: if it rejects (DB briefly down), the
    // batch we just took ownership of still has to be re-queued.
    let client: pg.PoolClient | null = null;
    try {
      client = await this.pool.connect();
      await client.query('BEGIN');
      for (const o of orders.values()) {
        await client.query(
          `INSERT INTO orders (id, user_id, symbol, side, type, price, qty, filled_qty, filled_notional, status, created_at, updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
           ON CONFLICT (id) DO UPDATE SET
             filled_qty = EXCLUDED.filled_qty,
             filled_notional = EXCLUDED.filled_notional,
             status = EXCLUDED.status,
             updated_at = EXCLUDED.updated_at`,
          [o.id, o.userId, o.symbol, o.side, o.type, o.price, o.qty, o.filledQty, o.filledNotional, o.status, o.createdAt, o.updatedAt],
        );
      }
      for (const f of fills) {
        await client.query(
          `INSERT INTO fills (id, order_id, user_id, symbol, side, role, price, qty, trade_seq, ts)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT (id) DO NOTHING`,
          [f.id, f.orderId, f.userId, f.symbol, f.side, f.role, f.price, f.qty, f.tradeSeq, f.ts],
        );
      }
      for (const t of trades) {
        await client.query(
          `INSERT INTO trades (symbol, seq, price, qty, taker_side, ts)
           VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (symbol, seq) DO NOTHING`,
          [t.symbol, t.seq, t.price, t.qty, t.takerSide, t.ts],
        );
      }
      for (const b of balances.values()) {
        await client.query(
          `INSERT INTO balances (user_id, cash, reserved_cash) VALUES ($1,$2,$3)
           ON CONFLICT (user_id) DO UPDATE SET cash = EXCLUDED.cash, reserved_cash = EXCLUDED.reserved_cash`,
          [b.userId, b.cash, b.reservedCash],
        );
      }
      for (const p of positions.values()) {
        await client.query(
          `INSERT INTO positions (user_id, symbol, qty, reserved_qty, cost_basis, realized_pnl)
           VALUES ($1,$2,$3,$4,$5,$6)
           ON CONFLICT (user_id, symbol) DO UPDATE SET
             qty = EXCLUDED.qty, reserved_qty = EXCLUDED.reserved_qty,
             cost_basis = EXCLUDED.cost_basis, realized_pnl = EXCLUDED.realized_pnl`,
          [p.userId, p.symbol, p.qty, p.reservedQty, p.costBasis, p.realizedPnl],
        );
      }
      await client.query('COMMIT');
    } catch (err) {
      if (client) await client.query('ROLLBACK').catch(() => {});
      // Re-queue at the front: current buffers may already hold newer state.
      // Latest-wins maps: only restore entries not superseded meanwhile.
      for (const [k, v] of orders) if (!this.orders.has(k)) this.orders.set(k, v);
      for (const [k, v] of balances) if (!this.balances.has(k)) this.balances.set(k, v);
      for (const [k, v] of positions) if (!this.positions.has(k)) this.positions.set(k, v);
      this.fills = fills.concat(this.fills);
      this.trades = trades.concat(this.trades);
      console.error('write-behind flush failed; batch re-queued', err);
    } finally {
      client?.release();
    }
  }
}
