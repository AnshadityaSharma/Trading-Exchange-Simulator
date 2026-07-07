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

### D14. Write-behind persistence: latest-wins coalescing, idempotent statements, bounded loss window

**Decision:** The engine/exchange never awaits Postgres. All mutations enqueue into `src/db/write-behind.ts`; a 50ms timer flushes each batch in one transaction. Rows whose final state is all that matters (orders, balances, positions) coalesce in latest-wins maps; append-only events (fills, trades) are inserts with `ON CONFLICT DO NOTHING`. All flushes — timer, shutdown, tests — serialize through one promise chain.

**Why:** A synchronous DB commit per order would put a ~1ms+ round trip inside every submission — a 1000× tax on a 0.7ms request. The cost of async persistence is a crash-loss window of ≤ ~100ms of history, which is acceptable for paper trading and stated openly. Coalescing means a burst of updates to one order/balance writes one row per flush, and idempotent statements make a retried flush after a mid-transaction failure harmless. The promise chain exists because an early version had a `flushing` boolean guard, which made an explicit `flush()` silently no-op while a timer flush was in flight — a race that would have produced flaky reads.

### D15. Boot reconciliation: orphaned open orders are canceled on restart

**Decision:** At boot (before accepting traffic), any order still `open`/`partially_filled` in the DB is marked canceled and its reservation released, in one transaction (`reconcileOpenOrders`).

**Why:** The order book lives only in memory — it dies with the process, so a DB row claiming an order is open after a restart is a lie that would strand the user's reserved cash/position forever. Cancel-on-restart is what the user would want (their quote is gone from the market either way) and is infinitely simpler than book reconstruction from the order log, which would also have to replay every fill that happened... against an empty book. Real exchanges solve this with replicated engines; a portfolio project solves it by being honest about restarts.

### D16. Funds and positions: in-memory authority, reservation-based, no shorting

**Decision:** Account state (cash, reserved cash, positions) lives in memory (`accounts.ts`), checked and mutated synchronously on the order path; Postgres is the durable journal reloaded at boot. Buy limits reserve `price×qty` at submit; fills release at the limit price and spend at the fill price (price improvement refunds the buyer). Sells reserve position quantity. Market buys don't reserve — the exact sweep cost is computed against the live book (single-threaded, so nothing can change between check and execution). Cost basis leaves a position proportionally with integer floor division, with the final lot absorbing the rounding residue so a closed position has exactly zero basis.

**Why:** The funds check is on every order — it must be memory-speed, and single-threaded execution makes check-then-act atomic without locks. Reservations (rather than checking free balance at fill time) guarantee a resting order can always pay for its own fill, which is what makes the no-shorting and no-negative-cash invariants provable rather than hopeful.

### D17. Book deltas: diff of the top-50 window, absolute quantities

**Decision:** After every submit/cancel, the exchange diffs the engine's current top-50 depth against the previously broadcast window and emits one `book_delta` with absolute per-level quantities (`[price, 0]` = level gone). The book sequence increments once per broadcast message.

**Why:** The contract promises exact window semantics ("deltas outside the top 50 are not sent") and gap-free per-channel sequences (D12). Diffing the window handles every edge case uniformly — levels entering the window because a better level emptied, levels leaving it, partial fills — where the tempting alternative (track which prices an operation touched) misses the enter-the-window case entirely and would have shipped a subtle client-side corruption. Absolute quantities make each delta self-contained: applying it can never compound an earlier error.

### D18. Stateless JWT auth with bcryptjs

**Decision:** Signup/login issue a 7-day JWT; `requireAuth` verifies it per request. Passwords hash with bcryptjs (pure JS). No session table, no refresh tokens, no revocation.

**Why:** CLAUDE.md §2 caps auth at email+password. Stateless tokens mean zero DB reads on the request hot path for auth. The known tradeoff — a stolen token works until expiry — is acceptable for virtual money. bcryptjs over native bcrypt/argon2 trades ~2× hashing speed (only paid at login) for zero native-build friction on Windows dev and any deploy target.

### D19. HTTP benchmark: report queueing-aware numbers, control against a no-op endpoint

**Decision:** The HTTP-path benchmark (`bench/http-bench.ts`) reports client-observed latency AND explains it via Little's law, with a `GET /api/health` control run separating express/loopback overhead from exchange work. Server-side per-order cost is derived as 1/throughput, not read off the latency percentiles.

**Why:** With N clients saturating one server thread, observed latency ≈ N ÷ throughput regardless of how fast the server is — publishing "p50 = 13.8ms" without that context would invite the false conclusion that an order takes 13.8ms to process (it takes ~0.74ms; the rest is queueing in the client's own concurrency). The health-endpoint control (~0.26ms/request) shows ~65% of the per-order cost is the generic HTTP/JSON/routing layer, not the exchange — i.e. the engine is 0.07% of request cost, so optimizing it further is pointless for the HTTP path (see bench/results.md).

### D20. History reads drain the write-behind queue first (read-your-writes)

**Decision:** The GET endpoints that read persisted state (`/orders`, `/orders/:id`, `/fills`, `/orders/:id/explain`, and the closed-order lookup inside cancel) call `wb.flush()` before querying Postgres.

**Why:** `POST /orders` returns 201 synchronously, but persistence is async (D14) — without this, a client that reads back its own just-placed order would get a 404 for up to a flush window (~50ms, unbounded under retry), and canceling an order that filled within that window returned `NOT_FOUND` instead of `ORDER_NOT_OPEN`. Both were flagged in the Phase 3 review. Flushing on read gives read-your-writes consistency at the cost of one (batched, serialized) flush per read; reads are human-frequency, far off the hot path, so the cost is irrelevant. The alternative — serving order/fill history from the in-memory records — would duplicate the query layer and re-introduce the open/closed-order bookkeeping the DB already owns.

---

## Phase 4 — Liquidity bots

### D21. Bots are ordinary users, seeded through the persisted path

**Decision:** The two bot accounts (market maker, noise trader) are real rows in `users`/`balances`/`positions`, created idempotently at boot *before* `loadAccounts` runs (`src/bots/seed.ts`), so they enter memory through the exact same path as human users. They trade through the public `Exchange.submit`/`cancel` — same funds checks, reservations, persistence, and events. Seeded once, never reset: bot wealth evolves across restarts like anyone's. Their emails are never issued and their password is 32 random hashed-and-discarded bytes, so the accounts are unreachable through the API.

**Why:** Memory is reloaded from Postgres at every boot (D16), so state seeded only into the in-memory `Accounts` works until the first restart and then vanishes — while the bots' persisted orders would still reference a user the `users` table doesn't have (FK violation on flush). This was flagged in the Phase 3 review before any bot code existed. Going through the public submit path means no special cases downstream: boot reconciliation (D15), write-behind (D14), and money-conservation invariants all hold for bots for free, and the restart test proves it.

### D22. Market maker: diff-based quote maintenance, not cancel-and-replace

**Decision:** Each tick the maker computes the desired quote set around the mid (last trade price, else the instrument's reference price) and converges to it: quotes already at a desired price are left untouched (even partially filled — replaced only once fully consumed), stale quotes are canceled *before* new ones are placed, missing ones are submitted. A steady book produces zero orders, zero cancels, zero DB rows per tick.

**Why:** The naive strategy (cancel everything, requote everything, every tick) would write ~6 order rows per instrument per tick to Postgres forever — hundreds of thousands of junk rows a day for a book that didn't move. Diffing bounds churn to actual price movement. Canceling stale quotes first makes self-crossing structurally impossible when the mid jumps (a recentered bid can never meet the bot's own old ask). Known accepted cost: bot order history still grows the `orders` table with every real requote; if it ever matters, an age-based cleanup of terminal bot orders is a 5-line cron, deliberately not built for v1.

### D23. Noise trader: market orders with an inventory-mean-reverting side bias

**Decision:** A second bot user fires small market orders at jittered intervals (0.5–1.5× the mean, per instrument). Side selection is 65/35 biased toward returning its position to the seeded quantity; sizes are 1–5 lots. Business rejections (empty book, insufficient funds) skip the tick silently.

**Why:** Without takers there are no trades: `lastPrice` never moves, stats stay null, the tape is empty, and the AI explainer has nothing to explain. Each take moves the price by roughly the half-spread and the maker recenters on it — a random walk emerges from the 35% contrarian ticks with no price model to defend. The mean-reversion bias is the loop's stability mechanism: it continually pulls the noise bot back toward its seeded inventory, so under normal operation it doesn't drift out of shares or cash and the market runs unattended. It's a heuristic, not a hard invariant — a long enough unlucky price walk could still deplete one side; the bot handles that gracefully (a rejected submit just skips the tick) and the bias pulls it back. It must be a *different* user than the maker — otherwise self-trade prevention (D5) would cancel the maker's quotes instead of trading with them.

### D24. AI explainer: a stubbable interface, DB-free, prompt built from exact facts

**Decision:** `GET /api/orders/:id/explain` is served by an `Explainer` interface (`src/ai/explainer.ts`) with two implementations: `UnavailableExplainer` (no `ANTHROPIC_API_KEY` configured → the contract's INTERNAL error) and `AnthropicExplainer` (the real one, `@anthropic-ai/sdk`, default model `claude-haiku-4-5`, overridable via `AI_MODEL`). The explainer takes an injected `ExplainDataSource` — the SQL that gathers the order, its fills, and instrument meta lives in `boot.ts`, not the AI module, so the module is DB-free and unit-testable against a fake messages client. The prompt is built by a pure `buildPrompt` from exact integer facts pre-formatted to rupees in code (the model never does the arithmetic); the call runs with no extended thinking and `effort: low` (a short explanation is a simple task); results are cached per order in a bounded (1000-entry, FIFO) in-memory map. `stop_reason: 'refusal'`, an API error, and empty content all map to INTERNAL.

**Why:** CLAUDE.md §3 requires the AI layer isolated behind an interface that can be stubbed in tests — so the interface (`explainOrder(orderId)`) and the route are unchanged whether the real or stub implementation is wired, and the stub covers the no-key deploy honestly. Keeping SQL out of the AI module (inject the data source) means the query layer stays the single home for queries (§4) and the explainer's logic — prompt shape, caching, error mapping — is tested with no Postgres and no network (`explainer.test.ts`). Pre-formatting money in code rather than asking the model to divide by the price scale keeps the no-floats/no-rounding invariant (D1) out of the model's hands, where it could silently get it wrong. `claude-haiku-4-5` is the demo default: the explain endpoint is a short, human-facing call a recruiter triggers by clicking, so latency and per-call cost on a public deploy matter more than the extra reasoning headroom a frontier model would bring to what is essentially restating structured facts in prose. `AI_MODEL` overrides it (e.g. `claude-opus-4-8`) for richer explanations — the quality/cost trade is a config knob, not baked in, and choosing the cheaper default here is a deliberate, stated decision rather than a silent downgrade.
