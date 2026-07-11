// retention.ts — bounded bot history: periodically deletes bot-vs-bot orders,
// fills, and trades older than the retention window, so 24/7 bot flow cannot
// grow the database without bound (Neon free tier is ~0.5 GB; measured bot
// accrual is ~145 MB/day, decisions.md D28).
// Why 2 days: boot replays only the last 24h of trades into the in-memory
// tape/stats (loadTradeHistory), and the API serves the tape from memory —
// nothing user-visible reads bot history older than that. 2 days keeps a full
// margin over the replay window.
// Hard rule: rows touching a real human are NEVER deleted — a trade is kept
// if either side's fill belongs to a non-bot user, and only fills/orders
// owned by bot accounts are ever removed. Balances and positions (accounting
// state) are never touched: this prunes the journal, not the ledger, so
// money/inventory conservation is unaffected.

import type pg from 'pg';

/** Bot-vs-bot history older than this is deleted. Must stay > the 24h boot replay window. */
export const BOT_HISTORY_RETENTION_DAYS = 2;

/** Steady-state accrual is small (~an hour of quotes per run); hourly keeps delete batches cheap. */
export const PRUNE_INTERVAL_MS = 60 * 60 * 1000;

export interface PruneCounts {
  fills: number;
  trades: number;
  orders: number;
}

/**
 * Delete bot-vs-bot history older than `retentionDays`, in one transaction.
 *
 * A trade is prunable only if NO fill on either side belongs to a non-bot
 * user (the EXCEPT of human trade keys) and it is not the symbol's latest
 * trade — boot restores lastPrice from that row even when it is ancient.
 * Fills are deleted only for prunable trades AND only when owned by a bot
 * (the user_id guard is redundant by construction, but makes "human rows are
 * never deleted" true by inspection). Orders go last: only bot-owned,
 * terminal, old, and with no surviving fills — so a bot order that ever
 * traded against a human keeps its fills and is therefore kept itself,
 * leaving both sides of every human trade fully explainable.
 */
export async function pruneBotHistory(
  pool: pg.Pool,
  botUserIds: readonly number[],
  retentionDays: number = BOT_HISTORY_RETENTION_DAYS,
): Promise<PruneCounts> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const res = await client.query(
      `WITH doomed AS (
         SELECT symbol, seq FROM trades
         WHERE ts < now() - ($2::float8 * interval '1 day')
         EXCEPT SELECT symbol, trade_seq FROM fills WHERE NOT (user_id = ANY($1::int[]))
         EXCEPT SELECT symbol, MAX(seq) FROM trades GROUP BY symbol
       ),
       del_fills AS (
         DELETE FROM fills f USING doomed d
         WHERE f.symbol = d.symbol AND f.trade_seq = d.seq AND f.user_id = ANY($1::int[])
         RETURNING 1
       ),
       del_trades AS (
         DELETE FROM trades t USING doomed d
         WHERE t.symbol = d.symbol AND t.seq = d.seq
         RETURNING 1
       )
       SELECT (SELECT count(*)::int FROM del_fills) AS fills,
              (SELECT count(*)::int FROM del_trades) AS trades`,
      [botUserIds, retentionDays],
    );
    const ordersRes = await client.query(
      `DELETE FROM orders o
       WHERE o.user_id = ANY($1::int[])
         AND o.status IN ('filled', 'canceled')
         AND o.updated_at < now() - ($2::float8 * interval '1 day')
         AND NOT EXISTS (SELECT 1 FROM fills f WHERE f.order_id = o.id)`,
      [botUserIds, retentionDays],
    );
    await client.query('COMMIT');
    return { fills: res.rows[0].fills, trades: res.rows[0].trades, orders: ordersRes.rowCount ?? 0 };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Scheduler: prune once immediately (fire-and-forget, so boot never waits on
 * it) and then hourly. A failed prune is logged and retried next tick —
 * retention is maintenance, never a reason to take the exchange down.
 */
export class Retention {
  private timer: NodeJS.Timeout | null = null;
  private inFlight = false;

  constructor(
    private readonly pool: pg.Pool,
    private readonly botUserIds: readonly number[],
    private readonly retentionDays: number = BOT_HISTORY_RETENTION_DAYS,
  ) {}

  start(): void {
    void this.runOnce();
    this.timer = setInterval(() => void this.runOnce(), PRUNE_INTERVAL_MS);
    this.timer.unref(); // never keep the process alive just to prune
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** One prune pass. Skips if the previous pass is still running (slow DB). */
  async runOnce(): Promise<PruneCounts | null> {
    if (this.inFlight) return null;
    this.inFlight = true;
    try {
      const counts = await pruneBotHistory(this.pool, this.botUserIds, this.retentionDays);
      if (counts.orders || counts.fills || counts.trades) {
        console.log(
          `retention: pruned ${counts.orders} bot orders, ${counts.fills} fills, ${counts.trades} trades (older than ${this.retentionDays}d)`,
        );
      }
      return counts;
    } catch (err) {
      console.error('retention: prune failed; will retry next interval', err);
      return null;
    } finally {
      this.inFlight = false;
    }
  }
}
