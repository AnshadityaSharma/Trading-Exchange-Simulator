// boot.ts — assembles the whole backend from a Config: migrate, reconcile,
// load state, wire exchange + HTTP + WS. Returned handle can be shut down.
// Why: index.ts (the process) and the integration tests boot the exact same
// stack — the restart-reconciliation path is testable only because boot is a
// function, not a script.
// Boot order is deliberate:
//   1. migrate              — schema exists
//   2. reconcileOpenOrders  — DB says no order is open (the book died with
//                             the last process; reservations released)
//   3. seedBots             — bot rows exist in the DB, so step 4 loads them
//                             like any user (Phase 3 review: seed state must
//                             enter through the persisted path)
//   4. load accounts/trades — memory boots from that consistent snapshot
//   5. write-behind, HTTP, WS, bots, retention — begin accepting traffic

import { createServer, type Server } from 'node:http';
import Anthropic from '@anthropic-ai/sdk';
import type pg from 'pg';
import {
  AnthropicExplainer,
  DEFAULT_AI_MODEL,
  RuleBasedExplainer,
  type Explainer,
  type ExplainDataSource,
} from '../ai/explainer.js';
import { Bots } from '../bots/bots.js';
import { seedBots } from '../bots/seed.js';
import { createPool, migrate } from '../db/db.js';
import { fillsForOrder, getOrder, loadAccounts, loadTradeHistory, reconcileOpenOrders } from '../db/queries.js';
import { Retention } from '../db/retention.js';
import { WriteBehind } from '../db/write-behind.js';
import { Accounts } from './accounts.js';
import { buildApp } from './app.js';
import { INSTRUMENTS, type Config } from './config.js';
import { Exchange } from './exchange.js';
import { WsServer } from './ws.js';

export interface Backend {
  server: Server;
  exchange: Exchange;
  wb: WriteBehind;
  pool: pg.Pool;
  reconciledOrders: number;
  /** Listening port (after listen()). */
  port: number;
  close(): Promise<void>;
}

export async function boot(config: Config, explainerOverride?: Explainer): Promise<Backend> {
  const pool = createPool(config.databaseUrl);
  await migrate(pool);
  const reconciledOrders = await reconcileOpenOrders(pool);
  const botIds = config.bots ? await seedBots(pool, INSTRUMENTS) : null;

  const accounts = new Accounts();
  for (const acct of await loadAccounts(pool)) {
    accounts.put(acct.userId, acct.cash, acct.reservedCash);
    for (const { symbol, pos } of acct.positions) accounts.putPosition(acct.userId, symbol, pos);
  }

  const wb = new WriteBehind(pool);
  const exchange = new Exchange(INSTRUMENTS, accounts, wb);
  const explainer = explainerOverride ?? buildExplainer(config, pool, exchange);

  const history = await loadTradeHistory(pool);
  for (const [symbol, seq] of history.maxSeq) exchange.initTradeSeq(symbol, seq);
  const replayed = new Set(history.recent.map((t) => t.symbol));
  for (const t of history.recent) {
    exchange.loadHistoricalTrade(t.symbol, { price: t.price, qty: t.qty, takerSide: t.takerSide as 'buy' | 'sell', seq: t.seq, ts: t.ts });
  }
  // lastPrice must survive even when the last trade is older than 24h.
  for (const [symbol, t] of history.lastTrades) {
    if (!replayed.has(symbol)) {
      exchange.loadHistoricalTrade(symbol, { price: t.price, qty: t.qty, takerSide: t.takerSide as 'buy' | 'sell', seq: t.seq, ts: t.ts });
    }
  }

  wb.start();
  const app = buildApp(exchange, pool, wb, config, explainer);
  const server = createServer(app);
  const ws = new WsServer(server, exchange, config.jwtSecret);

  // After the WS server wires exchange.events (first quotes fan out), before
  // listen (the book is populated before the first request can arrive).
  const bots = botIds ? new Bots(exchange, botIds) : null;
  bots?.start();

  // Bot history retention (D28): prune once now (fire-and-forget) and hourly.
  // Only meaningful when bots run — humans' history is tiny and never pruned.
  const retention = botIds ? new Retention(pool, [botIds.makerUserId, botIds.noiseUserId]) : null;
  retention?.start();

  await new Promise<void>((resolve) => server.listen(config.port, resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : config.port;

  return {
    server,
    exchange,
    wb,
    pool,
    reconciledOrders,
    port,
    async close() {
      retention?.stop();
      bots?.stop();
      ws.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await wb.stop();
      await pool.end();
    },
  };
}

/**
 * The AI explainer, wired to Postgres. With no API key configured, the offline
 * rule-based engine (the demo default — real explanations at zero API cost);
 * with ANTHROPIC_API_KEY set, the LLM-backed one. Both read the SAME facts via
 * the shared data source below, which lives here (not in the AI module) so
 * queries stay in the query layer and the explainer stays DB-free and testable.
 */
function buildExplainer(config: Config, pool: pg.Pool, exchange: Exchange): Explainer {
  const dataSource: ExplainDataSource = async (orderId) => {
    const order = await getOrder(pool, orderId);
    if (!order) return null;
    const meta = exchange.meta(order.symbol);
    if (!meta) return null;
    const fills = await fillsForOrder(pool, orderId);
    return {
      order: {
        id: order.id,
        side: order.side as 'buy' | 'sell',
        type: order.type as 'limit' | 'market',
        price: order.price,
        qty: order.qty,
        filledQty: order.filledQty,
        filledNotional: order.filledNotional,
        status: order.status,
      },
      fills: fills.map((f) => ({ price: f.price, qty: f.qty, role: f.role as 'maker' | 'taker' })),
      instrument: { symbol: meta.symbol, name: meta.name, priceScale: meta.priceScale },
    };
  };

  if (!config.anthropicApiKey) return new RuleBasedExplainer({ dataSource });

  const client = new Anthropic({ apiKey: config.anthropicApiKey });
  return new AnthropicExplainer({
    client: { create: (p) => client.messages.create(p) },
    model: config.aiModel ?? DEFAULT_AI_MODEL,
    dataSource,
  });
}
