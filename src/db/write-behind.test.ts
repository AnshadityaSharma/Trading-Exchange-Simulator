// write-behind.test.ts — the failure-recovery contract of the persistence
// queue, tested against a fake pool (no real database). The blocking bug the
// Phase 3 review caught: a connect() rejection outside the try/catch lost the
// batch, wedged the flush chain forever, and crashed the process.

import { describe, expect, it, vi } from 'vitest';
import { WriteBehind, type OrderRow } from './write-behind.js';

const order = (id: string, status = 'open'): OrderRow => ({
  id, userId: 1, symbol: 'ACME', side: 'buy', type: 'limit', price: 100, qty: 10,
  filledQty: 0, filledNotional: 0, status, createdAt: new Date(), updatedAt: new Date(),
});

/** A fake pg.Pool whose connect() fails the first N calls, then succeeds. */
function fakePool(failFirst: number) {
  const executed: string[] = [];
  let connects = 0;
  const client = {
    query: vi.fn(async (sql: string, _params?: unknown[]) => {
      executed.push(sql.trim().split(/\s+/).slice(0, 2).join(' '));
      return { rowCount: 0, rows: [] };
    }),
    release: vi.fn(),
  };
  const pool = {
    connect: vi.fn(async () => {
      connects++;
      if (connects <= failFirst) throw new Error('DB is down');
      return client;
    }),
  };
  return { pool: pool as never, executed, client, connectCount: () => connects };
}

describe('write-behind failure recovery', () => {
  it('re-queues the batch and keeps flushing after a connect() failure', async () => {
    const { pool, executed, connectCount } = fakePool(1); // first flush fails

    const wb = new WriteBehind(pool);
    wb.upsertOrder(order('ord_1'));

    await wb.flush(); // connect() rejects; batch must survive, no throw
    expect(connectCount()).toBe(1);
    expect(executed).toEqual([]); // nothing committed

    await wb.flush(); // second attempt succeeds and drains the re-queued row
    expect(connectCount()).toBe(2);
    expect(executed).toContain('INSERT INTO'); // the order was written
    expect(executed).toContain('COMMIT');
  });

  it('flush() never rejects, so the timer cannot leak unhandled rejections', async () => {
    const { pool } = fakePool(3); // fails more times than we call
    const wb = new WriteBehind(pool);
    wb.upsertOrder(order('ord_1'));

    // None of these should reject even though every underlying flush fails.
    await expect(wb.flush()).resolves.toBeUndefined();
    await expect(wb.flush()).resolves.toBeUndefined();
    await expect(wb.flush()).resolves.toBeUndefined();
  });

  it('coalesces repeated updates to one row (latest wins) within a flush', async () => {
    const { pool, client } = fakePool(0);
    const wb = new WriteBehind(pool);
    wb.upsertOrder(order('ord_1', 'open'));
    wb.upsertOrder(order('ord_1', 'filled')); // supersedes the first

    await wb.flush();
    const orderInserts = client.query.mock.calls.filter((c) => String(c[0]).includes('INTO orders'));
    expect(orderInserts).toHaveLength(1); // one write, not two
    expect(orderInserts[0]![1]).toContain('filled'); // params carry the latest state
  });
});
