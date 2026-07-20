// presence.test.ts — the demand signal that lets bots/retention idle (D30).
// Pure logic, no DB: time is injected so the window is deterministic.

import { describe, expect, it } from 'vitest';
import { Presence } from './presence.js';

describe('Presence', () => {
  it('starts idle (no activity since boot), for any clock value', () => {
    const p = new Presence(1000);
    expect(p.isActive(0)).toBe(false);
    expect(p.isActive(5_000)).toBe(false);
    expect(p.isActive(Date.now())).toBe(false);
  });

  it('is active within the window after a touch, idle after it lapses', () => {
    const p = new Presence(1000);
    p.touch(10_000);
    expect(p.isActive(10_000)).toBe(true);
    expect(p.isActive(10_999)).toBe(true); // inside the window
    expect(p.isActive(11_000)).toBe(false); // exactly one window later → lapsed
    expect(p.isActive(50_000)).toBe(false);
  });

  it('each touch slides the window forward', () => {
    const p = new Presence(1000);
    p.touch(10_000);
    p.touch(10_800); // a client frame just before the old window would lapse
    expect(p.isActive(11_500)).toBe(true); // kept alive by the second touch
  });
});
