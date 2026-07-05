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
