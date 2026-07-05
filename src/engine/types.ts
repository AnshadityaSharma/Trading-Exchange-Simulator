// types.ts — shared types for the matching engine.
// Why: one place for the engine's public vocabulary; the engine itself is
// dependency-free and pure, so these types are the entire surface the rest
// of the app sees.
// Key tradeoff: prices and quantities are integers (ticks / whole units).
// Floating point in a matching engine invites rounding bugs in money math;
// integer ticks make every comparison and sum exact. The API layer owns
// converting display prices (e.g. rupees) to ticks (e.g. paise).

export type Side = 'buy' | 'sell';

export type OrderType = 'limit' | 'market';

/** What a caller submits. The engine assigns the order ID. */
export interface OrderInput {
  userId: number;
  side: Side;
  type: OrderType;
  /** Integer ticks. Required for limit orders; ignored for market orders. */
  price?: number;
  /** Integer, > 0. */
  qty: number;
}

/** One execution between an incoming (taker) order and a resting (maker) order. */
export interface Fill {
  /** Always the resting order's price — the taker gets price improvement. */
  price: number;
  qty: number;
  makerOrderId: number;
  takerOrderId: number;
  makerUserId: number;
  takerUserId: number;
  /** Engine-wide monotonic sequence number; total-orders each event. */
  seq: number;
}

/**
 * Terminal state of a submit() call, from the incoming order's perspective:
 * - 'filled':            fully executed
 * - 'resting':           no fill, now on the book (limit only)
 * - 'partial-resting':   partially executed, remainder on the book (limit only)
 * - 'partial-canceled':  partially executed, remainder canceled (market only)
 * - 'canceled':          no fill possible, nothing rested (market on empty book)
 */
export type SubmitStatus =
  | 'filled'
  | 'resting'
  | 'partial-resting'
  | 'partial-canceled'
  | 'canceled';

export interface SubmitResult {
  orderId: number;
  status: SubmitStatus;
  fills: Fill[];
  /** Quantity left on the book (0 unless status is resting / partial-resting). */
  restingQty: number;
  /**
   * Resting orders of the SAME user that the incoming order would have matched.
   * Self-trade prevention cancels them (cancel-resting policy) and matching
   * continues against the next order in priority.
   */
  selfTradeCanceledOrderIds: number[];
}

/** One price level of aggregated depth, for book snapshots. */
export interface DepthLevel {
  price: number;
  qty: number;
}

export interface Depth {
  /** Best (highest) bid first. */
  bids: DepthLevel[];
  /** Best (lowest) ask first. */
  asks: DepthLevel[];
}
