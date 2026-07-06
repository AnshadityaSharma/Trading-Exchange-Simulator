// http-bench.ts — full-HTTP-path benchmark: real POST /api/orders requests
// against a locally booted backend (express + auth + accounting + engine +
// write-behind), measured from the client side.
// Why separate from engine-bench: CLAUDE.md §5 — engine numbers and HTTP
// numbers are different claims. This one includes JSON parsing, JWT
// verification, validation, reservations, event fan-out, and persistence
// queueing; it is expected to be orders of magnitude slower than the raw
// engine and is reported as-is.
// Method notes: latency here is client-observed round-trip over localhost
// keep-alive connections; concurrency comes from N parallel async loops.
// Uses its own database (exchange_bench), wiped per run.

import * as os from 'node:os';
import pg from 'pg';
import { boot } from '../src/server/boot.js';

const ADMIN_URL = process.env.BENCH_ADMIN_DATABASE_URL ?? 'postgres://postgres:exsim@localhost:5433/postgres';
const DB_URL = process.env.BENCH_DATABASE_URL ?? 'postgres://postgres:exsim@localhost:5433/exchange_bench';

const USERS = 20; // = concurrent client loops
const TOTAL_REQUESTS = 30_000;
const WARMUP_REQUESTS = 2_000;
const MID = 245_000;
const BAND_TICKS = 20; // ±20 ticks of 5 around mid
const SEED_QTY = 1_000_000; // shares per user so sells never run dry

let seed = 0xc0ffee | 0;
function rand(n: number): number {
  seed ^= seed << 13;
  seed ^= seed >>> 17;
  seed ^= seed << 5;
  seed |= 0;
  return (seed >>> 0) % n;
}

async function main(): Promise<void> {
  // Fresh bench database.
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  const exists = await admin.query("SELECT 1 FROM pg_database WHERE datname = 'exchange_bench'");
  if (exists.rowCount === 0) await admin.query('CREATE DATABASE exchange_bench');
  await admin.end();
  const wipe = new pg.Client({ connectionString: DB_URL });
  await wipe.connect();
  await wipe.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await wipe.end();

  const backend = await boot({ port: 0, databaseUrl: DB_URL, jwtSecret: 'bench-secret' });
  const base = `http://localhost:${backend.port}`;

  console.log('Trading Exchange Simulator — full HTTP path benchmark (POST /api/orders over localhost)');
  console.log(`hardware: ${os.cpus()[0]?.model ?? 'unknown CPU'} | ${os.cpus().length} logical cores | ${(os.totalmem() / 2 ** 30).toFixed(0)}GB RAM`);
  console.log(`runtime:  node ${process.version} | ${os.type()} ${os.release()} (${process.arch})`);
  console.log(`workload: ${USERS} concurrent clients, ${TOTAL_REQUESTS.toLocaleString()} order submissions (limit orders ±${BAND_TICKS * 5} around ${MID}, random side/qty), after ${WARMUP_REQUESTS.toLocaleString()} warmup requests`);

  // Sign up bench users over the API; seed sell inventory directly (positions
  // normally enter via bots — the bench measures order flow, not onboarding).
  const tokens: string[] = [];
  for (let i = 0; i < USERS; i++) {
    const res = await fetch(`${base}/api/auth/signup`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: `bench${i}@bench.dev`, password: 'benchpass123' }),
    });
    const json = (await res.json()) as { token: string; user: { id: number } };
    tokens.push(json.token);
    backend.exchange.accounts.putPosition(json.user.id, 'ACME', {
      qty: SEED_QTY, reservedQty: 0, costBasis: SEED_QTY * MID, realizedPnl: 0,
    });
  }

  const latencies = new Float64Array(TOTAL_REQUESTS);
  let statuses = { s201: 0, s400: 0, other: 0 };
  let issued = 0;
  let recorded = 0;

  async function worker(token: string, requests: number, record: boolean): Promise<void> {
    for (let i = 0; i < requests; i++) {
      const side = rand(2) === 0 ? 'buy' : 'sell';
      const body = JSON.stringify({
        instrument: 'ACME',
        side,
        type: 'limit',
        qty: 1 + rand(20),
        price: MID + (rand(2 * BAND_TICKS + 1) - BAND_TICKS) * 5,
      });
      const t0 = process.hrtime.bigint();
      const res = await fetch(`${base}/api/orders`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body,
      });
      await res.arrayBuffer(); // fully consume
      const dt = Number(process.hrtime.bigint() - t0);
      if (record && recorded < latencies.length) latencies[recorded++] = dt;
      if (res.status === 201) statuses.s201++;
      else if (res.status === 400) statuses.s400++;
      else statuses.other++;
    }
  }

  // Warmup (not recorded).
  await Promise.all(tokens.map((t) => worker(t, Math.ceil(WARMUP_REQUESTS / USERS), false)));
  statuses = { s201: 0, s400: 0, other: 0 };

  const perWorker = Math.ceil(TOTAL_REQUESTS / USERS);
  issued = perWorker * USERS;
  const t0 = process.hrtime.bigint();
  await Promise.all(tokens.map((t) => worker(t, perWorker, true)));
  const elapsedNs = Number(process.hrtime.bigint() - t0);

  const sorted = latencies.subarray(0, recorded);
  sorted.sort();
  const pct = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]! / 1e6;
  console.log(`\nthroughput: ${Math.round(issued / (elapsedNs / 1e9)).toLocaleString()} orders/sec sustained over ${(elapsedNs / 1e9).toFixed(1)}s`);
  console.log(`responses: ${statuses.s201} accepted (201), ${statuses.s400} business rejections (400), ${statuses.other} other`);
  console.log(
    `latency (client-observed round trip): p50=${pct(50).toFixed(2)}ms p95=${pct(95).toFixed(2)}ms ` +
      `p99=${pct(99).toFixed(2)}ms max=${(sorted[sorted.length - 1]! / 1e6).toFixed(2)}ms (n=${recorded.toLocaleString()})`,
  );

  await backend.close();
}

await main();
