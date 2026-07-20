// presence.ts — a single timestamp of the last genuine client interaction, so
// background actors (liquidity bots, the retention job) can stand down when
// nobody is watching and let Neon's compute scale to zero (decisions.md D30).
// Why: on the free tier, continuous bot flow → write-behind flushing every
// 50ms → Neon never sees a 5-minute idle window → compute bills 24/7. Gating
// the writers on real demand is the fix.
// Key rule: the keep-warm health pinger must NOT count as activity — it is
// exactly the recurring non-visitor traffic, and counting it would defeat the
// whole mechanism. Only HTTP requests to real endpoints and WebSocket frames
// touch this (see app.ts / ws.ts).

/** No real request for this long → the market is idle and the writers pause. */
export const IDLE_PAUSE_MS = 5 * 60 * 1000;

export class Presence {
  /** Epoch ms of the last real interaction; -Infinity = none yet (starts idle
   *  for any clock value, not just a small `now`). */
  private lastActivityAt = Number.NEGATIVE_INFINITY;

  constructor(private readonly idleMs: number = IDLE_PAUSE_MS) {}

  /** Record a genuine client interaction. */
  touch(now: number = Date.now()): void {
    this.lastActivityAt = now;
  }

  /** True if a real client interacted within the idle window. */
  isActive(now: number = Date.now()): boolean {
    return now - this.lastActivityAt < this.idleMs;
  }

  get lastAt(): number {
    return this.lastActivityAt;
  }
}
