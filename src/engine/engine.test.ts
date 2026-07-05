// engine.test.ts — exhaustive unit tests for the matching engine.
// Covers every §6 edge case: partial fills, price improvement, cancels,
// self-match, empty book, crossing spreads — plus priority ordering,
// market-order semantics, and depth bookkeeping.

import { beforeEach, describe, expect, it } from 'vitest';
import { MatchingEngine, type OrderInput } from './index.js';

let engine: MatchingEngine;

beforeEach(() => {
  engine = new MatchingEngine();
});

// Terse helpers so each test reads like a market scenario.
const order = (
  userId: number,
  side: 'buy' | 'sell',
  type: 'limit' | 'market',
  qty: number,
  price?: number,
): OrderInput => ({ userId, side, type, qty, price });

const buy = (userId: number, qty: number, price: number) =>
  engine.submit(order(userId, 'buy', 'limit', qty, price));
const sell = (userId: number, qty: number, price: number) =>
  engine.submit(order(userId, 'sell', 'limit', qty, price));
const buyMkt = (userId: number, qty: number) =>
  engine.submit(order(userId, 'buy', 'market', qty));
const sellMkt = (userId: number, qty: number) =>
  engine.submit(order(userId, 'sell', 'market', qty));

describe('empty book', () => {
  it('rests a limit order with no fills', () => {
    const res = buy(1, 100, 5000);
    expect(res.status).toBe('resting');
    expect(res.fills).toEqual([]);
    expect(res.restingQty).toBe(100);
    expect(engine.bestBid()).toBe(5000);
    expect(engine.bestAsk()).toBeUndefined();
  });

  it('cancels a market order entirely — nothing to match, nothing rests', () => {
    const res = buyMkt(1, 100);
    expect(res.status).toBe('canceled');
    expect(res.fills).toEqual([]);
    expect(res.restingQty).toBe(0);
    expect(engine.depth()).toEqual({ bids: [], asks: [] });
  });

  it('reports an empty depth snapshot', () => {
    expect(engine.depth()).toEqual({ bids: [], asks: [] });
  });
});

describe('basic matching', () => {
  it('fully fills an incoming order against an equal resting order', () => {
    const resting = sell(1, 100, 5000);
    const res = buy(2, 100, 5000);
    expect(res.status).toBe('filled');
    expect(res.fills).toHaveLength(1);
    expect(res.fills[0]).toMatchObject({
      price: 5000,
      qty: 100,
      makerOrderId: resting.orderId,
      takerOrderId: res.orderId,
      makerUserId: 1,
      takerUserId: 2,
    });
    // Both orders are gone from the book.
    expect(engine.bestBid()).toBeUndefined();
    expect(engine.bestAsk()).toBeUndefined();
  });

  it('does not match limit orders that do not cross', () => {
    sell(1, 100, 5010);
    const res = buy(2, 100, 5000);
    expect(res.status).toBe('resting');
    expect(res.fills).toEqual([]);
    expect(engine.bestBid()).toBe(5000);
    expect(engine.bestAsk()).toBe(5010);
  });

  it('matches sell-side takers against resting bids symmetrically', () => {
    buy(1, 100, 5000);
    const res = sell(2, 100, 5000);
    expect(res.status).toBe('filled');
    expect(res.fills[0]!.price).toBe(5000);
    expect(engine.bestBid()).toBeUndefined();
  });
});

describe('partial fills', () => {
  it('partially fills the incoming order and rests the remainder', () => {
    sell(1, 60, 5000);
    const res = buy(2, 100, 5000);
    expect(res.status).toBe('partial-resting');
    expect(res.fills).toHaveLength(1);
    expect(res.fills[0]!.qty).toBe(60);
    expect(res.restingQty).toBe(40);
    expect(engine.bestBid()).toBe(5000);
    expect(engine.openQty(res.orderId)).toBe(40);
    expect(engine.bestAsk()).toBeUndefined();
  });

  it('partially fills the resting order and leaves it on the book', () => {
    const resting = sell(1, 100, 5000);
    const res = buy(2, 30, 5000);
    expect(res.status).toBe('filled');
    expect(engine.openQty(resting.orderId)).toBe(70);
    expect(engine.depth().asks).toEqual([{ price: 5000, qty: 70 }]);
  });

  it('a partially-filled resting order can be filled by later orders', () => {
    const resting = sell(1, 100, 5000);
    buy(2, 30, 5000);
    const res = buy(3, 70, 5000);
    expect(res.status).toBe('filled');
    expect(engine.openQty(resting.orderId)).toBeUndefined();
    expect(engine.bestAsk()).toBeUndefined();
  });

  it('fills an incoming order across multiple counterparties at one level', () => {
    sell(1, 30, 5000);
    sell(2, 30, 5000);
    sell(3, 30, 5000);
    const res = buy(4, 90, 5000);
    expect(res.status).toBe('filled');
    expect(res.fills.map((f) => f.qty)).toEqual([30, 30, 30]);
    expect(res.fills.map((f) => f.makerUserId)).toEqual([1, 2, 3]);
  });
});

describe('price priority and price improvement', () => {
  it('executes at the resting price when the taker crosses the spread', () => {
    sell(1, 100, 5000);
    const res = buy(2, 100, 5050); // willing to pay 5050, asks at 5000
    expect(res.status).toBe('filled');
    expect(res.fills[0]!.price).toBe(5000); // price improvement for the taker
  });

  it('matches the best (lowest) ask first for an incoming buy', () => {
    sell(1, 50, 5020);
    sell(2, 50, 5000); // better ask, submitted later
    sell(3, 50, 5010);
    const res = buy(4, 150, 5020);
    expect(res.fills.map((f) => f.price)).toEqual([5000, 5010, 5020]);
  });

  it('matches the best (highest) bid first for an incoming sell', () => {
    buy(1, 50, 4980);
    buy(2, 50, 5000);
    buy(3, 50, 4990);
    const res = sell(4, 150, 4980);
    expect(res.fills.map((f) => f.price)).toEqual([5000, 4990, 4980]);
  });

  it('walks the book only as deep as its limit price allows', () => {
    sell(1, 50, 5000);
    sell(2, 50, 5010);
    sell(3, 50, 5020);
    const res = buy(4, 150, 5010); // will not pay 5020
    expect(res.status).toBe('partial-resting');
    expect(res.fills.map((f) => f.price)).toEqual([5000, 5010]);
    expect(res.restingQty).toBe(50);
    expect(engine.bestBid()).toBe(5010);
    expect(engine.bestAsk()).toBe(5020);
  });
});

describe('time priority (FIFO within a price level)', () => {
  it('fills orders at the same price strictly in arrival order', () => {
    const first = sell(1, 40, 5000);
    const second = sell(2, 40, 5000);
    const third = sell(3, 40, 5000);
    const res = buy(4, 100, 5000);
    expect(res.fills.map((f) => f.makerOrderId)).toEqual([
      first.orderId,
      second.orderId,
      third.orderId,
    ]);
    // Third was only partially filled: 40+40 to first two, 20 to third.
    expect(res.fills.map((f) => f.qty)).toEqual([40, 40, 20]);
    expect(engine.openQty(third.orderId)).toBe(20);
  });

  it('a partially-filled resting order keeps its queue position', () => {
    const first = sell(1, 100, 5000);
    const second = sell(2, 100, 5000);
    buy(3, 50, 5000); // first is now 50/100 filled
    const res = buy(4, 100, 5000);
    // first's remaining 50 fills before second gets touched.
    expect(res.fills.map((f) => f.makerOrderId)).toEqual([
      first.orderId,
      second.orderId,
    ]);
    expect(res.fills.map((f) => f.qty)).toEqual([50, 50]);
  });

  it('an order that loses its place re-queues at the back when resubmitted', () => {
    sell(1, 40, 5000);
    const canceled = sell(2, 40, 5000);
    engine.cancel(canceled.orderId);
    const resubmitted = sell(2, 40, 5000);
    sell(3, 40, 5000);
    const res = buy(4, 120, 5000);
    expect(res.fills.map((f) => f.makerUserId)).toEqual([1, 2, 3]);
    expect(res.fills[1]!.makerOrderId).toBe(resubmitted.orderId);
  });
});

describe('crossing spreads (aggressive limit orders)', () => {
  it('sweeps multiple ask levels and rests the remainder at its limit', () => {
    sell(1, 30, 5000);
    sell(2, 30, 5010);
    sell(3, 30, 5020);
    const res = buy(4, 120, 5030);
    expect(res.status).toBe('partial-resting');
    expect(res.fills.map((f) => f.price)).toEqual([5000, 5010, 5020]);
    expect(res.restingQty).toBe(30);
    expect(engine.bestBid()).toBe(5030);
    expect(engine.bestAsk()).toBeUndefined();
  });

  it('a crossing sell sweeps bid levels high-to-low', () => {
    buy(1, 30, 5020);
    buy(2, 30, 5010);
    buy(3, 30, 5000);
    const res = sell(4, 90, 5000);
    expect(res.status).toBe('filled');
    expect(res.fills.map((f) => f.price)).toEqual([5020, 5010, 5000]);
  });
});

describe('market orders', () => {
  it('fills at the best available prices regardless of level', () => {
    sell(1, 50, 5000);
    sell(2, 50, 5100);
    const res = buyMkt(3, 100);
    expect(res.status).toBe('filled');
    expect(res.fills.map((f) => f.price)).toEqual([5000, 5100]);
  });

  it('cancels the unfilled remainder instead of resting it', () => {
    sell(1, 60, 5000);
    const res = buyMkt(2, 100);
    expect(res.status).toBe('partial-canceled');
    expect(res.fills[0]!.qty).toBe(60);
    expect(res.restingQty).toBe(0);
    expect(engine.bestBid()).toBeUndefined(); // nothing rested
    expect(engine.bestAsk()).toBeUndefined(); // book fully consumed
  });

  it('sell market orders work symmetrically', () => {
    buy(1, 50, 5000);
    buy(2, 50, 4900);
    const res = sellMkt(3, 120);
    expect(res.status).toBe('partial-canceled');
    expect(res.fills.map((f) => f.price)).toEqual([5000, 4900]);
    expect(res.fills.map((f) => f.qty)).toEqual([50, 50]);
  });
});

describe('cancels', () => {
  it('removes a resting order from the book', () => {
    const res = buy(1, 100, 5000);
    expect(engine.cancel(res.orderId)).toBe(true);
    expect(engine.bestBid()).toBeUndefined();
    expect(engine.openQty(res.orderId)).toBeUndefined();
  });

  it('returns false for an unknown order ID', () => {
    expect(engine.cancel(999)).toBe(false);
  });

  it('returns false for an already-filled order', () => {
    const resting = sell(1, 100, 5000);
    buy(2, 100, 5000);
    expect(engine.cancel(resting.orderId)).toBe(false);
  });

  it('returns false for an already-canceled order (no double cancel)', () => {
    const res = buy(1, 100, 5000);
    expect(engine.cancel(res.orderId)).toBe(true);
    expect(engine.cancel(res.orderId)).toBe(false);
  });

  it('cancels a partially-filled order, removing only the open remainder', () => {
    const resting = sell(1, 100, 5000);
    buy(2, 30, 5000);
    expect(engine.cancel(resting.orderId)).toBe(true);
    expect(engine.bestAsk()).toBeUndefined();
    expect(engine.depth().asks).toEqual([]);
  });

  it('cancels from the middle of a queue without breaking FIFO around it', () => {
    const a = sell(1, 10, 5000);
    const b = sell(2, 10, 5000);
    const c = sell(3, 10, 5000);
    engine.cancel(b.orderId);
    const res = buy(4, 20, 5000);
    expect(res.fills.map((f) => f.makerOrderId)).toEqual([a.orderId, c.orderId]);
  });

  it('canceling the only order at a level removes the level from depth', () => {
    buy(1, 10, 5000);
    const inner = buy(1, 10, 4990);
    engine.cancel(inner.orderId);
    expect(engine.depth().bids).toEqual([{ price: 5000, qty: 10 }]);
  });
});

describe('self-trade prevention (cancel-resting)', () => {
  it('cancels own resting order instead of self-matching, then keeps matching', () => {
    const own = sell(1, 50, 5000); // user 1's own ask at the front
    const other = sell(2, 50, 5000);
    const res = buy(1, 50, 5000); // user 1 crosses their own quote
    expect(res.status).toBe('filled');
    expect(res.selfTradeCanceledOrderIds).toEqual([own.orderId]);
    expect(res.fills).toHaveLength(1);
    expect(res.fills[0]!.makerOrderId).toBe(other.orderId);
    expect(engine.openQty(own.orderId)).toBeUndefined(); // gone from the book
  });

  it('cancels own orders across multiple levels while sweeping', () => {
    const ownA = sell(1, 30, 5000);
    sell(2, 30, 5010);
    const ownB = sell(1, 30, 5020);
    const res = buy(1, 90, 5020);
    expect(res.selfTradeCanceledOrderIds).toEqual([ownA.orderId, ownB.orderId]);
    expect(res.fills.map((f) => f.makerUserId)).toEqual([2]);
    expect(res.status).toBe('partial-resting');
    expect(res.restingQty).toBe(60);
  });

  it('rests a market order remainder as canceled after self-trade cleanup', () => {
    sell(1, 50, 5000); // only liquidity is the user's own order
    const res = buyMkt(1, 50);
    expect(res.status).toBe('canceled');
    expect(res.fills).toEqual([]);
    expect(res.selfTradeCanceledOrderIds).toHaveLength(1);
    expect(engine.bestAsk()).toBeUndefined();
  });

  it('cancels an own order sitting behind another user in the same level queue', () => {
    const other = sell(2, 30, 5000); // head of the 5000 level
    const own = sell(1, 30, 5000); // user 1 queued behind
    const res = buy(1, 60, 5000);
    expect(res.fills).toHaveLength(1);
    expect(res.fills[0]!.makerOrderId).toBe(other.orderId);
    expect(res.selfTradeCanceledOrderIds).toEqual([own.orderId]);
    // 30 filled, own 30 self-canceled, remaining 30 rests.
    expect(res.status).toBe('partial-resting');
    expect(res.restingQty).toBe(30);
    expect(engine.depth().asks).toEqual([]);
  });

  it('self-cancels a partially-filled own order, removing only its open quantity', () => {
    const own = sell(1, 100, 5000);
    buy(2, 30, 5000); // own order is now 30/100 filled
    const res = buy(1, 70, 5000); // user 1 crosses their own remainder
    expect(res.selfTradeCanceledOrderIds).toEqual([own.orderId]);
    expect(res.fills).toEqual([]);
    expect(res.status).toBe('resting');
    // Level bookkeeping subtracted the 70 open, not the original 100.
    expect(engine.depth().asks).toEqual([]);
    expect(engine.bestAsk()).toBeUndefined();
  });

  it('rests a limit order whose only book interaction was a self-trade cancel', () => {
    sell(1, 50, 5000); // user 1's own quote is the entire opposite side
    const res = buy(1, 50, 5000);
    expect(res.status).toBe('resting');
    expect(res.fills).toEqual([]);
    expect(res.selfTradeCanceledOrderIds).toHaveLength(1);
    expect(res.restingQty).toBe(50);
    expect(engine.bestBid()).toBe(5000);
    expect(engine.bestAsk()).toBeUndefined();
  });

  it('does not cancel own orders at levels the incoming order never reaches', () => {
    sell(2, 50, 5000);
    const own = sell(1, 50, 5010); // behind the touch
    const res = buy(1, 50, 5000);
    expect(res.selfTradeCanceledOrderIds).toEqual([]);
    expect(res.fills[0]!.makerUserId).toBe(2);
    expect(engine.openQty(own.orderId)).toBe(50); // untouched
  });
});

describe('book state and depth bookkeeping', () => {
  it('aggregates depth per level, best price first on both sides', () => {
    buy(1, 10, 4990);
    buy(2, 20, 5000);
    buy(3, 30, 5000);
    sell(4, 40, 5010);
    sell(5, 50, 5020);
    expect(engine.depth()).toEqual({
      bids: [
        { price: 5000, qty: 50 },
        { price: 4990, qty: 10 },
      ],
      asks: [
        { price: 5010, qty: 40 },
        { price: 5020, qty: 50 },
      ],
    });
  });

  it('respects the requested number of depth levels', () => {
    for (let p = 1; p <= 5; p++) buy(1, 10, 5000 - p * 10);
    expect(engine.depth(2).bids).toEqual([
      { price: 4990, qty: 10 },
      { price: 4980, qty: 10 },
    ]);
  });

  it('depth reflects partial fills exactly', () => {
    sell(1, 100, 5000);
    buy(2, 37, 5000);
    expect(engine.depth().asks).toEqual([{ price: 5000, qty: 63 }]);
  });

  it('counts resting orders, excluding filled and canceled ones', () => {
    expect(engine.restingOrderCount()).toBe(0);
    buy(1, 10, 4990);
    const b = buy(2, 10, 5000);
    sell(3, 10, 5010);
    expect(engine.restingOrderCount()).toBe(3);
    engine.cancel(b.orderId);
    expect(engine.restingOrderCount()).toBe(2);
    buyMkt(4, 10); // fills the resting ask
    expect(engine.restingOrderCount()).toBe(1);
  });

  it('re-adding a price level after it empties works cleanly', () => {
    sell(1, 10, 5000);
    buyMkt(2, 10); // empties the 5000 level
    sell(3, 20, 5000); // re-create it
    expect(engine.depth().asks).toEqual([{ price: 5000, qty: 20 }]);
  });
});

describe('sequencing and IDs', () => {
  it('assigns strictly increasing order IDs', () => {
    const a = buy(1, 10, 5000);
    const b = sell(2, 10, 6000);
    expect(b.orderId).toBeGreaterThan(a.orderId);
  });

  it('assigns strictly increasing fill sequence numbers across submits', () => {
    sell(1, 10, 5000);
    sell(2, 10, 5000);
    const r1 = buy(3, 10, 5000);
    const r2 = buy(4, 10, 5000);
    expect(r2.fills[0]!.seq).toBeGreaterThan(r1.fills[0]!.seq);
  });

  it('is deterministic: identical input sequences produce identical fills', () => {
    const run = () => {
      const e = new MatchingEngine();
      const results = [
        e.submit(order(1, 'sell', 'limit', 50, 5010)),
        e.submit(order(2, 'sell', 'limit', 30, 5000)),
        e.submit(order(3, 'buy', 'limit', 100, 5010)),
        e.submit(order(4, 'sell', 'market', 40)),
        e.submit(order(1, 'buy', 'market', 25)),
      ];
      return JSON.stringify(results.map((r) => ({ s: r.status, f: r.fills })));
    };
    expect(run()).toBe(run());
  });
});

describe('stress-shaped sanity check', () => {
  it('keeps book invariants over a burst of mixed random-ish flow', () => {
    // Deterministic pseudo-random flow (LCG) — not a benchmark, a correctness
    // sweep: after every operation the spread must never be crossed.
    let state = 42;
    const rand = (n: number) => {
      state = (state * 1103515245 + 12345) & 0x7fffffff;
      return state % n;
    };
    for (let i = 0; i < 5000; i++) {
      const userId = 1 + rand(5);
      const side = rand(2) === 0 ? 'buy' : 'sell';
      if (rand(10) === 0) {
        engine.submit(order(userId, side, 'market', 1 + rand(50)));
      } else {
        engine.submit(order(userId, side, 'limit', 1 + rand(50), 4950 + rand(100)));
      }
      const bid = engine.bestBid();
      const ask = engine.bestAsk();
      if (bid !== undefined && ask !== undefined) {
        expect(bid).toBeLessThan(ask); // a resting book is never crossed
      }
    }
    // Depth totals must be non-negative and levels strictly ordered.
    const { bids, asks } = engine.depth(1000);
    for (const l of [...bids, ...asks]) expect(l.qty).toBeGreaterThan(0);
    for (let i = 1; i < bids.length; i++) {
      expect(bids[i]!.price).toBeLessThan(bids[i - 1]!.price);
    }
    for (let i = 1; i < asks.length; i++) {
      expect(asks[i]!.price).toBeGreaterThan(asks[i - 1]!.price);
    }
  });
});
