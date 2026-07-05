// book-side.ts — one side of the order book (all bids, or all asks).
// Why: the matching engine needs three operations to be fast:
//   1. find the best price level            -> O(1)  (end of a sorted array)
//   2. cancel an arbitrary order by ID      -> O(1)  (intrusive doubly-linked
//      list inside each level; the engine holds a Map<orderId, node>)
//   3. insert a new price level             -> O(log L + L) binary search +
//      splice, where L = number of DISTINCT price levels on this side.
// Key tradeoff: a sorted array of prices instead of a balanced tree or heap.
// L is small in practice (liquid books cluster near the touch, and most
// inserts land at or near the best price, making the splice nearly free),
// arrays are cache-friendly, and a hand-rolled red-black tree is a lot of
// code for no measured win. The benchmark harness validates this choice; if
// it ever shows up as the bottleneck, swap this file's internals — the
// engine only sees the public methods.

import type { Side } from './types.js';

/**
 * A resting order, stored as a node of its price level's FIFO queue.
 * Intrusive linked list: the node IS the order, so canceling by reference
 * is pointer surgery — no searching, no index bookkeeping.
 */
export interface OrderNode {
  id: number;
  userId: number;
  side: Side;
  price: number;
  qty: number;
  filled: number;
  prev: OrderNode | null;
  next: OrderNode | null;
  level: PriceLevel | null;
}

/** One price level: a FIFO queue of orders. FIFO = time priority within price. */
export interface PriceLevel {
  price: number;
  head: OrderNode | null;
  tail: OrderNode | null;
  /** Sum of unfilled qty across the queue — kept incrementally for O(1) depth. */
  totalQty: number;
}

export class BookSide {
  private readonly levels = new Map<number, PriceLevel>();
  /**
   * Distinct prices, sorted so the BEST price is at the END of the array:
   * bids ascending (best = highest = last), asks descending (best = lowest
   * = last). Best-price access and exhausted-level removal are then pop()
   * — O(1) — which is the hot path during matching.
   */
  private readonly prices: number[] = [];
  private readonly isBid: boolean;

  constructor(side: Side) {
    this.isBid = side === 'buy';
  }

  /** Best price level, or undefined if this side is empty. O(1). */
  best(): PriceLevel | undefined {
    const price = this.prices[this.prices.length - 1];
    return price === undefined ? undefined : this.levels.get(price);
  }

  /** Append an order to the back of its price level's queue (time priority). */
  add(node: OrderNode): void {
    let level = this.levels.get(node.price);
    if (!level) {
      level = { price: node.price, head: null, tail: null, totalQty: 0 };
      this.levels.set(node.price, level);
      this.insertPrice(node.price);
    }
    node.level = level;
    node.prev = level.tail;
    node.next = null;
    if (level.tail) level.tail.next = node;
    else level.head = node;
    level.tail = node;
    level.totalQty += node.qty - node.filled;
  }

  /**
   * Unlink an order from its level (cancel, or fully filled). O(1) unless the
   * level empties and is not the best (then a splice removes its price).
   */
  remove(node: OrderNode): void {
    const level = node.level!;
    if (node.prev) node.prev.next = node.next;
    else level.head = node.next;
    if (node.next) node.next.prev = node.prev;
    else level.tail = node.prev;
    level.totalQty -= node.qty - node.filled;
    node.prev = node.next = null;
    node.level = null;
    if (!level.head) this.removePrice(level.price);
  }

  /** Called by the engine after a fill to keep aggregated depth exact. */
  reduce(level: PriceLevel, qty: number): void {
    level.totalQty -= qty;
  }

  /** Top `n` levels, best first. For snapshots — not on the matching hot path. */
  depth(n: number): { price: number; qty: number }[] {
    const out: { price: number; qty: number }[] = [];
    for (let i = this.prices.length - 1; i >= 0 && out.length < n; i--) {
      const level = this.levels.get(this.prices[i]!)!;
      out.push({ price: level.price, qty: level.totalQty });
    }
    return out;
  }

  private insertPrice(price: number): void {
    // Binary search for the insertion point. The array is sorted ascending
    // by "goodness": bids by price, asks by -price. Best is always last.
    const key = this.isBid ? price : -price;
    let lo = 0;
    let hi = this.prices.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      const midKey = this.isBid ? this.prices[mid]! : -this.prices[mid]!;
      if (midKey < key) lo = mid + 1;
      else hi = mid;
    }
    this.prices.splice(lo, 0, price);
  }

  private removePrice(price: number): void {
    this.levels.delete(price);
    // Hot path: the exhausted level is almost always the best (matching
    // consumes from the top of the book), so this is usually a pop().
    if (this.prices[this.prices.length - 1] === price) {
      this.prices.pop();
      return;
    }
    const key = this.isBid ? price : -price;
    let lo = 0;
    let hi = this.prices.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      const midKey = this.isBid ? this.prices[mid]! : -this.prices[mid]!;
      if (midKey < key) lo = mid + 1;
      else hi = mid;
    }
    this.prices.splice(lo, 1);
  }
}
