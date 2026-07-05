// engine.ts — the matching engine for ONE instrument.
// Why: single-threaded, in-memory, price-time priority matching. One engine
// instance per instrument is how real exchanges shard; within an instrument,
// single-threaded execution makes matching deterministic (same input order =
// same fills, always) with zero lock contention.
// Key tradeoff: the engine trusts its inputs (validation happens at the API
// boundary) and never touches I/O — persistence is write-behind, driven by
// the caller consuming SubmitResult. That keeps the hot path allocation-light
// and testable without a server.
//
// Matching rules implemented here:
// - Price priority: an incoming order always matches the best opposite price
//   first (highest bid / lowest ask).
// - Time priority: within a price level, orders fill strictly FIFO.
// - Execution price is the RESTING order's price. An aggressive limit order
//   crossing the spread gets price improvement, never a worse price.
// - Market orders match at any price; any unfilled remainder is CANCELED,
//   never rested (a market order has no price to rest at).
// - Self-trade prevention, cancel-resting policy: if the incoming order would
//   match the same user's own resting order, the resting order is canceled
//   and matching continues. Prevents wash trades without letting a user's
//   stale quote block their own aggressive order.

import { BookSide, type OrderNode } from './book-side.js';
import type { Depth, Fill, OrderInput, SubmitResult } from './types.js';

export class MatchingEngine {
  private readonly bids = new BookSide('buy');
  private readonly asks = new BookSide('sell');
  /** Every RESTING order by ID — the O(1) cancel lookup. Filled/canceled orders are removed. */
  private readonly orders = new Map<number, OrderNode>();
  private nextOrderId = 1;
  /** Monotonic event sequence; total-orders fills without wall-clock time in the hot path. */
  private nextSeq = 1;

  /**
   * Submit an order: match what crosses, then rest or cancel the remainder.
   * Assumes valid input (integer qty > 0; integer price > 0 for limits) —
   * enforced at the API boundary per CLAUDE.md §6.
   */
  submit(input: OrderInput): SubmitResult {
    const orderId = this.nextOrderId++;
    const { side, type, userId } = input;
    const isBuy = side === 'buy';
    const opposite = isBuy ? this.asks : this.bids;

    let remaining = input.qty;
    const fills: Fill[] = [];
    const selfTradeCanceledOrderIds: number[] = [];

    while (remaining > 0) {
      const level = opposite.best();
      if (!level) break;
      // Limit orders stop when the best opposite price no longer crosses.
      if (type === 'limit') {
        const limit = input.price!;
        if (isBuy ? level.price > limit : level.price < limit) break;
      }

      const maker = level.head!;
      if (maker.userId === userId) {
        // Self-trade prevention: cancel own resting order, keep matching.
        selfTradeCanceledOrderIds.push(maker.id);
        this.orders.delete(maker.id);
        opposite.remove(maker); // may empty the level; loop re-reads best()
        continue;
      }

      const tradeQty = Math.min(remaining, maker.qty - maker.filled);
      maker.filled += tradeQty;
      remaining -= tradeQty;
      opposite.reduce(level, tradeQty);
      fills.push({
        price: maker.price, // resting price — taker gets any improvement
        qty: tradeQty,
        makerOrderId: maker.id,
        takerOrderId: orderId,
        makerUserId: maker.userId,
        takerUserId: userId,
        seq: this.nextSeq++,
      });
      if (maker.filled === maker.qty) {
        this.orders.delete(maker.id);
        opposite.remove(maker);
      }
    }

    // Remainder: limits rest on the book, market remainders are canceled.
    let restingQty = 0;
    if (remaining > 0 && type === 'limit') {
      const node: OrderNode = {
        id: orderId,
        userId,
        side,
        price: input.price!,
        qty: input.qty,
        filled: input.qty - remaining,
        prev: null,
        next: null,
        level: null,
      };
      (isBuy ? this.bids : this.asks).add(node);
      this.orders.set(orderId, node);
      restingQty = remaining;
    }

    const status =
      remaining === 0
        ? 'filled'
        : fills.length === 0
          ? type === 'limit'
            ? 'resting'
            : 'canceled'
          : type === 'limit'
            ? 'partial-resting'
            : 'partial-canceled';

    return { orderId, status, fills, restingQty, selfTradeCanceledOrderIds };
  }

  /**
   * Cancel a resting order. Returns false if the ID is unknown, already
   * filled, or already canceled — the caller can't distinguish these, and
   * doesn't need to: in all three cases there is nothing left to cancel.
   * O(1): map lookup + linked-list unlink.
   */
  cancel(orderId: number): boolean {
    const node = this.orders.get(orderId);
    if (!node) return false;
    this.orders.delete(orderId);
    (node.side === 'buy' ? this.bids : this.asks).remove(node);
    return true;
  }

  bestBid(): number | undefined {
    return this.bids.best()?.price;
  }

  bestAsk(): number | undefined {
    return this.asks.best()?.price;
  }

  /** Aggregated top-of-book snapshot, best price first on both sides. */
  depth(levels = 10): Depth {
    return { bids: this.bids.depth(levels), asks: this.asks.depth(levels) };
  }

  /** Unfilled qty of a resting order, or undefined if not resting. For tests/API. */
  openQty(orderId: number): number | undefined {
    const node = this.orders.get(orderId);
    return node ? node.qty - node.filled : undefined;
  }
}
