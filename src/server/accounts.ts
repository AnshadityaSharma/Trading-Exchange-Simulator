// accounts.ts — in-memory account state: cash, reservations, positions.
// Why: funds/position checks sit on the order hot path, so they must be
// memory-speed. This module is the runtime source of truth; Postgres is the
// durable copy, journaled through the write-behind queue and reloaded at boot.
// Key tradeoff: all mutations here are synchronous integer arithmetic — no
// locks needed because the whole exchange runs on one thread (decisions.md).
//
// Reservation model (api-contract.md "Trading rules"):
// - buy limit: reserves price×qty cash at submit; fills release the
//   reservation at the LIMIT price and spend at the FILL price (difference
//   refunds to cash — price improvement goes back to the buyer).
// - sell: reserves position qty (no shorting).
// - buy market: no reservation — the exact sweep cost is checked against the
//   live book synchronously and the order executes in the same tick.

export interface Position {
  qty: number;
  reservedQty: number;
  costBasis: number; // total paise paid for the open qty
  realizedPnl: number;
}

export interface Account {
  userId: number;
  cash: number; // spendable (reservations excluded)
  reservedCash: number;
  positions: Map<string, Position>;
}

const emptyPosition = (): Position => ({ qty: 0, reservedQty: 0, costBasis: 0, realizedPnl: 0 });

export class Accounts {
  private readonly accounts = new Map<number, Account>();

  /** Boot / signup: register an account with known balances. */
  put(userId: number, cash: number, reservedCash = 0): Account {
    const acct: Account = { userId, cash, reservedCash, positions: new Map() };
    this.accounts.set(userId, acct);
    return acct;
  }

  putPosition(userId: number, symbol: string, pos: Position): void {
    this.get(userId).positions.set(symbol, pos);
  }

  get(userId: number): Account {
    const acct = this.accounts.get(userId);
    if (!acct) throw new Error(`no account loaded for user ${userId}`);
    return acct;
  }

  position(userId: number, symbol: string): Position {
    const acct = this.get(userId);
    let pos = acct.positions.get(symbol);
    if (!pos) {
      pos = emptyPosition();
      acct.positions.set(symbol, pos);
    }
    return pos;
  }

  /** True if the reservation was made; false = insufficient cash. */
  tryReserveCash(userId: number, amount: number): boolean {
    const acct = this.get(userId);
    if (acct.cash < amount) return false;
    acct.cash -= amount;
    acct.reservedCash += amount;
    return true;
  }

  releaseCash(userId: number, amount: number): void {
    const acct = this.get(userId);
    acct.reservedCash -= amount;
    acct.cash += amount;
  }

  /** True if the position qty was reserved; false = insufficient free position. */
  tryReservePosition(userId: number, symbol: string, qty: number): boolean {
    const pos = this.position(userId, symbol);
    if (pos.qty - pos.reservedQty < qty) return false;
    pos.reservedQty += qty;
    return true;
  }

  releasePosition(userId: number, symbol: string, qty: number): void {
    this.position(userId, symbol).reservedQty -= qty;
  }

  /**
   * Buyer got `qty` at `fillPrice`. If the buy was reserved (limit order),
   * `reservedAtPrice` is the limit price: the reservation is released at that
   * price and the difference vs the fill price refunds to cash. Market buys
   * (`reservedAtPrice === null`) pay straight from cash.
   */
  applyBuyFill(
    userId: number,
    symbol: string,
    fillPrice: number,
    qty: number,
    reservedAtPrice: number | null,
  ): void {
    const acct = this.get(userId);
    const cost = fillPrice * qty;
    if (reservedAtPrice !== null) {
      acct.reservedCash -= reservedAtPrice * qty;
      acct.cash += reservedAtPrice * qty - cost;
    } else {
      acct.cash -= cost;
    }
    const pos = this.position(userId, symbol);
    pos.qty += qty;
    pos.costBasis += cost;
  }

  /**
   * Seller delivered `qty` at `fillPrice` from reserved position. Cost basis
   * leaves proportionally (exact integer: the final lot takes any rounding
   * residue so costBasis is exactly 0 when qty reaches 0); realized P&L is
   * proceeds minus the removed basis.
   */
  applySellFill(userId: number, symbol: string, fillPrice: number, qty: number): void {
    const pos = this.position(userId, symbol);
    const removedBasis =
      qty === pos.qty ? pos.costBasis : Math.floor((pos.costBasis * qty) / pos.qty);
    pos.qty -= qty;
    pos.reservedQty -= qty;
    pos.costBasis -= removedBasis;
    pos.realizedPnl += fillPrice * qty - removedBasis;
    this.get(userId).cash += fillPrice * qty;
  }
}
