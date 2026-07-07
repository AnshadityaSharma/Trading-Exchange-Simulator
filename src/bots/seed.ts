// seed.ts — creates the bot users' rows (users, balances, positions) in
// Postgres, idempotently, before boot loads accounts into memory.
// Why: account state is reloaded from the DB at every boot (decisions.md
// D16), and bot order rows must satisfy the orders→users foreign key.
// Seeding bots straight into the in-memory Accounts would work until the
// first restart, then vanish (Phase 3 review): ALL seed state must enter
// through the persisted path so memory and DB can never disagree.
// Key tradeoff: seeded once, never reset — bot wealth evolves across
// restarts like any user's, which keeps money conservation checkable.

import { randomBytes } from 'node:crypto';
import bcrypt from 'bcryptjs';
import type pg from 'pg';
import type { InstrumentMeta } from '../server/config.js';

export interface BotIds {
  makerUserId: number;
  noiseUserId: number;
}

// Bot accounts are unreachable through the API: the emails are never issued
// to anyone and the password is 32 random bytes hashed and thrown away.
export const MAKER_EMAIL = 'maker@bots.internal';
export const NOISE_EMAIL = 'noise@bots.internal';

/** ₹10 crore in paise — deep enough that quoting never runs out of cash. */
export const MAKER_CASH = 10_000_000_000;
export const MAKER_QTY_PER_INSTRUMENT = 10_000;
/** ₹1 crore in paise. */
export const NOISE_CASH = 1_000_000_000;
export const NOISE_QTY_PER_INSTRUMENT = 2_000;

/**
 * Ensure both bot users exist with their starting cash and inventory.
 * Existing bots are left untouched (their balances are live trading state).
 * One transaction: a crash mid-seed leaves either a complete bot or none.
 */
export async function seedBots(pool: pg.Pool, instruments: readonly InstrumentMeta[]): Promise<BotIds> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const makerUserId = await seedOne(client, MAKER_EMAIL, MAKER_CASH, MAKER_QTY_PER_INSTRUMENT, instruments);
    const noiseUserId = await seedOne(client, NOISE_EMAIL, NOISE_CASH, NOISE_QTY_PER_INSTRUMENT, instruments);
    await client.query('COMMIT');
    return { makerUserId, noiseUserId };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function seedOne(
  client: pg.PoolClient,
  email: string,
  cash: number,
  qtyPerInstrument: number,
  instruments: readonly InstrumentMeta[],
): Promise<number> {
  const existing = await client.query('SELECT id FROM users WHERE email = $1', [email]);
  if (existing.rowCount) return existing.rows[0].id;

  const hash = await bcrypt.hash(randomBytes(32).toString('hex'), 10);
  const res = await client.query(
    'INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id',
    [email, hash],
  );
  const id: number = res.rows[0].id;
  await client.query('INSERT INTO balances (user_id, cash, reserved_cash) VALUES ($1, $2, 0)', [id, cash]);
  for (const meta of instruments) {
    // Seeded inventory carries an honest cost basis: qty × reference price,
    // as if bought at the price the market maker will open the book around.
    await client.query(
      `INSERT INTO positions (user_id, symbol, qty, reserved_qty, cost_basis, realized_pnl)
       VALUES ($1, $2, $3, 0, $4, 0)`,
      [id, meta.symbol, qtyPerInstrument, qtyPerInstrument * meta.referencePrice],
    );
  }
  return id;
}
