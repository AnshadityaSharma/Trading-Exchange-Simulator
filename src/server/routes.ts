// routes.ts — every REST endpoint, conforming to docs/api-contract.md.
// Why: thin translation layer only — zod validates shapes at the boundary
// (CLAUDE.md §6: validate at boundaries only), the Exchange enforces business
// rules, queries.ts serves history. Nothing in here holds state.

import { Router, type NextFunction, type Request, type Response } from 'express';
import type pg from 'pg';
import { z } from 'zod';
import * as q from '../db/queries.js';
import type { WriteBehind } from '../db/write-behind.js';
import { login, requireAuth, signToken, signup, type AuthedRequest } from './auth.js';
import { STARTING_CASH, type Config } from './config.js';
import { ApiError, notFound, validation } from './errors.js';
import type { Exchange } from './exchange.js';
import type { Explainer } from '../ai/explainer.js';

// express 5 propagates rejected promises to the error handler, but wrapping
// keeps the intent explicit and satisfies strict typing.
const wrap =
  (fn: (req: AuthedRequest, res: Response) => Promise<void> | void) =>
  (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(fn(req as AuthedRequest, res)).catch(next);
  };

const emailPassword = z.object({
  email: z.string().email().max(254),
  password: z.string().min(8).max(128),
});

const submitOrder = z.object({
  instrument: z.string().min(1).max(12),
  side: z.enum(['buy', 'sell']),
  type: z.enum(['limit', 'market']),
  price: z.number().int().positive().optional(),
  qty: z.number().int().positive(),
});

function parse<T>(schema: z.ZodType<T>, data: unknown): T {
  const res = schema.safeParse(data);
  if (!res.success) throw validation(res.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
  return res.data;
}

const intQuery = (v: unknown, dflt: number, max: number): number => {
  if (v === undefined) return dflt;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1 || n > max) throw validation(`limit/depth must be an integer between 1 and ${max}`);
  return n;
};

export function buildRoutes(exchange: Exchange, pool: pg.Pool, wb: WriteBehind, config: Config, explainer: Explainer): Router {
  const router = Router();
  const auth = requireAuth(config.jwtSecret);

  // Read-your-writes: history reads drain the write-behind queue first, so a
  // client that just placed an order can immediately GET it. Costs one
  // (batched, serialized) flush per read — reads are human-frequency, and
  // stale-until-flushed responses confused correctness more than they saved
  // (decisions.md D20).
  const flushed = () => wb.flush();

  // ------------------------------------------------------------------ auth

  router.post('/auth/signup', wrap(async (req, res) => {
    const { email, password } = parse(emailPassword, req.body);
    const user = await signup(pool, email, password);
    exchange.accounts.put(user.id, STARTING_CASH, 0);
    res.status(201).json({ token: signToken(user.id, config.jwtSecret), user });
  }));

  router.post('/auth/login', wrap(async (req, res) => {
    const { email, password } = parse(emailPassword, req.body);
    const user = await login(pool, email, password);
    res.json({ token: signToken(user.id, config.jwtSecret), user });
  }));

  // --------------------------------------------------------------- account

  router.get('/me', auth, wrap(async (req, res) => {
    const acct = exchange.accounts.get(req.userId!);
    const userRow = await pool.query('SELECT id, email, created_at FROM users WHERE id = $1', [req.userId]);
    const u = userRow.rows[0];
    res.json({
      user: { id: u.id, email: u.email, createdAt: u.created_at.toISOString() },
      cash: acct.cash,
      reservedCash: acct.reservedCash,
      positions: [...acct.positions.entries()]
        .filter(([, p]) => p.qty !== 0 || p.realizedPnl !== 0)
        .map(([symbol, p]) => ({
          instrument: symbol, qty: p.qty, reservedQty: p.reservedQty,
          costBasis: p.costBasis, realizedPnl: p.realizedPnl,
        })),
    });
  }));

  // ----------------------------------------------------------- market data

  router.get('/instruments', wrap((_req, res) => {
    res.json({
      instruments: exchange.instrumentMetas().map((m) => ({
        symbol: m.symbol, name: m.name, priceScale: m.priceScale, tickSize: m.tickSize, lotSize: m.lotSize,
      })),
    });
  }));

  router.get('/instruments/:symbol/book', wrap((req, res) => {
    requireInstrument(exchange, req.params.symbol as string);
    const depth = intQuery(req.query.depth, 20, 50);
    const snap = exchange.bookSnapshot(req.params.symbol as string, depth);
    res.json({ symbol: req.params.symbol, ...snap });
  }));

  router.get('/instruments/:symbol/stats', wrap((req, res) => {
    requireInstrument(exchange, req.params.symbol as string);
    const stats = exchange.stats(req.params.symbol as string);
    res.json({ symbol: req.params.symbol, ...stats, ts: new Date().toISOString() });
  }));

  router.get('/instruments/:symbol/trades', wrap((req, res) => {
    requireInstrument(exchange, req.params.symbol as string);
    const limit = intQuery(req.query.limit, 50, 200);
    res.json({
      symbol: req.params.symbol,
      trades: exchange.tape(req.params.symbol as string, limit).map((t) => ({
        price: t.price, qty: t.qty, takerSide: t.takerSide, seq: t.seq, ts: t.ts.toISOString(),
      })),
    });
  }));

  // ---------------------------------------------------------------- orders

  router.post('/orders', auth, wrap((req, res) => {
    const body = parse(submitOrder, req.body);
    const result = exchange.submit(req.userId!, body);
    res.status(201).json(result);
  }));

  router.delete('/orders/:id', auth, wrap(async (req, res) => {
    const order = await exchange.cancel(req.userId!, req.params.id as string, async (id) => {
      await flushed(); // the order may have gone terminal within the flush window
      const row = await q.getOrder(pool, id);
      return row ? { userId: row.userId } : null;
    });
    res.json({ order });
  }));

  router.get('/orders', auth, wrap(async (req, res) => {
    const status = (req.query.status as string | undefined) ?? 'all';
    if (!['open', 'filled', 'canceled', 'all'].includes(status)) throw validation('invalid status filter');
    const limit = intQuery(req.query.limit, 50, 200);
    await flushed();
    const rows = await q.listOrders(pool, req.userId!, {
      symbol: req.query.instrument as string | undefined,
      status,
      limit,
      before: req.query.before as string | undefined,
    });
    res.json({
      orders: rows.map(dbOrderToApi),
      nextBefore: rows.length === limit ? rows[rows.length - 1]!.id : null,
    });
  }));

  router.get('/orders/:id', auth, wrap(async (req, res) => {
    await flushed();
    const order = await q.getOrder(pool, req.params.id as string);
    if (!order || order.userId !== req.userId) throw notFound('order not found');
    const fills = await q.fillsForOrder(pool, order.id);
    res.json({
      order: dbOrderToApi(order),
      fills: fills.map((f) => ({ price: f.price, qty: f.qty, ts: f.ts.toISOString() })),
    });
  }));

  router.get('/fills', auth, wrap(async (req, res) => {
    const limit = intQuery(req.query.limit, 50, 200);
    await flushed();
    const rows = await q.listFills(pool, req.userId!, {
      symbol: req.query.instrument as string | undefined,
      limit,
      before: req.query.before as string | undefined,
    });
    res.json({
      fills: rows.map((f) => ({
        id: f.id, orderId: f.orderId, instrument: f.symbol, side: f.side,
        price: f.price, qty: f.qty, role: f.role, ts: f.ts.toISOString(),
      })),
      nextBefore: rows.length === limit ? rows[rows.length - 1]!.id : null,
    });
  }));

  // ------------------------------------------------------------------- ai

  router.get('/orders/:id/explain', auth, wrap(async (req, res) => {
    await flushed();
    const order = await q.getOrder(pool, req.params.id as string);
    if (!order || order.userId !== req.userId) throw notFound('order not found');
    const result = await explainer.explainOrder(order.id);
    res.json(result);
  }));

  // ----------------------------------------------------------------- meta

  router.get('/health', wrap(async (req, res) => {
    // Plain: process liveness only — also the no-op control run in the HTTP
    // benchmark, so it must stay DB-free. ?deep=1 (the keep-warm pinger's
    // variant) round-trips the DB so one external ping wakes both this
    // service and Neon's suspended compute, and says so distinguishably.
    if (req.query.deep === undefined) {
      res.json({ status: 'ok' });
      return;
    }
    await pool.query('SELECT 1');
    res.json({ status: 'ok', db: 'ok' });
  }));

  return router;
}

function requireInstrument(exchange: Exchange, symbol: string): void {
  if (!exchange.meta(symbol)) throw new ApiError(404, 'UNKNOWN_INSTRUMENT', `unknown instrument ${symbol}`);
}

function dbOrderToApi(o: q.DbOrder) {
  return {
    id: o.id, instrument: o.symbol, side: o.side, type: o.type, price: o.price,
    qty: o.qty, filledQty: o.filledQty, filledNotional: o.filledNotional,
    status: o.status, createdAt: o.createdAt.toISOString(),
  };
}
