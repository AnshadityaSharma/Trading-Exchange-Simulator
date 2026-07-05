// engine-bench.ts — benchmark harness firing synthetic order flow directly
// at the MatchingEngine (no HTTP, no I/O). CLAUDE.md §5 targets: ≥50k
// orders/sec sustained, p99 match latency < 5ms.
// Why two separate passes: reading the clock costs real time. Timing every
// order inside a throughput run would slow the very thing being measured, so
// pass 1 measures throughput with ONE clock read per run, and pass 2 measures
// per-order latency and eats the (reported) clock overhead knowingly.
// Key tradeoff: the workload is synthetic and deterministic (seeded xorshift
// PRNG) — every run replays the identical order stream, so numbers are
// comparable across code changes. Run on compiled JS (npm run bench), never
// through a transpiler, so we measure the engine and not tooling.

import * as os from 'node:os';
import { MatchingEngine, type Side } from '../src/engine/index.js';

// ---------------------------------------------------------------- config

const WARMUP_OPS = 200_000; // let V8's JIT reach steady state before timing
const THROUGHPUT_RUNS = 5; // repeated runs expose degradation (GC, book growth)
const OPS_PER_RUN = 1_000_000;
const LATENCY_OPS = 1_000_000;
const MID = 50_000; // ticks
// Limit prices are uniform in [MID-BAND, MID+BAND], so BAND controls the
// number of distinct price levels — the "L" in the book's complexity math.
// Overridable so the sorted-price-array choice can be stress-tested with a
// deep book: `npm run bench -- 5000`.
const BAND = Number(process.argv[2] ?? 50);
const USERS = 50;
const MAX_QTY = 100;

// Workload mix, per 100 ops. Limit prices straddle the mid so roughly half
// cross immediately and half rest; cancels target random live orders so the
// book reaches a rough steady state instead of growing without bound.
const PCT_LIMIT = 70;
const PCT_MARKET = 10; // remainder (20%) = cancels

// ---------------------------------------------------------------- PRNG

// xorshift32: deterministic, integer-only, ~4 ops per draw. Cheap enough
// that generation cost doesn't pollute the measurement.
let seed = 0;
function reseed(s: number): void {
  seed = s | 0;
}
function rand(n: number): number {
  seed ^= seed << 13;
  seed ^= seed >>> 17;
  seed ^= seed << 5;
  seed |= 0;
  return (seed >>> 0) % n;
}

// ---------------------------------------------------------------- workload

type StepKind = 'submit' | 'cancel-hit' | 'cancel-miss';

/**
 * One synthetic operation against the engine. Rested order IDs are tracked
 * so cancels target plausible orders; a picked ID is swap-removed whether or
 * not the cancel succeeded. Many targets have been filled since they rested
 * (measured: ~4 in 5), so most cancels are "stale cancels" — a real path in
 * live flow, but a much cheaper one (hashmap miss) than removing a resting
 * order, so hit and miss are reported as SEPARATE distributions.
 * Measured behavior of this mix (see bench/results.md): ~2/3 of limit orders
 * rest, ~1/3 fill on arrival, and the true book grows steadily (~50k resting
 * orders per 1M ops) — resting inflow outpaces cancels + fills. Book growth
 * across runs is a feature: it shows per-op cost doesn't depend on depth.
 */
function step(engine: MatchingEngine, liveIds: number[]): StepKind {
  const kind = rand(100);
  if (kind < PCT_LIMIT + PCT_MARKET || liveIds.length === 0) {
    const side: Side = rand(2) === 0 ? 'buy' : 'sell';
    const userId = 1 + rand(USERS);
    const qty = 1 + rand(MAX_QTY);
    const res =
      kind < PCT_LIMIT
        ? engine.submit({ userId, side, type: 'limit', qty, price: MID - BAND + rand(2 * BAND + 1) })
        : engine.submit({ userId, side, type: 'market', qty });
    if (res.restingQty > 0) liveIds.push(res.orderId);
    return 'submit';
  }
  const idx = rand(liveIds.length);
  const id = liveIds[idx]!;
  liveIds[idx] = liveIds[liveIds.length - 1]!;
  liveIds.pop();
  return engine.cancel(id) ? 'cancel-hit' : 'cancel-miss';
}

function freshWarmedEngine(): { engine: MatchingEngine; liveIds: number[] } {
  reseed(0x9e3779b9);
  const engine = new MatchingEngine();
  const liveIds: number[] = [];
  for (let i = 0; i < WARMUP_OPS; i++) step(engine, liveIds);
  return { engine, liveIds };
}

// ---------------------------------------------------------------- passes

function throughputPass(): void {
  console.log(`\n== Throughput pass: ${THROUGHPUT_RUNS} runs x ${OPS_PER_RUN.toLocaleString()} ops (after ${WARMUP_OPS.toLocaleString()} warmup ops) ==`);
  const { engine, liveIds } = freshWarmedEngine();
  const rates: number[] = [];
  for (let run = 1; run <= THROUGHPUT_RUNS; run++) {
    let submits = 0;
    let cancelHits = 0;
    const t0 = process.hrtime.bigint();
    for (let i = 0; i < OPS_PER_RUN; i++) {
      const kind = step(engine, liveIds);
      if (kind === 'submit') submits++;
      else if (kind === 'cancel-hit') cancelHits++;
    }
    const elapsedNs = Number(process.hrtime.bigint() - t0);
    const opsPerSec = OPS_PER_RUN / (elapsedNs / 1e9);
    rates.push(opsPerSec);
    const cancels = OPS_PER_RUN - submits;
    console.log(
      `run ${run}: ${Math.round(opsPerSec).toLocaleString()} ops/sec ` +
        `(${submits.toLocaleString()} submits, ${cancels.toLocaleString()} cancels of which ${cancelHits.toLocaleString()} hit a resting order, ` +
        `${(elapsedNs / 1e6).toFixed(0)}ms, book=${engine.restingOrderCount().toLocaleString()} resting orders)`,
    );
  }
  const mean = rates.reduce((a, b) => a + b, 0) / rates.length;
  console.log(`sustained mean: ${Math.round(mean).toLocaleString()} ops/sec | min run: ${Math.round(Math.min(...rates)).toLocaleString()} ops/sec`);
}

function percentile(sorted: Float64Array, p: number): number {
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]!;
}

function fmtNs(ns: number): string {
  if (ns < 1_000) return `${ns.toFixed(0)}ns`;
  if (ns < 1_000_000) return `${(ns / 1_000).toFixed(2)}µs`;
  return `${(ns / 1_000_000).toFixed(3)}ms`;
}

function report(label: string, samples: Float64Array): void {
  samples.sort();
  console.log(
    `${label}: p50=${fmtNs(percentile(samples, 50))} p95=${fmtNs(percentile(samples, 95))} ` +
      `p99=${fmtNs(percentile(samples, 99))} p99.9=${fmtNs(percentile(samples, 99.9))} ` +
      `max=${fmtNs(samples[samples.length - 1]!)} (n=${samples.length.toLocaleString()})`,
  );
}

function latencyPass(): void {
  console.log(`\n== Latency pass: ${LATENCY_OPS.toLocaleString()} individually timed ops (after ${WARMUP_OPS.toLocaleString()} warmup ops) ==`);

  // The clock is neither free nor infinitely fine. Report both: overhead of
  // an empty hrtime pair, and the timer quantum (smallest nonzero tick) —
  // sub-microsecond percentiles below are quantized to that granularity.
  const probe = new Float64Array(10_000);
  for (let i = 0; i < probe.length; i++) {
    const t0 = process.hrtime.bigint();
    probe[i] = Number(process.hrtime.bigint() - t0);
  }
  probe.sort();
  let quantum = 0;
  for (const v of probe) if (v > 0) { quantum = v; break; }
  console.log(
    `clock: empty hrtime.bigint pair median ${fmtNs(probe[probe.length >> 1]!)} (included below, not subtracted); ` +
      `timer quantum ~${fmtNs(quantum)} — sub-µs figures are quantized to it`,
  );

  const { engine, liveIds } = freshWarmedEngine();
  const submitNs = new Float64Array(LATENCY_OPS);
  const cancelHitNs = new Float64Array(LATENCY_OPS);
  const cancelMissNs = new Float64Array(LATENCY_OPS);
  let nSubmit = 0;
  let nHit = 0;
  let nMiss = 0;
  for (let i = 0; i < LATENCY_OPS; i++) {
    const t0 = process.hrtime.bigint();
    const kind = step(engine, liveIds);
    const dt = Number(process.hrtime.bigint() - t0);
    if (kind === 'submit') submitNs[nSubmit++] = dt;
    else if (kind === 'cancel-hit') cancelHitNs[nHit++] = dt;
    else cancelMissNs[nMiss++] = dt;
  }
  report('submit (match) latency', submitNs.subarray(0, nSubmit));
  report('cancel hit  (removes a resting order)', cancelHitNs.subarray(0, nHit));
  report('cancel miss (stale id, hashmap miss) ', cancelMissNs.subarray(0, nMiss));
}

// ---------------------------------------------------------------- main

console.log('Trading Exchange Simulator — engine benchmark (direct calls, no HTTP)');
console.log(`hardware: ${os.cpus()[0]?.model ?? 'unknown CPU'} | ${os.cpus().length} logical cores | ${(os.totalmem() / 2 ** 30).toFixed(0)}GB RAM`);
console.log(`runtime:  node ${process.version} | ${os.type()} ${os.release()} (${process.arch})`);
console.log(`workload: ${PCT_LIMIT}% limit / ${PCT_MARKET}% market / ${100 - PCT_LIMIT - PCT_MARKET}% cancel, ` +
    `prices ±${BAND} ticks around ${MID}, qty 1–${MAX_QTY}, ${USERS} users, seeded PRNG (identical stream every run)`);

throughputPass();
latencyPass();
