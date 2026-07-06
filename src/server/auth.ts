// auth.ts — email+password signup/login and JWT verification.
// Why: simplest auth that works (CLAUDE.md §2 — no 2FA/KYC/reset flows).
// Stateless JWT means no session table and no session lookup per request;
// the tradeoff (tokens can't be revoked before expiry) is acceptable for a
// paper-trading demo and stated here on purpose.

import bcrypt from 'bcryptjs';
import type { NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import type pg from 'pg';
import { STARTING_CASH } from './config.js';
import { ApiError } from './errors.js';

const TOKEN_TTL = '7d';
const BCRYPT_ROUNDS = 10;

export interface AuthedRequest extends Request {
  userId?: number;
}

export interface PublicUser {
  id: number;
  email: string;
  createdAt: string;
}

export function signToken(userId: number, secret: string): string {
  return jwt.sign({ sub: String(userId) }, secret, { expiresIn: TOKEN_TTL });
}

export function verifyToken(token: string, secret: string): number | null {
  try {
    const payload = jwt.verify(token, secret);
    if (typeof payload === 'object' && typeof payload.sub === 'string') {
      return Number(payload.sub);
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Signup writes synchronously (not write-behind): the caller must know
 * EMAIL_TAKEN immediately, and signup is nowhere near the hot path.
 * Returns the new user; the caller registers the in-memory account.
 */
export async function signup(pool: pg.Pool, email: string, password: string): Promise<PublicUser> {
  const hash = await bcrypt.hash(password, BCRYPT_ROUNDS);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const res = await client.query(
      `INSERT INTO users (email, password_hash) VALUES ($1, $2)
       ON CONFLICT (email) DO NOTHING
       RETURNING id, email, created_at`,
      [email, hash],
    );
    if (res.rowCount === 0) {
      await client.query('ROLLBACK');
      throw new ApiError(409, 'EMAIL_TAKEN', 'an account with this email already exists');
    }
    const row = res.rows[0];
    await client.query('INSERT INTO balances (user_id, cash, reserved_cash) VALUES ($1, $2, 0)', [
      row.id,
      STARTING_CASH,
    ]);
    await client.query('COMMIT');
    return { id: row.id, email: row.email, createdAt: row.created_at.toISOString() };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

export async function login(pool: pg.Pool, email: string, password: string): Promise<PublicUser> {
  const res = await pool.query(
    'SELECT id, email, password_hash, created_at FROM users WHERE email = $1',
    [email],
  );
  const row = res.rows[0];
  const ok = row && (await bcrypt.compare(password, row.password_hash));
  if (!ok) throw new ApiError(401, 'INVALID_CREDENTIALS', 'invalid email or password');
  return { id: row.id, email: row.email, createdAt: row.created_at.toISOString() };
}

/** Express middleware: requires a valid Bearer token, sets req.userId. */
export function requireAuth(secret: string) {
  return (req: AuthedRequest, _res: Response, next: NextFunction): void => {
    const header = req.headers.authorization;
    const token = header?.startsWith('Bearer ') ? header.slice(7) : null;
    const userId = token ? verifyToken(token, secret) : null;
    if (userId === null) {
      next(new ApiError(401, 'UNAUTHORIZED', 'missing or invalid bearer token'));
      return;
    }
    req.userId = userId;
    next();
  };
}
