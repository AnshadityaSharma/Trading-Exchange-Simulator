// server.test.ts — integration tests: the full backend (HTTP + WS + Postgres)
// booted exactly as production boots it, exercised through the public API
// against docs/api-contract.md. Requires the dev Postgres container
// (docker run … postgres:17 on :5433); uses its own database `exchange_test`.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import WebSocket from 'ws';
import { boot, type Backend } from './boot.js';
import type { Config } from './config.js';

const ADMIN_URL = process.env.TEST_ADMIN_DATABASE_URL ?? 'postgres://postgres:exsim@localhost:5433/postgres';
const TEST_DB_URL = process.env.TEST_DATABASE_URL ?? 'postgres://postgres:exsim@localhost:5433/exchange_test';

// bots: false — these tests assert exact book states; bot flow would race them.
const config: Config = { port: 0, databaseUrl: TEST_DB_URL, jwtSecret: 'test-secret', bots: false };

let backend: Backend;
let base: string;

beforeAll(async () => {
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  const exists = await admin.query("SELECT 1 FROM pg_database WHERE datname = 'exchange_test'");
  if (exists.rowCount === 0) await admin.query('CREATE DATABASE exchange_test');
  await admin.end();

  const wipe = new pg.Client({ connectionString: TEST_DB_URL });
  await wipe.connect();
  await wipe.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await wipe.end();

  backend = await boot(config);
  base = `http://localhost:${backend.port}`;
}, 30_000);

afterAll(async () => {
  await backend.close();
});

// ------------------------------------------------------------------ helpers

async function api(
  method: string,
  path: string,
  opts: { body?: unknown; token?: string } = {},
): Promise<{ status: number; json: any }> {
  const res = await fetch(`${base}/api${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
    },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  return { status: res.status, json: await res.json() };
}

interface Session {
  token: string;
  userId: number;
}

let userCounter = 0;
async function newUser(): Promise<Session> {
  const email = `user${++userCounter}@test.dev`;
  const res = await api('POST', '/auth/signup', { body: { email, password: 'password123' } });
  expect(res.status).toBe(201);
  return { token: res.json.token, userId: res.json.user.id };
}

/** Give a user shares directly (tests only): positions normally enter via bots. */
function seedPosition(userId: number, symbol: string, qty: number, costBasis: number): void {
  backend.exchange.accounts.putPosition(userId, symbol, { qty, reservedQty: 0, costBasis, realizedPnl: 0 });
}

const buyLimit = (qty: number, price: number) => ({ instrument: 'ACME', side: 'buy', type: 'limit', qty, price });
const sellLimit = (qty: number, price: number) => ({ instrument: 'ACME', side: 'sell', type: 'limit', qty, price });

/** WS client that records every parsed frame. */
class WsProbe {
  readonly messages: any[] = [];
  private ws!: WebSocket;

  async connect(token?: string): Promise<void> {
    const url = `ws://localhost:${backend.port}/ws${token ? `?token=${token}` : ''}`;
    this.ws = new WebSocket(url);
    this.ws.on('message', (d) => this.messages.push(JSON.parse(String(d))));
    await new Promise<void>((resolve, reject) => {
      this.ws.once('open', resolve);
      this.ws.once('error', reject);
    });
  }

  send(msg: object): void {
    this.ws.send(JSON.stringify(msg));
  }

  /** Wait until a message matching the predicate arrives (or fail). */
  async waitFor(pred: (m: any) => boolean, ms = 2000): Promise<any> {
    const deadline = Date.now() + ms;
    for (;;) {
      const found = this.messages.find(pred);
      if (found) return found;
      if (Date.now() > deadline) throw new Error(`ws message not received; got ${JSON.stringify(this.messages)}`);
      await new Promise((r) => setTimeout(r, 10));
    }
  }

  close(): void {
    this.ws.close();
  }
}

// -------------------------------------------------------------------- tests

describe('health and auth', () => {
  it('reports health without auth', async () => {
    const res = await api('GET', '/health');
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ status: 'ok' });
  });

  it('deep health round-trips the database and says so', async () => {
    const res = await api('GET', '/health?deep=1');
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ status: 'ok', db: 'ok' });
  });

  it('signs up a user with starting cash and lets them log in', async () => {
    const res = await api('POST', '/auth/signup', { body: { email: 'ansh@test.dev', password: 'password123' } });
    expect(res.status).toBe(201);
    expect(res.json.token).toBeTruthy();

    const me = await api('GET', '/me', { token: res.json.token });
    expect(me.status).toBe(200);
    expect(me.json.cash).toBe(100_000_000);
    expect(me.json.reservedCash).toBe(0);
    expect(me.json.positions).toEqual([]);

    const login = await api('POST', '/auth/login', { body: { email: 'ansh@test.dev', password: 'password123' } });
    expect(login.status).toBe(200);
    expect(login.json.user.email).toBe('ansh@test.dev');
  });

  it('rejects duplicate email, bad credentials, and missing tokens', async () => {
    const dup = await api('POST', '/auth/signup', { body: { email: 'ansh@test.dev', password: 'password123' } });
    expect(dup.status).toBe(409);
    expect(dup.json.error.code).toBe('EMAIL_TAKEN');

    const bad = await api('POST', '/auth/login', { body: { email: 'ansh@test.dev', password: 'wrongpass1' } });
    expect(bad.status).toBe(401);
    expect(bad.json.error.code).toBe('INVALID_CREDENTIALS');

    const noAuth = await api('GET', '/me');
    expect(noAuth.status).toBe(401);
    expect(noAuth.json.error.code).toBe('UNAUTHORIZED');
  });

  it('rejects malformed signup bodies with VALIDATION', async () => {
    const res = await api('POST', '/auth/signup', { body: { email: 'not-an-email', password: 'short' } });
    expect(res.status).toBe(400);
    expect(res.json.error.code).toBe('VALIDATION');
  });
});

describe('market data endpoints', () => {
  it('lists instruments with metadata', async () => {
    const res = await api('GET', '/instruments');
    expect(res.status).toBe(200);
    const acme = res.json.instruments.find((i: any) => i.symbol === 'ACME');
    expect(acme).toMatchObject({ name: 'Acme Industries', priceScale: 100, tickSize: 5, lotSize: 1 });
  });

  it('serves an empty book and null stats before any trading', async () => {
    const book = await api('GET', '/instruments/GLXY/book');
    expect(book.json).toMatchObject({ symbol: 'GLXY', bids: [], asks: [] });

    const stats = await api('GET', '/instruments/GLXY/stats');
    expect(stats.json).toMatchObject({ lastPrice: null, open24h: null, high24h: null, low24h: null, volume24h: 0 });
  });

  it('404s unknown instruments', async () => {
    const res = await api('GET', '/instruments/NOPE/book');
    expect(res.status).toBe(404);
    expect(res.json.error.code).toBe('UNKNOWN_INSTRUMENT');
  });
});

describe('order validation and funds checks', () => {
  let s: Session;
  beforeAll(async () => {
    s = await newUser();
  });

  it('rejects off-tick prices, bad quantities, and market orders with a price', async () => {
    const offTick = await api('POST', '/orders', { token: s.token, body: buyLimit(10, 245001) });
    expect(offTick.status).toBe(400);
    expect(offTick.json.error.code).toBe('VALIDATION');

    const badQty = await api('POST', '/orders', { token: s.token, body: buyLimit(0, 245000) });
    expect(badQty.status).toBe(400);

    const marketWithPrice = await api('POST', '/orders', {
      token: s.token,
      body: { instrument: 'ACME', side: 'buy', type: 'market', qty: 1, price: 245000 },
    });
    expect(marketWithPrice.status).toBe(400);
  });

  it('rejects buys beyond cash with INSUFFICIENT_FUNDS and reserves nothing', async () => {
    const res = await api('POST', '/orders', { token: s.token, body: buyLimit(1000, 245000) }); // 245M > 100M cash
    expect(res.status).toBe(400);
    expect(res.json.error.code).toBe('INSUFFICIENT_FUNDS');
    const me = await api('GET', '/me', { token: s.token });
    expect(me.json.cash).toBe(100_000_000);
    expect(me.json.reservedCash).toBe(0);
  });

  it('rejects sells without position (no short selling)', async () => {
    const res = await api('POST', '/orders', { token: s.token, body: sellLimit(1, 245000) });
    expect(res.status).toBe(400);
    expect(res.json.error.code).toBe('INSUFFICIENT_POSITION');
  });

  it('rejects market buys against an empty book with VALIDATION', async () => {
    const res = await api('POST', '/orders', { token: s.token, body: { instrument: 'ACME', side: 'buy', type: 'market', qty: 1 } });
    expect(res.status).toBe(400);
    expect(res.json.error.code).toBe('VALIDATION');
  });
});

describe('the full trade flow', () => {
  let buyer: Session;
  let seller: Session;

  beforeAll(async () => {
    buyer = await newUser();
    seller = await newUser();
    seedPosition(seller.userId, 'ACME', 1000, 1000 * 240_000);
  });

  it('rests a sell, reserves position, and shows it in the book', async () => {
    const res = await api('POST', '/orders', { token: seller.token, body: sellLimit(100, 245_000) });
    expect(res.status).toBe(201);
    expect(res.json.order.status).toBe('open');
    expect(res.json.fills).toEqual([]);

    const me = await api('GET', '/me', { token: seller.token });
    expect(me.json.positions[0]).toMatchObject({ instrument: 'ACME', qty: 1000, reservedQty: 100 });

    const book = await api('GET', '/instruments/ACME/book');
    expect(book.json.asks).toEqual([[245_000, 100]]);
  });

  it('fills a crossing buy at the resting price with exact accounting on both sides', async () => {
    const res = await api('POST', '/orders', { token: buyer.token, body: buyLimit(40, 245_100) });
    expect(res.status).toBe(201);
    expect(res.json.order.status).toBe('filled');
    expect(res.json.fills).toEqual([expect.objectContaining({ price: 245_000, qty: 40 })]); // price improvement
    expect(res.json.order.filledNotional).toBe(40 * 245_000);

    const buyerMe = await api('GET', '/me', { token: buyer.token });
    expect(buyerMe.json.cash).toBe(100_000_000 - 40 * 245_000);
    expect(buyerMe.json.reservedCash).toBe(0); // improvement refunded
    expect(buyerMe.json.positions[0]).toMatchObject({ instrument: 'ACME', qty: 40, costBasis: 40 * 245_000 });

    const sellerMe = await api('GET', '/me', { token: seller.token });
    expect(sellerMe.json.cash).toBe(100_000_000 + 40 * 245_000);
    const pos = sellerMe.json.positions[0];
    expect(pos.qty).toBe(960);
    expect(pos.reservedQty).toBe(60);
    // Sold 40 of 1000 shares bought at 240000: basis out = 40×240000.
    expect(pos.costBasis).toBe(960 * 240_000);
    expect(pos.realizedPnl).toBe(40 * (245_000 - 240_000));
  });

  it('reports the partial fill on the resting order and the trade in stats/tape', async () => {
    await backend.wb.flush();
    const orders = await api('GET', '/orders?instrument=ACME&status=open', { token: seller.token });
    expect(orders.json.orders).toHaveLength(1);
    expect(orders.json.orders[0]).toMatchObject({ status: 'partially_filled', filledQty: 40 });

    const stats = await api('GET', '/instruments/ACME/stats');
    expect(stats.json).toMatchObject({ lastPrice: 245_000, volume24h: 40, high24h: 245_000, low24h: 245_000 });

    const trades = await api('GET', '/instruments/ACME/trades');
    expect(trades.json.trades[0]).toMatchObject({ price: 245_000, qty: 40, takerSide: 'buy', seq: 1 });
  });

  it('cancels the remainder and releases the reservation exactly', async () => {
    await backend.wb.flush();
    const open = await api('GET', '/orders?status=open', { token: seller.token });
    const orderId = open.json.orders[0].id;

    const res = await api('DELETE', `/orders/${orderId}`, { token: seller.token });
    expect(res.status).toBe(200);
    expect(res.json.order.status).toBe('canceled');
    expect(res.json.order.filledQty).toBe(40); // fills preserved

    const me = await api('GET', '/me', { token: seller.token });
    expect(me.json.positions[0].reservedQty).toBe(0);

    await backend.wb.flush();
    const again = await api('DELETE', `/orders/${orderId}`, { token: seller.token });
    expect(again.status).toBe(409);
    expect(again.json.error.code).toBe('ORDER_NOT_OPEN');

    const notMine = await api('DELETE', `/orders/${orderId}`, { token: buyer.token });
    expect(notMine.status).toBe(404);

    const unknown = await api('DELETE', '/orders/ord_doesnotexist', { token: buyer.token });
    expect(unknown.status).toBe(404);
  });

  it('persists orders and fills queryable by id, with maker/taker roles', async () => {
    await backend.wb.flush();
    const fills = await api('GET', '/fills?instrument=ACME', { token: buyer.token });
    expect(fills.json.fills).toHaveLength(1);
    expect(fills.json.fills[0]).toMatchObject({ role: 'taker', side: 'buy', price: 245_000, qty: 40 });

    const order = await api('GET', `/orders/${fills.json.fills[0].orderId}`, { token: buyer.token });
    expect(order.status).toBe(200);
    expect(order.json.fills).toEqual([expect.objectContaining({ price: 245_000, qty: 40 })]);

    // Another user's order id is a 404, not a 403 (no existence leak).
    const foreign = await api('GET', `/orders/${fills.json.fills[0].orderId}`, { token: seller.token });
    expect(foreign.status).toBe(404);
  });

  it('explains endpoint returns a real rule-based explanation with no API key', async () => {
    // No ANTHROPIC_API_KEY in the test config → the offline RuleBasedExplainer,
    // so the demo path produces a genuine explanation at zero API cost.
    await backend.wb.flush();
    const fills = await api('GET', '/fills', { token: buyer.token });
    const res = await api('GET', `/orders/${fills.json.fills[0].orderId}/explain`, { token: buyer.token });
    expect(res.status).toBe(200);
    expect(typeof res.json.explanation).toBe('string');
    expect(res.json.explanation.length).toBeGreaterThan(0);
    expect(res.json.explanation).toContain('ACME');
    expect(typeof res.json.generatedAt).toBe('string');
  });
});

describe('market orders', () => {
  let buyer: Session;
  let seller: Session;

  beforeAll(async () => {
    buyer = await newUser();
    seller = await newUser();
    seedPosition(seller.userId, 'GLXY', 500, 500 * 87_000);
    await api('POST', '/orders', { token: seller.token, body: { instrument: 'GLXY', side: 'sell', type: 'limit', qty: 30, price: 87_500 } });
    await api('POST', '/orders', { token: seller.token, body: { instrument: 'GLXY', side: 'sell', type: 'limit', qty: 30, price: 87_600 } });
  });

  it('sweeps multiple levels and pays exact costs per level', async () => {
    const res = await api('POST', '/orders', { token: buyer.token, body: { instrument: 'GLXY', side: 'buy', type: 'market', qty: 50 } });
    expect(res.status).toBe(201);
    expect(res.json.order.status).toBe('filled');
    expect(res.json.fills).toEqual([
      expect.objectContaining({ price: 87_500, qty: 30 }),
      expect.objectContaining({ price: 87_600, qty: 20 }),
    ]);
    const me = await api('GET', '/me', { token: buyer.token });
    expect(me.json.cash).toBe(100_000_000 - 30 * 87_500 - 20 * 87_600);
  });

  it('cancels the unfilled remainder of an oversized market order', async () => {
    const res = await api('POST', '/orders', { token: buyer.token, body: { instrument: 'GLXY', side: 'buy', type: 'market', qty: 100 } });
    expect(res.json.order.status).toBe('canceled');
    expect(res.json.order.filledQty).toBe(10); // only 10 remained on the book
    const me = await api('GET', '/me', { token: buyer.token });
    expect(me.json.reservedCash).toBe(0);
  });

  it('releases the position reservation on a market sell remainder', async () => {
    // Book is now empty; buyer holds 60 GLXY. Market sell 60 → nothing to hit.
    const res = await api('POST', '/orders', { token: buyer.token, body: { instrument: 'GLXY', side: 'sell', type: 'market', qty: 60 } });
    expect(res.json.order.status).toBe('canceled');
    expect(res.json.order.filledQty).toBe(0);
    const me = await api('GET', '/me', { token: buyer.token });
    expect(me.json.positions.find((p: any) => p.instrument === 'GLXY').reservedQty).toBe(0);
  });
});

describe('maker-side accounting when the resting order is a buy', () => {
  it('releases the maker buyer reservation at the limit and refunds improvement', async () => {
    const maker = await newUser();
    const taker = await newUser();
    seedPosition(taker.userId, 'NIMB', 100, 100 * 40_000);

    // Maker rests a BUY at 41_200 (reserves 50 × 41_200 cash).
    const rest = await api('POST', '/orders', { token: maker.token, body: { instrument: 'NIMB', side: 'buy', type: 'limit', qty: 50, price: 41_200 } });
    expect(rest.json.order.status).toBe('open');
    const afterRest = await api('GET', '/me', { token: maker.token });
    expect(afterRest.json.reservedCash).toBe(50 * 41_200);

    // Taker sells into it; maker is the resting buyer (the untested branch).
    const hit = await api('POST', '/orders', { token: taker.token, body: { instrument: 'NIMB', side: 'sell', type: 'limit', qty: 50, price: 41_200 } });
    expect(hit.json.order.status).toBe('filled');

    const makerMe = await api('GET', '/me', { token: maker.token });
    expect(makerMe.json.reservedCash).toBe(0); // reservation fully released
    expect(makerMe.json.cash).toBe(100_000_000 - 50 * 41_200); // spent at fill price
    expect(makerMe.json.positions.find((p: any) => p.instrument === 'NIMB')).toMatchObject({ qty: 50, costBasis: 50 * 41_200 });

    // Cleanup so later NIMB tests see a flat book/position isn't required — new users.
  });
});

describe('market buy against your own resting asks (negative-cash regression)', () => {
  it('excludes own liquidity from the funds precheck and never overspends', async () => {
    const a = await newUser();
    const b = await newUser();
    seedPosition(a.userId, 'NIMB', 100, 100 * 41_000);
    seedPosition(b.userId, 'NIMB', 100, 100 * 41_000);

    // a's own cheap ask, and b's expensive ask deeper in the book.
    await api('POST', '/orders', { token: a.token, body: { instrument: 'NIMB', side: 'sell', type: 'limit', qty: 10, price: 41_200 } });
    await api('POST', '/orders', { token: b.token, body: { instrument: 'NIMB', side: 'sell', type: 'limit', qty: 10, price: 50_000 } });

    // a market-buys 20: STP cancels a's own 10@41200, so it can only fill
    // 10@50000 from b. Must never count a's own ask as spendable liquidity.
    const res = await api('POST', '/orders', { token: a.token, body: { instrument: 'NIMB', side: 'buy', type: 'market', qty: 20 } });
    expect(res.status).toBe(201);
    expect(res.json.fills).toEqual([expect.objectContaining({ price: 50_000, qty: 10 })]);

    const me = await api('GET', '/me', { token: a.token });
    expect(me.json.cash).toBeGreaterThanOrEqual(0); // the bug drove this negative
    expect(me.json.cash).toBe(100_000_000 - 10 * 50_000);
    expect(me.json.reservedCash).toBe(0);
  });
});

describe('self-trade prevention through the API', () => {
  it('cancels the resting order, refunds its reservation, and reports it', async () => {
    const s = await newUser();
    seedPosition(s.userId, 'NIMB', 100, 100 * 41_000);

    const resting = await api('POST', '/orders', { token: s.token, body: { instrument: 'NIMB', side: 'sell', type: 'limit', qty: 50, price: 41_200 } });
    const cross = await api('POST', '/orders', { token: s.token, body: { instrument: 'NIMB', side: 'buy', type: 'limit', qty: 50, price: 41_200 } });

    expect(cross.status).toBe(201);
    expect(cross.json.fills).toEqual([]); // no self-fill
    expect(cross.json.order.status).toBe('open'); // rests after own quote canceled

    const me = await api('GET', '/me', { token: s.token });
    expect(me.json.positions.find((p: any) => p.instrument === 'NIMB').reservedQty).toBe(0); // sell reservation released
    expect(me.json.reservedCash).toBe(50 * 41_200); // buy still resting

    await backend.wb.flush();
    const old = await api('GET', `/orders/${resting.json.order.id}`, { token: s.token });
    expect(old.json.order.status).toBe('canceled');

    // Clean up the resting buy so later tests see a flat NIMB book.
    await api('DELETE', `/orders/${cross.json.order.id}`, { token: s.token });
  });
});

describe('pagination', () => {
  it('walks orders with the before cursor', async () => {
    const s = await newUser();
    for (let i = 0; i < 5; i++) {
      await api('POST', '/orders', { token: s.token, body: buyLimit(1, 240_000 - i * 5) });
    }
    await backend.wb.flush();

    const page1 = await api('GET', '/orders?limit=2', { token: s.token });
    expect(page1.json.orders).toHaveLength(2);
    expect(page1.json.nextBefore).toBe(page1.json.orders[1].id);

    const page2 = await api('GET', `/orders?limit=2&before=${page1.json.nextBefore}`, { token: s.token });
    expect(page2.json.orders).toHaveLength(2);
    const ids = new Set([...page1.json.orders, ...page2.json.orders].map((o: any) => o.id));
    expect(ids.size).toBe(4); // no overlap between pages

    const page3 = await api('GET', `/orders?limit=2&before=${page2.json.nextBefore}`, { token: s.token });
    expect(page3.json.orders).toHaveLength(1);
    expect(page3.json.nextBefore).toBeNull();

    for (const o of [...page1.json.orders, ...page2.json.orders, ...page3.json.orders]) {
      await api('DELETE', `/orders/${o.id}`, { token: s.token });
    }
  });
});

describe('websocket layer', () => {
  it('handshakes, acks subscriptions, and rejects unknown channels', async () => {
    const probe = new WsProbe();
    await probe.connect();
    await probe.waitFor((m) => m.type === 'hello' && m.authenticated === false);

    probe.send({ type: 'ping' });
    await probe.waitFor((m) => m.type === 'pong');

    probe.send({ type: 'subscribe', channel: 'book:NOPE' });
    await probe.waitFor((m) => m.type === 'error' && m.code === 'UNKNOWN_CHANNEL');

    probe.send({ type: 'subscribe', channel: 'user' });
    await probe.waitFor((m) => m.type === 'error' && m.code === 'UNAUTHORIZED');
    probe.close();
  });

  it('delivers snapshot then gap-free deltas that reconstruct the REST book', async () => {
    const s = await newUser();
    const probe = new WsProbe();
    await probe.connect();
    probe.send({ type: 'subscribe', channel: 'book:ACME' });
    const snap = await probe.waitFor((m) => m.type === 'book_snapshot');

    const o1 = await api('POST', '/orders', { token: s.token, body: buyLimit(10, 244_000) });
    const o2 = await api('POST', '/orders', { token: s.token, body: buyLimit(5, 244_100) });
    await api('DELETE', `/orders/${o1.json.order.id}`, { token: s.token });

    await probe.waitFor((m) => m.type === 'book_delta' && m.bids.some((b: number[]) => b[0] === 244_000 && b[1] === 0));

    // Deltas must be exactly consecutive from the snapshot seq.
    const deltas = probe.messages.filter((m) => m.type === 'book_delta');
    deltas.forEach((d, i) => expect(d.seq).toBe(snap.seq + i + 1));

    // Applying deltas over the snapshot must equal the REST book.
    const book = new Map<number, number>(snap.bids.map((b: number[]) => [b[0], b[1]]));
    for (const d of deltas) for (const [p, q] of d.bids) q === 0 ? book.delete(p) : book.set(p, q);
    const rest = await api('GET', '/instruments/ACME/book');
    expect([...book.entries()].sort((a, b) => b[0] - a[0])).toEqual(rest.json.bids);

    await api('DELETE', `/orders/${o2.json.order.id}`, { token: s.token });
    probe.close();
  });

  it('streams trades and private fills/order updates to the right users', async () => {
    const buyer = await newUser();
    const seller = await newUser();
    seedPosition(seller.userId, 'ACME', 100, 100 * 240_000);

    const sellerProbe = new WsProbe();
    await sellerProbe.connect(seller.token);
    await sellerProbe.waitFor((m) => m.type === 'hello' && m.authenticated === true);
    sellerProbe.send({ type: 'subscribe', channel: 'user' });
    await sellerProbe.waitFor((m) => m.type === 'subscribed');

    const tapeProbe = new WsProbe();
    await tapeProbe.connect();
    tapeProbe.send({ type: 'subscribe', channel: 'trades:ACME' });
    await tapeProbe.waitFor((m) => m.type === 'subscribed');

    await api('POST', '/orders', { token: seller.token, body: sellLimit(20, 246_000) });
    await api('POST', '/orders', { token: buyer.token, body: buyLimit(20, 246_000) });

    const trade = await tapeProbe.waitFor((m) => m.type === 'trade');
    expect(trade).toMatchObject({ symbol: 'ACME', price: 246_000, qty: 20, takerSide: 'buy' });

    const fill = await sellerProbe.waitFor((m) => m.type === 'fill');
    expect(fill.fill).toMatchObject({ instrument: 'ACME', side: 'sell', role: 'maker', price: 246_000, qty: 20 });
    const update = await sellerProbe.waitFor((m) => m.type === 'order_update' && m.order.status === 'filled');
    expect(update.order.filledQty).toBe(20);

    sellerProbe.close();
    tapeProbe.close();
  });
});

describe('restart reconciliation', () => {
  it('cancels orphaned open orders and releases reservations on reboot', async () => {
    const s = await newUser();
    const res = await api('POST', '/orders', { token: s.token, body: buyLimit(10, 243_000) });
    expect(res.json.order.status).toBe('open');
    const meBefore = await api('GET', '/me', { token: s.token });
    expect(meBefore.json.reservedCash).toBe(10 * 243_000);

    await backend.close(); // flushes write-behind

    backend = await boot(config); // same DB — a fresh process
    base = `http://localhost:${backend.port}`;
    expect(backend.reconciledOrders).toBeGreaterThan(0);

    const login = await api('POST', '/auth/login', { body: { email: `user${userCounter}@test.dev`, password: 'password123' } });
    const meAfter = await api('GET', '/me', { token: login.json.token });
    expect(meAfter.json.reservedCash).toBe(0);
    expect(meAfter.json.cash).toBe(100_000_000);

    await backend.wb.flush();
    const orders = await api('GET', '/orders?status=open', { token: login.json.token });
    expect(orders.json.orders).toEqual([]);

    const all = await api('GET', '/orders?status=canceled', { token: login.json.token });
    expect(all.json.orders.some((o: any) => o.id === res.json.order.id)).toBe(true);
  });
});
