# Benchmark numbers must be measured from the source of truth, not the harness's bookkeeping

The Phase 2 fresh-context review caught three ways the first published benchmark
numbers were misleading, all now fixed. Recorded so the HTTP-path benchmark
(Phase 3+) doesn't repeat them:

1. **The harness's tracker is not the system's state.** The first results
   claimed a "1.38M-order book" from the harness's live-ID list; the engine's
   real resting count (via `restingOrderCount()`) was 259k — the tracker was
   81% stale IDs. Always read state metrics from the system under test, never
   from the load generator.

2. **Split cheap and expensive variants of the same operation.** 81% of timed
   "cancels" were stale-ID hashmap misses, so the published cancel latency
   mostly measured the miss path. One label, two very different code paths —
   report them as separate distributions (cancel-hit vs cancel-miss).

3. **Respect the timer quantum and thermal variance.** `hrtime.bigint()` has a
   ~100ns quantum here, so "p50=300ns" is a 3-tick reading that drifted a tick
   between runs; and this laptop's run-to-run throughput varies well over 10%
   (2.2M ops/sec cool vs 1.5M warm). Publish the conservative figure, state the
   variance, and never quote sub-noise deltas as findings.

Why it mattered: the project's whole pitch is honest, defensible numbers; every
one of these would have been caught by a probing interviewer.
