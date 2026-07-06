// queries.ts — every read query the API serves, as plain SQL functions.
// Why: CLAUDE.md §4 — no ORM; each query is visible, explainable, and indexed
// deliberately (see schema.sql indexes). Writes go through write-behind.ts;
// this file is reads only (plus boot-time reconciliation).

import type pg from 'pg';
import type { Position } from '../server/accounts.js';

export interface DbOrder {
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
}

const orderCols =
  'id, user_id AS "userId", symbol, side, type, price, qty, filled_qty AS "filledQty", filled_notional AS "filledNotional", status, created_at AS "createdAt"';

export async function getOrder(pool: pg.Pool, id: string): Promise<DbOrder | null> {
  const res = await pool.query(`SELECT ${orderCols} FROM orders WHERE id = $1`, [id]);
  return res.rows[0] ?? null;
}

/**
 * Cursor pagination on (created_at, id): the index orders_user_created serves
 * this exactly. `before` is the id of the last row of the previous page.
 */
export async function listOrders(
  pool: pg.Pool,
  userId: number,
  opts: { symbol?: string; status?: string; limit: number; before?: string },
): Promise<DbOrder[]> {
  const params: unknown[] = [userId];
  let where = 'user_id = $1';
  if (opts.symbol) {
    params.push(opts.symbol);
    where += ` AND symbol = $${params.length}`;
  }
  if (opts.status === 'open') {
    where += ` AND status IN ('open', 'partially_filled')`;
  } else if (opts.status && opts.status !== 'all') {
    params.push(opts.status);
    where += ` AND status = $${params.length}`;
  }
  if (opts.before) {
    params.push(opts.before);
    where += ` AND (created_at, id) < (SELECT created_at, id FROM orders WHERE id = $${params.length})`;
  }
  params.push(opts.limit);
  const res = await pool.query(
    `SELECT ${orderCols} FROM orders WHERE ${where} ORDER BY created_at DESC, id DESC LIMIT $${params.length}`,
    params,
  );
  return res.rows;
}

export interface DbFill {
  id: string;
  orderId: string;
  symbol: string;
  side: string;
  role: string;
  price: number;
  qty: number;
  ts: Date;
}

const fillCols = 'id, order_id AS "orderId", symbol, side, role, price, qty, ts';

export async function listFills(
  pool: pg.Pool,
  userId: number,
  opts: { symbol?: string; limit: number; before?: string },
): Promise<DbFill[]> {
  const params: unknown[] = [userId];
  let where = 'user_id = $1';
  if (opts.symbol) {
    params.push(opts.symbol);
    where += ` AND symbol = $${params.length}`;
  }
  if (opts.before) {
    params.push(opts.before);
    where += ` AND (ts, id) < (SELECT ts, id FROM fills WHERE id = $${params.length})`;
  }
  params.push(opts.limit);
  const res = await pool.query(
    `SELECT ${fillCols} FROM fills WHERE ${where} ORDER BY ts DESC, id DESC LIMIT $${params.length}`,
    params,
  );
  return res.rows;
}

export async function fillsForOrder(pool: pg.Pool, orderId: string): Promise<DbFill[]> {
  // trade_seq, not ts: every fill of one multi-level sweep shares a timestamp,
  // and fill ids are random — trade_seq is the only field that preserves
  // execution order (best price first).
  const res = await pool.query(
    `SELECT ${fillCols} FROM fills WHERE order_id = $1 ORDER BY trade_seq ASC`,
    [orderId],
  );
  return res.rows;
}

// ----------------------------------------------------------- boot loading

export interface BootAccount {
  userId: number;
  cash: number;
  reservedCash: number;
  positions: { symbol: string; pos: Position }[];
}

export async function loadAccounts(pool: pg.Pool): Promise<BootAccount[]> {
  const balances = await pool.query(
    'SELECT user_id AS "userId", cash, reserved_cash AS "reservedCash" FROM balances',
  );
  const positions = await pool.query(
    `SELECT user_id AS "userId", symbol, qty, reserved_qty AS "reservedQty",
            cost_basis AS "costBasis", realized_pnl AS "realizedPnl" FROM positions`,
  );
  const bySymbol = new Map<number, { symbol: string; pos: Position }[]>();
  for (const r of positions.rows) {
    const list = bySymbol.get(r.userId) ?? [];
    list.push({
      symbol: r.symbol,
      pos: { qty: r.qty, reservedQty: r.reservedQty, costBasis: r.costBasis, realizedPnl: r.realizedPnl },
    });
    bySymbol.set(r.userId, list);
  }
  return balances.rows.map((b) => ({
    userId: b.userId,
    cash: b.cash,
    reservedCash: b.reservedCash,
    positions: bySymbol.get(b.userId) ?? [],
  }));
}

/**
 * Boot reconciliation: the in-memory book died with the last process, so any
 * order still marked open in the DB can never fill — cancel it and release
 * its reservation (decisions.md D15). Runs BEFORE accounts load, in one
 * transaction, so memory always boots from a consistent snapshot.
 */
export async function reconcileOpenOrders(pool: pg.Pool): Promise<number> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const open = await client.query(
      `SELECT id, user_id AS "userId", symbol, side, price, qty, filled_qty AS "filledQty"
       FROM orders WHERE status IN ('open', 'partially_filled') FOR UPDATE`,
    );
    for (const o of open.rows) {
      const remaining = o.qty - o.filledQty;
      if (o.side === 'buy') {
        await client.query(
          'UPDATE balances SET cash = cash + $1, reserved_cash = reserved_cash - $1 WHERE user_id = $2',
          [o.price * remaining, o.userId],
        );
      } else {
        await client.query(
          'UPDATE positions SET reserved_qty = reserved_qty - $1 WHERE user_id = $2 AND symbol = $3',
          [remaining, o.userId, o.symbol],
        );
      }
    }
    await client.query(
      `UPDATE orders SET status = 'canceled', updated_at = now() WHERE status IN ('open', 'partially_filled')`,
    );
    await client.query('COMMIT');
    return open.rowCount ?? 0;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

export interface BootTrade {
  symbol: string;
  seq: number;
  price: number;
  qty: number;
  takerSide: string;
  ts: Date;
}

/** Last-24h trades (for stats buckets) plus each symbol's last trade ever. */
export async function loadTradeHistory(pool: pg.Pool): Promise<{
  maxSeq: Map<string, number>;
  recent: BootTrade[];
  lastTrades: Map<string, BootTrade>;
}> {
  const seqs = await pool.query('SELECT symbol, MAX(seq) AS max FROM trades GROUP BY symbol');
  const maxSeq = new Map<string, number>(seqs.rows.map((r) => [r.symbol, Number(r.max)]));
  const recent = await pool.query(
    `SELECT symbol, seq, price, qty, taker_side AS "takerSide", ts
     FROM trades WHERE ts > now() - interval '24 hours' ORDER BY ts ASC, seq ASC`,
  );
  const last = await pool.query(
    `SELECT DISTINCT ON (symbol) symbol, seq, price, qty, taker_side AS "takerSide", ts
     FROM trades ORDER BY symbol, seq DESC`,
  );
  return {
    maxSeq,
    recent: recent.rows,
    lastTrades: new Map(last.rows.map((r) => [r.symbol, r])),
  };
}
