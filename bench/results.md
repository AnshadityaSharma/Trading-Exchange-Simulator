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
| Date | 2026-07-05 |

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
| 1 | 1,481,905 | 59,787 |
| 2 | 1,538,479 | 109,530 |
| 3 | 1,838,882 | 159,340 |
| 4 | 1,802,580 | 209,512 |
| 5 | 1,575,578 | 258,764 |
| **mean** | **1,647,485** | |
| **worst run** | **1,481,905** | |

**Run-to-run variance is real:** a second identical session gave mean 1,674,064
with worst run 1,385,209, and an earlier session on a cooler machine measured
means up to ~2.2M. This is a laptop CPU with thermal throttling; the honest
sustained figure is **≥1.4M mixed ops/sec on the worst observed run**. At 80%
submits that is **≥1.1M order submissions/sec — >20× the 50k orders/sec target**
even at the most conservative reading.

**Latency** (1M individually timed ops):

| op | p50 | p95 | p99 | p99.9 | max | n |
|---|---|---|---|---|---|---|
| submit (match) | 500ns | 1.00µs | 1.50µs | 2.90µs | 3.74ms | 800,371 |
| cancel hit (removes a resting order) | 900ns | 1.50µs | 2.30µs | 5.20µs | 47.3µs | 38,279 |
| cancel miss (stale ID, hashmap miss) | 400ns | 700ns | 1.10µs | 2.10µs | 77.3µs | 161,350 |

p99 submit latency is **1.5µs against a 5ms target** (~3,000× headroom). The
millisecond-scale submit max is a one-in-800k outlier consistent with a GC
pause; p99.9 is 2.9µs.

## Results — deep book (±5000 ticks ⇒ ≤10,001 price levels/side)

`npm run bench -- 5000` — stress-tests the sorted-price-array choice (its only
non-O(1)/O(log L) operation is the O(L) splice when a NEW price level is
inserted away from the best).

| metric | value |
|---|---|
| throughput mean / worst run | 1,693,387 / 1,598,994 ops/sec |
| submit p50 / p99 / p99.9 / max | 600ns / 1.90µs / 4.60µs / 5.82ms |
| cancel-hit p50 / p99 | 1.10µs / 3.00µs |

With 100× more price levels, mean throughput was statistically
indistinguishable from the default run (it actually measured slightly *higher*,
i.e. the difference is inside run-to-run noise), and submit p99 moved from
1.5µs to 1.9µs. Conclusion: at 10k levels the array splice is not a
bottleneck; the solid evidence for the data-structure choice (decisions.md D2,
D11) is the flat p99, not a precise throughput delta.

## Results — full HTTP path

`npm run bench:http` ([http-bench.ts](http-bench.ts)) — real `POST /api/orders`
requests over localhost keep-alive connections against the fully booted
backend (express + JWT auth + zod validation + reservations + matching +
WebSocket fan-out + write-behind persistence). 20 concurrent client loops,
30,000 orders, 2,000-request warmup. Measured 2026-07-06:

| metric | value |
|---|---|
| throughput | **1,354 orders/sec** sustained (22.2s run) |
| latency p50 / p95 / p99 / max | 13.77ms / 22.04ms / 27.41ms / 48.22ms |
| responses | 25,385 accepted, 4,615 business rejections (INSUFFICIENT_FUNDS as bench buyers' cash migrates into resting orders), 0 errors |

**How to read the latency numbers:** they are dominated by queueing, not
service time. With 20 requests permanently in flight against a single-threaded
server, Little's law (latency ≈ in-flight ÷ throughput = 20 ÷ 1,354) predicts
14.8ms — almost exactly the observed p50. The same holds for a no-op control:
`GET /api/health` under identical concurrency measured 3,912 req/sec at p50
4.68ms (predicted 5.1ms). Per-request **server-side** cost is therefore
~0.26ms for the bare HTTP/express layer and ~0.74ms for a full order — the
matching engine (0.5µs, see above) is ~0.07% of the request cost. The
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
- Full HTTP-path numbers will be measured in Phase 3+ and will be far lower;
  that is expected and will be reported as-is.
