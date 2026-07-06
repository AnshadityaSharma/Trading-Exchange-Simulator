# A funds precheck must model exactly what the engine will do — including STP

Two blocking bugs the Phase 3 fresh-context review caught (tests were green;
both are now covered by regression tests):

1. **The market-buy funds precheck counted the submitter's own resting asks as
   available liquidity.** But self-trade prevention cancels those, so the order
   fills deeper at worse prices than the precheck assumed — driving cash
   negative with an HTTP 201. Lesson: a pre-trade check that estimates cost by
   reading the book must subtract anything the matching step will remove before
   filling (own orders under STP), or it is checking a different order than the
   one that executes. The fix scans the user's own resting orders on the
   instrument and excludes that qty per level (`Exchange.marketBuyCost`).

2. **One transient DB error permanently wedged the write-behind queue.**
   `pool.connect()` sat outside the try/catch, so a connect rejection (a) never
   re-queued the batch it had already swapped out (silent data loss), (b) left
   the flush promise chain rejected — and because we chained with
   `.then(onFulfilled)` only, no future flush ever ran again, and (c) leaked
   unhandled rejections from the 50ms timer, which crashes Node. Lessons: any
   `await` that acquires a resource belongs *inside* the try that owns cleanup
   and retry; and a serialized promise chain used as a queue must be
   rejection-proof (`.then(fn, fn)`), or a single failure stops the queue
   forever. Both are invisible to a happy-path integration suite — you have to
   inject the failure (see write-behind.test.ts with a fake failing pool).

Why it mattered: bug 1 breaks the money-conservation invariant that is the
whole point of a matching engine; bug 2 turns a blip into permanent, silent
history loss. Neither showed up until a reviewer traced the STP and error paths
by hand.
