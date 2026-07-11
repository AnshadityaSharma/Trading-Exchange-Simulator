// retention.test.ts — the deletion semantics of pruneBotHistory against a
// real Postgres (docker run … postgres:17 on :5433; own database
// exchange_retention_test). The invariants under test are the ones that must
// never break: human rows survive everything, each symbol's last trade
// survives (lastPrice replay), and accounting tables are untouched.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { migrate } from './db.js';
import { pruneBotHistory } from './retention.js';

const ADMIN_URL = process.env.TEST_ADMIN_DATABASE_URL ?? 'postgres://postgres:exsim@localhost:5433/postgres';
const TEST_DB_URL = process.env.TEST_RETENTION_DATABASE_URL ?? 'postgres://postgres:exsim@localhost:5433/exchange_retention_test';

const BOT_A = 1; // maker
const BOT_B = 2; // noise
const HUMAN = 3;
const BOTS = [BOT_A, BOT_B];

const DAYS = 2;
const OLD = new Date(Date.now() - 5 * 24 * 3600 * 1000); // well past the window
const RECENT = new Date(Date.now() - 3600 * 1000); // 1h ago, inside the window

let pool: pg.Pool;

beforeAll(async () => {
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  const exists = await admin.query("SELECT 1 FROM pg_database WHERE datname = 'exchange_retention_test'");
  if (exists.rowCount === 0) await admin.query('CREATE DATABASE exchange_retention_test');
  await admin.end();

  pool = new pg.Pool({ connectionString: TEST_DB_URL });
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await migrate(pool);

  for (const [id, email] of [
    [BOT_A, 'maker@bots.internal'],
    [BOT_B, 'noise@bots.internal'],
    [HUMAN, 'human@example.com'],
  ] as const) {
    await pool.query("INSERT INTO users (id, email, password_hash) VALUES ($1, $2, 'x')", [id, email]);
    await pool.query('INSERT INTO balances (user_id, cash, reserved_cash) VALUES ($1, 1000000, 0)', [id]);
  }
}, 30_000);

afterAll(async () => {
  await pool.end();
});

// ------------------------------------------------------------------ helpers

let nextId = 0;
const id = (prefix: string) => `${prefix}_${++nextId}`;

async function insertOrder(userId: number, status: string, at: Date, symbol = 'ACME'): Promise<string> {
  const oid = id('ord');
  await pool.query(
    `INSERT INTO orders (id, user_id, symbol, side, type, price, qty, filled_qty, filled_notional, status, created_at, updated_at)
     VALUES ($1, $2, $3, 'buy', 'limit', 100, 10, 0, 0, $4, $5, $5)`,
    [oid, userId, symbol, status, at],
  );
  return oid;
}

/** One trade with its two fill rows (maker + taker sides). */
async function insertTrade(
  seq: number,
  makerUserId: number,
  takerUserId: number,
  at: Date,
  symbol = 'ACME',
): Promise<{ makerOrder: string; takerOrder: string }> {
  const makerOrder = await insertOrder(makerUserId, 'filled', at, symbol);
  const takerOrder = await insertOrder(takerUserId, 'filled', at, symbol);
  await pool.query(
    `INSERT INTO trades (symbol, seq, price, qty, taker_side, ts) VALUES ($1, $2, 100, 10, 'buy', $3)`,
    [symbol, seq, at],
  );
  for (const [orderId, userId, role] of [
    [makerOrder, makerUserId, 'maker'],
    [takerOrder, takerUserId, 'taker'],
  ] as const) {
    await pool.query(
      `INSERT INTO fills (id, order_id, user_id, symbol, side, role, price, qty, trade_seq, ts)
       VALUES ($1, $2, $3, $4, 'buy', $5, 100, 10, $6, $7)`,
      [id('fill'), orderId, userId, symbol, role, seq, at],
    );
  }
  return { makerOrder, takerOrder };
}

const count = async (sql: string, params: unknown[] = []): Promise<number> =>
  Number((await pool.query(sql, params)).rows[0].count);

// -------------------------------------------------------------------- tests

describe('pruneBotHistory', () => {
  it('enforces the retention contract in one pass over a mixed history', async () => {
    // ACME, seqs oldest→newest. The LAST trade of each symbol must survive.
    const oldBotBot = await insertTrade(1, BOT_A, BOT_B, OLD); // prunable
    const oldHuman = await insertTrade(2, BOT_A, HUMAN, OLD); // human side: keep everything
    const recentBotBot = await insertTrade(3, BOT_A, BOT_B, RECENT); // inside window: keep

    // GLXY: its ONLY (and therefore last) trade is old bot-vs-bot — keep it,
    // boot restores lastPrice from it.
    await insertTrade(10, BOT_A, BOT_B, OLD, 'GLXY');

    // Unfilled terminal bot quotes — the actual bulk in production.
    const oldBotQuote = await insertOrder(BOT_A, 'canceled', OLD);
    const recentBotQuote = await insertOrder(BOT_A, 'canceled', RECENT);
    const oldOpenBot = await insertOrder(BOT_A, 'open', OLD); // never touch non-terminal
    const oldHumanOrder = await insertOrder(HUMAN, 'canceled', OLD); // never touch humans

    const counts = await pruneBotHistory(pool, BOTS, DAYS);

    // Deleted: the old bot-vs-bot ACME trade (2 fills, 2 orders) and the old
    // unfilled bot quote. Nothing else.
    expect(counts).toEqual({ fills: 2, trades: 1, orders: 3 });

    // The pruned trade and its rows are gone.
    expect(await count(`SELECT count(*) FROM trades WHERE symbol = 'ACME' AND seq = 1`)).toBe(0);
    expect(await count('SELECT count(*) FROM orders WHERE id = $1', [oldBotBot.makerOrder])).toBe(0);
    expect(await count('SELECT count(*) FROM orders WHERE id = $1', [oldBotQuote])).toBe(0);

    // Human-involved trade survives WHOLE: trade, both fills, both orders —
    // including the bot side.
    expect(await count(`SELECT count(*) FROM trades WHERE symbol = 'ACME' AND seq = 2`)).toBe(1);
    expect(await count('SELECT count(*) FROM fills WHERE trade_seq = 2')).toBe(2);
    expect(await count('SELECT count(*) FROM orders WHERE id = $1', [oldHuman.makerOrder])).toBe(1);
    expect(await count('SELECT count(*) FROM orders WHERE id = $1', [oldHuman.takerOrder])).toBe(1);

    // Recent bot-vs-bot trade survives (inside the window).
    expect(await count(`SELECT count(*) FROM trades WHERE symbol = 'ACME' AND seq = 3`)).toBe(1);
    expect(await count('SELECT count(*) FROM orders WHERE id = $1', [recentBotBot.makerOrder])).toBe(1);

    // GLXY's last trade survives despite being old bot-vs-bot.
    expect(await count(`SELECT count(*) FROM trades WHERE symbol = 'GLXY'`)).toBe(1);
    expect(await count(`SELECT count(*) FROM fills WHERE symbol = 'GLXY'`)).toBe(2);

    // Open bot order, recent bot quote, and human order all survive.
    for (const oid of [oldOpenBot, recentBotQuote, oldHumanOrder]) {
      expect(await count('SELECT count(*) FROM orders WHERE id = $1', [oid])).toBe(1);
    }

    // Accounting state untouched: prune history, never the ledger.
    expect(await count('SELECT count(*) FROM balances')).toBe(3);
    expect(await count(`SELECT count(*) FROM balances WHERE cash = 1000000 AND reserved_cash = 0`)).toBe(3);
  });

  it('is idempotent: a second pass deletes nothing', async () => {
    expect(await pruneBotHistory(pool, BOTS, DAYS)).toEqual({ fills: 0, trades: 0, orders: 0 });
  });
});
