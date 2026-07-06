// db.ts — the Postgres connection and migration runner.
// Why: a thin layer over `pg` — a Pool plus raw SQL (CLAUDE.md §4: no ORM;
// every query must be explainable). The one global concern handled here is
// int8 parsing: pg returns BIGINT as strings by default; all our BIGINTs are
// paise/quantities far below 2^53, so parsing to number is exact and keeps
// the rest of the codebase float-free integer math (decisions.md D1).

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';

// int8 (OID 20) → number. Safe: largest value we store is paise for virtual
// portfolios, orders of magnitude under Number.MAX_SAFE_INTEGER.
pg.types.setTypeParser(20, (v) => Number(v));

export function createPool(databaseUrl: string): pg.Pool {
  return new pg.Pool({ connectionString: databaseUrl, max: 10 });
}

/** Apply schema.sql (idempotent — every statement is IF NOT EXISTS). */
export async function migrate(pool: pg.Pool): Promise<void> {
  // Resolved from the project root (where the process always starts), so the
  // same path works compiled (dist/) and under the test runner (src/).
  const schemaPath = join(process.cwd(), 'src', 'db', 'schema.sql');
  await pool.query(readFileSync(schemaPath, 'utf8'));
}
