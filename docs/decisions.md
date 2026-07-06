# Decisions log

Running record of non-obvious design decisions and the reasoning behind them.
Written as interview prep: each entry answers "why did you do it this way?"

---

## Phase 1 — Matching engine

### D1. Integer ticks for prices and quantities (no floats)

**Decision:** The engine only ever sees integers. Prices are ticks (e.g. paise/cents), quantities are whole units. The API layer converts display prices to ticks at the boundary.

**Why:** Floating point cannot represent most decimal fractions exactly (`0.1 + 0.2 !== 0.3`). In a matching engine that means two orders at "the same price" might not compare equal, and account balances drift over millions of fills. Integers make every comparison and sum exact, and JS numbers are exact integers up to 2^53, which is far beyond any realistic price or volume here. This is also what real exchanges do — prices are quoted in ticks, not floats.

### D2. Order book data structure: sorted price array + hashmap of levels + intrusive doubly-linked FIFO queues

**Decision:** Each book side (`src/engine/book-side.ts`) is:
- `Map<price, PriceLevel>` — O(1) level lookup by price
- a sorted array of distinct prices, **best price at the end** (bids ascending, asks descending) — best price is O(1), removing an exhausted best level is `pop()` = O(1)
- each `PriceLevel` holds an intrusive doubly-linked list of order nodes (FIFO = time priority)
- the engine keeps `Map<orderId, OrderNode>` — O(1) cancel: hashmap lookup, then unlink the node with pointer surgery, no searching

**Complexities:** best bid/ask O(1); cancel O(1) (amortized — removing an emptied non-best price level costs a splice, O(L)); each fill during matching O(1); inserting a NEW price level O(log L) binary search + O(L) splice, where L = number of distinct price levels on that side.

**Why not a heap?** A binary heap gives O(log L) insert but cancels are the problem: finding an arbitrary element in a heap is O(L), and you still need the per-level FIFO for time priority. Heaps also can't iterate levels in order cheaply (needed for depth snapshots).

**Why not a balanced BST (red-black tree)?** It's the "textbook right" answer — O(log L) insert AND delete anywhere. But CLAUDE.md forbids a dependency doing the core work, so it would be ~200 lines of hand-written rebalancing code. The sorted array wins in practice because L is small (a liquid book clusters near the touch — tens of levels, not thousands) and the O(L) splice is a contiguous memmove of numbers, which is extremely fast and cache-friendly. Most level insertions happen at or near the best price (the end of the array), making the splice nearly free. The benchmark harness (Phase 2) validates this; if it's ever the bottleneck, the array is swappable behind `BookSide`'s public methods without touching the engine.

**Why an intrusive linked list instead of an array queue per level?** Cancel needs to remove from the *middle* of a queue in O(1) while preserving FIFO order of everyone else. An array queue makes middle-removal O(n) or forces tombstones; a doubly-linked list where the map points straight at the node makes it pure pointer surgery.

### D3. Execution price is always the resting order's price

**Decision:** When an aggressive order crosses the spread, fills happen at the maker's price, so the taker gets price improvement (buy limit 5050 against an ask at 5000 executes at 5000).

**Why:** This is how price-time priority exchanges work: the resting order set the price first; the incoming order accepting a *better* price than its limit is improvement, not a violation. The alternative (executing at the taker's limit) would silently transfer money from taker to maker and is not how any real venue behaves.

### D4. Market order remainder is canceled, never rested

**Decision:** A market order fills as much as the book allows; any remainder is canceled (`partial-canceled` / `canceled` status). It never rests.

**Why:** A market order has no price, so there is no level to rest it at. Converting it to a limit at the last fill price invents a price the user never agreed to. Cancel-remainder (equivalent to IOC semantics) is the simplest honest behavior, and the liquidity bots (Phase 4) keep the book deep enough that full fills are the normal case.

### D5. Self-trade prevention: cancel-resting policy

**Decision:** If an incoming order would match a resting order from the same user, the engine cancels the resting order and keeps matching (`selfTradeCanceledOrderIds` in the result). It never lets a user trade with themselves.

**Why:** Self-fills are wash trades — they create fake volume and fake fills, which would also pollute the AI explainability layer. Of the standard STP policies (cancel-resting, cancel-incoming, cancel-both), cancel-resting matches the trader's most likely intent: the *new* order expresses their current desire; the old quote is stale. Cancel-incoming would let a user's own forgotten quote block their aggressive order. Real venues (e.g. Nasdaq, CME) offer exactly these policies; cancel-resting ("cancel oldest") is a common default.

### D6. Engine assigns IDs and sequence numbers; no wall-clock time in the hot path

**Decision:** The engine hands out monotonically increasing integer order IDs and a global fill sequence number. No `Date.now()` inside matching.

**Why:** Time priority needs *ordering*, not timestamps — arrival order IS the order of `submit()` calls in a single-threaded engine, and the FIFO queue encodes it structurally. Skipping syscalls in the hot path keeps matching deterministic (same inputs → byte-identical outputs, which a test asserts) and fast. The server layer can attach wall-clock timestamps when persisting.

### D7. Cancel returns a bare boolean

**Decision:** `cancel(orderId)` returns `false` for unknown, already-filled, and already-canceled orders alike.

**Why:** In all three cases the caller's situation is identical — there is nothing left to cancel — and distinguishing them would require keeping terminal orders in memory forever. The order-history record in Postgres (Phase 3) is the place to answer "what happened to order X", not the engine's hot-path map.

---

## Phase 2 — Benchmark harness

### D8. Throughput and latency are measured in separate passes

**Decision:** `bench/engine-bench.ts` runs a throughput pass (one clock read per 1M-op run) and a separate latency pass (every op individually timed with `process.hrtime.bigint()`).

**Why:** Reading the clock costs real time — an empty `hrtime.bigint()` pair measures ~100ns on this machine, and the engine's median op is ~300ns. Timing every op inside the throughput run would roughly double per-op cost and understate throughput by a third. Splitting the passes means each number is clean: throughput has near-zero measurement overhead, and the latency pass *reports* its clock overhead instead of hiding it (it's included, not subtracted — subtracting a median from individual samples would fabricate precision).

### D9. Deterministic seeded workload, run on compiled JS

**Decision:** The synthetic flow comes from a seeded xorshift32 PRNG, so every benchmark run replays the byte-identical order stream. The `bench` script compiles with `tsc` first and runs plain `node` on the output.

**Why:** Determinism makes runs comparable across engine changes — a regression is a real regression, not workload noise. Running compiled JS (not a transpile-on-the-fly runner) means the numbers measure the engine, not tooling overhead, and match how production would run.

### D10. Workload mix: 70% limit / 10% market / 20% cancel, cancels target random live orders

**Decision:** Cancels pick a random previously-rested order ID; a picked ID is removed from tracking whether or not the cancel succeeds (the order may have been filled since).

**Why:** Roughly mirrors real venue flow, where cancel-to-trade ratios are high and cancels frequently race fills (the "stale cancel" is a real, common path — it must be cheap, and the O(1) map-miss makes it so). Measured composition: about a third of limits fill on arrival and two-thirds rest, and ~81% of cancel attempts are stale. Because stale cancels (hashmap misses) are far cheaper than real ones (unlink from the book), the harness reports cancel-hit and cancel-miss as separate latency distributions — averaging them would publish a number that mostly measures the miss path.

### D11. The price band is a CLI knob to stress the sorted-array choice

**Decision:** `npm run bench -- 5000` widens the price band from ±50 to ±5000 ticks (≤101 → ≤10,001 distinct levels per side).

**Why:** The one theoretical weakness of the sorted price array (D2) is the O(L) splice when inserting a new level away from the best. The deep-book run is the direct experimental test of that concern: with 100× more levels, mean throughput is indistinguishable from the default run (run-to-run noise on this laptop is larger than any level-count effect) and submit p99 moves 1.5µs → 1.9µs (see bench/results.md). The flat p99 is the evidence — not a hand-wave — that the array beats a hand-rolled balanced tree here. Throughput deltas below ~10% should never be quoted from single runs on this machine.

---

## Phase 3 — Server layer

### D12. Market-data sequence numbers are independent per channel, per instrument

**Decision:** `book:<SYMBOL>` and `trades:<SYMBOL>` each carry their own monotonic `seq` (increment-by-1 within the channel). The REST book snapshot shares the book sequence space; the REST trades list shares the trade sequence space. Clients apply the gap-detection rule within a channel only.

**Why:** The first draft implied one shared per-instrument sequence, which breaks gap detection: a book-channel subscriber would see a "gap" every time a trade consumed a number, triggering constant false resubscribes (caught at contract review). Per-channel sequences make "increases by exactly 1" literally true for every subscriber, and sharing the space between REST snapshot and WS deltas is what lets a client stitch a REST snapshot onto a live delta stream. This mirrors how real exchange feeds version their books (e.g. depth update IDs separate from trade IDs).

### D13. Stats endpoint included in the frozen contract

**Decision:** `GET /api/instruments/:symbol/stats` (last price, 24h open/high/low/volume) is part of v1. The API sends no derived or rounded values (no change %, no averages) — clients compute those from exact integers.

**Why:** Every trading UI header needs these numbers; leaving it out would either break the freeze later or force the frontend to derive stats from the trade tape client-side (wrong place — it would need the full 24h tape). Excluding derived values keeps the no-floats/no-rounding invariant of the whole API (see D1).
