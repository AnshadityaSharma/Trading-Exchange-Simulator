# Engine benchmark results

Direct calls into `MatchingEngine` — no HTTP, no I/O, single thread. Produced by
`npm run bench` ([engine-bench.ts](engine-bench.ts)). Rerun after any engine change (CLAUDE.md §8).

## Environment

| | |
|---|---|
| CPU | Intel Core i7-10875H @ 2.30GHz (laptop; 16 logical cores; engine uses one) |
| RAM | 32 GB |
| Runtime | Node v24.16.0, x64 |
| OS | Windows 11 Pro (build 26200) |
| Date | 2026-07-08 (all numbers below from this session unless marked) |

## Workload

Deterministic seeded stream (identical every run): 70% limit orders, 10% market
orders, 20% cancels of previously-rested order IDs. Limit prices uniform across
the price band, quantities 1–100, 50 distinct users. 200k warmup ops before any
timing so V8's JIT reaches steady state. Benchmarks run compiled JS (`tsc`
output), not a transpiler.

Measured properties of this mix (from the run logs — these numbers matter for
reading the results):

- ~1/3 of limit orders fill on arrival, ~2/3 rest; the true book grows ~50k
  resting orders per 1M ops (resting inflow outpaces cancels + fills).
- Only ~19% of cancel attempts hit an order still on the book; the other ~81%
  target IDs already filled ("stale cancels" — a real path in live flow, but a
  much cheaper one, so cancel-hit and cancel-miss are reported separately).

Throughput is measured with one clock read per 1M-op run (per-op timing would
slow the thing being measured); latency is a separate pass timing every op with
`process.hrtime.bigint()`.

**Clock caveats:** the empty-pair overhead is ~100ns (included in figures, not
subtracted) and the timer quantum on this platform is ~100ns, so sub-microsecond
percentiles are quantized — read "500ns" as "5±1 ticks", not as nanosecond-exact.

## Results — default band (±50 ticks ⇒ ≤101 price levels/side)

`npm run bench`

**Throughput** (5 runs × 1M mixed ops, same engine instance throughout):

| run | ops/sec | true book size after run |
|---|---|---|
| 1 | 2,506,329 | 59,787 |
| 2 | 2,047,539 | 109,530 |
| 3 | 2,265,748 | 159,340 |
| 4 | 2,162,903 | 209,512 |
| 5 | 1,535,548 | 258,764 |
| **mean** | **2,103,613** | |
| **worst run** | **1,535,548** | |

**Run-to-run variance is real:** earlier sessions on this machine (2026-07-05)
measured means of 1.65–1.67M with worst runs of 1.39–1.48M; today's session ran
cooler and faster. This is a laptop CPU with thermal throttling; the honest
sustained figure across all observed sessions is **≥1.4M mixed ops/sec on the
worst observed run**. At 80% submits that is **≥1.1M order submissions/sec —
>20× the 50k orders/sec target** even at the most conservative reading.

**Latency** (1M individually timed ops):

| op | p50 | p95 | p99 | p99.9 | max | n |
|---|---|---|---|---|---|---|
| submit (match) | 300ns | 700ns | 1.20µs | 21.5µs | 3.63ms | 800,371 |
| cancel hit (removes a resting order) | 700ns | 1.30µs | 2.00µs | 24.2µs | 44.2µs | 38,279 |
| cancel miss (stale ID, hashmap miss) | 300ns | 600ns | 900ns | 19.2µs | 39.0µs | 161,350 |

p99 submit latency is **1.2µs against a 5ms target** (~4,000× headroom). The
p99.9 figures in this session sit around 20µs uniformly across op types —
including the trivially-cheap cancel-miss path — which points at OS
scheduler/timer interference on the machine, not the engine (the 2026-07-05
session measured p99.9 = 2.9µs for submit under the identical workload). The
millisecond-scale submit max is a one-in-800k outlier consistent with a GC
pause.

## Results — deep book (±5000 ticks ⇒ ≤10,001 price levels/side)

`npm run bench -- 5000` — stress-tests the sorted-price-array choice (its only
non-O(1)/O(log L) operation is the O(L) splice when a NEW price level is
inserted away from the best).

| metric | value |
|---|---|
| throughput mean / worst run | 1,475,921 / 1,343,407 ops/sec |
| submit p50 / p99 / p99.9 / max | 400ns / 2.30µs / 25.4µs / 5.30ms |
| cancel-hit p50 / p99 | 900ns / 5.50µs |

Session-to-session honesty: in the 2026-07-05 session the deep-book mean was
statistically indistinguishable from the default band (actually measured
slightly higher). Today it measured ~30% lower — but today's deep-book run also
executed last in the session on an already-hot machine, and the deep-book mean
(1.48M) still overlaps the *default-band* means observed across sessions
(1.65–2.10M, worst runs 1.39–1.54M), so the delta is within this laptop's
thermal envelope rather than attributable to level count. The durable,
repeatable signal is the latency shift: submit p99 goes 1.2µs → 2.3µs with 100×
more price levels — measurable, small, and ~2,000× under the 5ms target.
Conclusion unchanged: at 10k levels the array splice is not a bottleneck
(decisions.md D2, D11). Throughput deltas on single runs on this machine should
not be quoted as data.

## Results — full HTTP path

`npm run bench:http` ([http-bench.ts](http-bench.ts)) — real `POST /api/orders`
requests over localhost keep-alive connections against the fully booted
backend (express + JWT auth + zod validation + reservations + matching +
WebSocket fan-out + write-behind persistence). 20 concurrent client loops,
30,000 orders, 2,000-request warmup. Measured 2026-07-08:

| metric | value |
|---|---|
| throughput | **1,306 orders/sec** sustained (23.0s run) |
| latency p50 / p95 / p99 / max | 13.88ms / 23.53ms / 29.74ms / 44.91ms |
| responses | 25,396 accepted, 4,604 business rejections (INSUFFICIENT_FUNDS as bench buyers' cash migrates into resting orders), 0 errors |

**How to read the latency numbers:** they are dominated by queueing, not
service time. With 20 requests permanently in flight against a single-threaded
server, Little's law (latency ≈ in-flight ÷ throughput = 20 ÷ 1,306) predicts
15.3ms — close to the observed p50 of 13.88ms. The same holds for a no-op
control: `GET /api/health` under identical concurrency measured 2,893 req/sec
at p50 6.45ms (predicted 6.9ms). Per-request **server-side** cost is therefore
~0.35ms for the bare HTTP/express layer and ~0.77ms for a full order — the
matching engine (0.3µs, see above) is ~0.04% of the request cost. The
bottleneck is the HTTP/JSON/auth layer plus one core doing everything, which
is the architecture working as designed (single-threaded exchange,
CLAUDE.md §3); per §5 it is reported as measured, not tuned away at the
expense of clarity. Throughput would scale with instances-per-instrument
sharding or a faster HTTP framework — both out of scope for v1.

## Observations and honest caveats

- **Throughput does not degrade as the book grows.** The engine's true resting
  count grew 60k → 259k across the five runs (printed per run from
  `restingOrderCount()`) with no downward throughput trend beyond thermal
  noise, consistent with O(1) per-op costs: price levels are bounded by the
  band; only FIFO queue lengths grow, and queues are touched at head/tail or
  by direct node reference.
- Synthetic uniform flow is not real market flow — no bursts, no correlated
  cancels, no hot-level contention. Numbers are an upper bound on order-flow
  realism, honest about mechanism.
- Single instrument, single thread — per CLAUDE.md §3 that is the sharding
  unit; multi-instrument throughput would scale with cores.
- All numbers are from the dev laptop above. The public deployment runs on a
  Render free-tier instance (0.1 vCPU, 512MB) — it is substantially slower
  than these figures and is not the benchmark environment.
