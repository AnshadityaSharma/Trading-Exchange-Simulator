// bots.test.ts — unit tests for the pure quoting math, plus integration
// tests driving the bots tick-by-tick against a booted backend (no timers:
// every action is explicit, so every assertion is deterministic).
// The restart test is the regression for the Phase 3 review finding: bot
// state must seed through the persisted path, or it dies with the process.
// Requires the dev Postgres container (:5433); uses its own database
// `exchange_bots_test` because vitest runs test files in parallel.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { createPool, migrate } from '../db/db.js';
import { boot, type Backend } from '../server/boot.js';
import { INSTRUMENTS, type Config } from '../server/config.js';
import {
  Bots,
  DEFAULT_BOT_CONFIG,
  desiredQuotes,
  MarketMaker,
  NoiseTrader,
  roundToTick,
} from './bots.js';
import {
  MAKER_CASH,
  MAKER_QTY_PER_INSTRUMENT,
  NOISE_CASH,
  NOISE_QTY_PER_INSTRUMENT,
  seedBots,
  type BotIds,
} from './seed.js';

const ADMIN_URL = process.env.TEST_ADMIN_DATABASE_URL ?? 'postgres://postgres:exsim@localhost:5433/postgres';
const TEST_DB_URL = process.env.TEST_BOTS_DATABASE_URL ?? 'postgres://postgres:exsim@localhost:5433/exchange_bots_test';

// bots: false — the suite drives ticks by hand for determinism; seeding is
// done explicitly below so the boot-loads-bot-accounts path is still tested.
const config: Config = { port: 0, databaseUrl: TEST_DB_URL, jwtSecret: 'test-secret', bots: false };

const ACME = INSTRUMENTS.find((i) => i.symbol === 'ACME')!;
const REF = ACME.referencePrice; // 245000, tick 5

let backend: Backend;
let ids: BotIds;

beforeAll(async () => {
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  const exists = await admin.query("SELECT 1 FROM pg_database WHERE datname = 'exchange_bots_test'");
  if (exists.rowCount === 0) await admin.query('CREATE DATABASE exchange_bots_test');
  await admin.end();

  const wipe = new pg.Client({ connectionString: TEST_DB_URL });
  await wipe.connect();
  await wipe.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await wipe.end();

  // Seed through the persisted path BEFORE boot, exactly as boot does it.
  const pool = createPool(TEST_DB_URL);
  await migrate(pool);
  ids = await seedBots(pool, INSTRUMENTS);
  const again = await seedBots(pool, INSTRUMENTS); // idempotent: same ids, no reset
  expect(again).toEqual(ids);
  await pool.end();

  backend = await boot(config);
}, 30_000);

afterAll(async () => {
  await backend.close();
});

/** rng stub: returns queued values in order, then 0.5 forever. */
const rngSeq = (...values: number[]) => () => values.shift() ?? 0.5;

// ------------------------------------------------------------- pure quoting

describe('quoting math', () => {
  it('rounds to the nearest tick, floored at one tick', () => {
    expect(roundToTick(247, 5)).toBe(245);
    expect(roundToTick(248, 5)).toBe(250);
    expect(roundToTick(2, 5)).toBe(5);
  });

  it('lays out symmetric levels around mid', () => {
    const quotes = desiredQuotes(1000, 5, DEFAULT_BOT_CONFIG); // half-spread 2t, gap 2t, 3 levels
    expect(quotes.filter((q) => q.side === 'buy').map((q) => q.price)).toEqual([990, 980, 970]);
    expect(quotes.filter((q) => q.side === 'sell').map((q) => q.price)).toEqual([1010, 1020, 1030]);
  });

  it('drops bids that would be at or below zero, keeps asks', () => {
    const quotes = desiredQuotes(15, 5, DEFAULT_BOT_CONFIG);
    expect(quotes.filter((q) => q.side === 'buy').map((q) => q.price)).toEqual([5]);
    expect(quotes.filter((q) => q.side === 'sell')).toHaveLength(3);
  });
});

// -------------------------------------------------------------- integration

describe('bot seeding (persisted path)', () => {
  it('boot loads the seeded bot accounts into memory like any user', () => {
    const maker = backend.exchange.accounts.get(ids.makerUserId);
    expect(maker.cash).toBe(MAKER_CASH);
    const noise = backend.exchange.accounts.get(ids.noiseUserId);
    expect(noise.cash).toBe(NOISE_CASH);
    for (const meta of INSTRUMENTS) {
      expect(backend.exchange.accounts.position(ids.makerUserId, meta.symbol).qty).toBe(MAKER_QTY_PER_INSTRUMENT);
      expect(backend.exchange.accounts.position(ids.noiseUserId, meta.symbol).qty).toBe(NOISE_QTY_PER_INSTRUMENT);
    }
  });
});

describe('market maker', () => {
  it('quotes both sides around the reference price on a fresh book', () => {
    const mm = new MarketMaker(backend.exchange, ids.makerUserId, DEFAULT_BOT_CONFIG);
    mm.tick(ACME);
    const book = backend.exchange.bookSnapshot('ACME', 50);
    expect(book.bids).toEqual([[REF - 10, 10], [REF - 20, 10], [REF - 30, 10]]);
    expect(book.asks).toEqual([[REF + 10, 10], [REF + 20, 10], [REF + 30, 10]]);
    // Buy quotes reserved cash; sell quotes reserved inventory.
    expect(backend.exchange.accounts.get(ids.makerUserId).reservedCash).toBe(
      10 * ((REF - 10) + (REF - 20) + (REF - 30)),
    );
    expect(backend.exchange.accounts.position(ids.makerUserId, 'ACME').reservedQty).toBe(30);
  });

  it('leaves quotes that are still desired untouched (no churn)', () => {
    const mm = new MarketMaker(backend.exchange, ids.makerUserId, DEFAULT_BOT_CONFIG);
    const before = backend.exchange.openOrdersFor(ids.makerUserId, 'ACME').map((o) => o.id).sort();
    const seqBefore = backend.exchange.bookSnapshot('ACME', 50).seq;
    mm.tick(ACME);
    const after = backend.exchange.openOrdersFor(ids.makerUserId, 'ACME').map((o) => o.id).sort();
    expect(after).toEqual(before); // same six orders, not six replacements
    expect(backend.exchange.bookSnapshot('ACME', 50).seq).toBe(seqBefore); // no delta broadcast
  });
});

describe('noise trader', () => {
  it('trades against maker quotes and the maker recenters on the new price', () => {
    // rng: qty draw 0 → 1 lot; side draw 0.9 ≥ 0.65 → against inventory bias
    // (position is at target → toward = sell, so this order is a BUY).
    const noise = new NoiseTrader(backend.exchange, ids.noiseUserId, DEFAULT_BOT_CONFIG, NOISE_QTY_PER_INSTRUMENT, rngSeq(0, 0.9));
    noise.tick(ACME);

    expect(backend.exchange.stats('ACME').lastPrice).toBe(REF + 10); // lifted best ask
    expect(backend.exchange.accounts.position(ids.noiseUserId, 'ACME').qty).toBe(NOISE_QTY_PER_INSTRUMENT + 1);

    // Maker recenters around the new last price; overlapping levels survive.
    const mm = new MarketMaker(backend.exchange, ids.makerUserId, DEFAULT_BOT_CONFIG);
    const keptAsk = backend.exchange
      .openOrdersFor(ids.makerUserId, 'ACME')
      .find((o) => o.side === 'sell' && o.price === REF + 20)!.id;
    mm.tick(ACME);
    const book = backend.exchange.bookSnapshot('ACME', 50);
    expect(book.bids[0]).toEqual([REF, 10]);
    expect(book.asks[0]).toEqual([REF + 20, 10]);
    const nowOpen = backend.exchange.openOrdersFor(ids.makerUserId, 'ACME');
    expect(nowOpen.find((o) => o.id === keptAsk)).toBeDefined(); // kept, not churned
    expect(nowOpen).toHaveLength(6);
  });
});

describe('bots driver', () => {
  it('start() quotes every instrument immediately; stop() halts the timers', () => {
    const bots = new Bots(backend.exchange, ids);
    bots.start();
    for (const meta of INSTRUMENTS) {
      const book = backend.exchange.bookSnapshot(meta.symbol, 1);
      expect(book.bids.length).toBeGreaterThan(0);
      expect(book.asks.length).toBeGreaterThan(0);
    }
    bots.stop();
  });
});

describe('restart (Phase 3 review finding: seeding must persist)', () => {
  it('bot state survives a restart; reservations release; money is conserved', async () => {
    const totalCash = () =>
      backend.exchange.accounts.get(ids.makerUserId).cash +
      backend.exchange.accounts.get(ids.makerUserId).reservedCash +
      backend.exchange.accounts.get(ids.noiseUserId).cash +
      backend.exchange.accounts.get(ids.noiseUserId).reservedCash;
    const totalAcmeQty = () =>
      backend.exchange.accounts.position(ids.makerUserId, 'ACME').qty +
      backend.exchange.accounts.position(ids.noiseUserId, 'ACME').qty;

    expect(totalCash()).toBe(MAKER_CASH + NOISE_CASH); // trades only move cash between bots
    const lastPrice = backend.exchange.stats('ACME').lastPrice;

    await backend.close(); // flushes write-behind
    backend = await boot(config); // fresh process, same DB; seeding already done

    // Orphaned maker quotes were reconciled away and their reservations released.
    expect(backend.reconciledOrders).toBeGreaterThan(0);
    expect(backend.exchange.accounts.get(ids.makerUserId).reservedCash).toBe(0);
    expect(backend.exchange.accounts.position(ids.makerUserId, 'ACME').reservedQty).toBe(0);

    // Balances and inventory reloaded from Postgres, nothing lost or invented.
    expect(totalCash()).toBe(MAKER_CASH + NOISE_CASH);
    expect(totalAcmeQty()).toBe(MAKER_QTY_PER_INSTRUMENT + NOISE_QTY_PER_INSTRUMENT);

    // The last trade price survived too: a fresh maker recenters on it,
    // not on the reference price.
    expect(backend.exchange.stats('ACME').lastPrice).toBe(lastPrice);
    const mm = new MarketMaker(backend.exchange, ids.makerUserId, DEFAULT_BOT_CONFIG);
    mm.tick(ACME);
    expect(backend.exchange.bookSnapshot('ACME', 1).asks[0]![0]).toBe(lastPrice! + 10);
  }, 30_000);

  it('re-seeding after the restart still returns the same bots untouched', async () => {
    const pool = createPool(TEST_DB_URL);
    const again = await seedBots(pool, INSTRUMENTS);
    await pool.end();
    expect(again).toEqual(ids);
    expect(backend.exchange.accounts.get(ids.makerUserId).cash).not.toBe(0);
  });
});
