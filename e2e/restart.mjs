// e2e/restart.mjs — mid-session backend-restart recovery test for the real
// frontend (web/) in a real headless browser. Verifies the client-side rules
// the API contract demands: the reconnect loop survives an outage, every
// channel is resubscribed on reconnect, the fresh book snapshot fully
// replaces stale levels (even though the new engine's seq space restarted),
// reconciled-away open orders vanish, and reserved cash returns.
// Run: `npm run build && node e2e/restart.mjs` (needs the dev Postgres and
// Microsoft Edge; override the browser with EDGE_PATH). Exits 0 on pass.
// Why not vitest: this owns a server *process* (kills and restarts it) and a
// browser — process-level orchestration, deliberately outside the unit suite.

import { spawn } from 'node:child_process';
import puppeteer from 'puppeteer-core';

const EDGE = process.env.EDGE_PATH ?? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const URL = 'http://localhost:3000';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function startServer() {
  return new Promise((resolve, reject) => {
    const child = spawn('node', ['dist/src/server/index.js'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => {
      out += String(d);
      if (out.includes('exchange listening')) resolve(child);
    });
    child.stderr.on('data', (d) => process.stderr.write('[server] ' + d));
    child.on('exit', (code) => { if (!out.includes('listening')) reject(new Error('server died at boot: ' + code + '\n' + out)); });
    setTimeout(() => reject(new Error('server boot timeout\n' + out)), 15000);
  });
}

const steps = [];
const step = (name, data) => { steps.push({ name, ...data }); console.log('STEP', name, JSON.stringify(data)); };

let server = await startServer();
const browser = await puppeteer.launch({ executablePath: EDGE, headless: true });
try {
  const page = await browser.newPage();
  await page.goto(URL, { waitUntil: 'networkidle2' });

  // Grab the live component instance: paint() runs on every state change, so
  // patching it on the prototype captures `this` at the first keystroke.
  await page.waitForFunction(() => {
    const r = window.__dcRegistry;
    const root = r && (r.get ? r.get('Root') : r['Root']);
    return !!(root && root.Logic);
  }, { timeout: 15000 });
  await page.evaluate(() => {
    const Logic = window.__dcRegistry.get ? window.__dcRegistry.get('Root').Logic : window.__dcRegistry['Root'].Logic;
    const origPaint = Logic.prototype.paint;
    Logic.prototype.paint = function () { window.__cap = this; return origPaint.call(this); };
  });

  // Fresh signup via component state (the form UI itself is exercised in
  // interactive verification; this test's subject is restart recovery).
  const email = 'restart-' + Date.now() + '@test.dev';
  await page.waitForSelector('input[type=email]');
  await page.type('input[type=email]', 'x'); // one keystroke → paint → instance captured
  await page.waitForFunction(() => !!window.__cap, { timeout: 5000 });
  await page.evaluate((em) => {
    const c = window.__cap;
    c.email = em; c.password = 'restartpass1';
    return c.submitAuth({ preventDefault() {} });
  }, email);
  await page.waitForFunction(() => window.__cap.conn === 'live' && !window.__cap.bookSyncing, { timeout: 15000 });
  step('terminal_live', await page.evaluate(() => ({ conn: window.__cap.conn, bookSeq: window.__cap.bookSeq, bids: window.__cap.bidMap.size, asks: window.__cap.askMap.size })));

  // Rest a far-from-touch limit buy; it must be reconciled away by the restart.
  const placed = await page.evaluate(async () => {
    const c = window.__cap;
    const H = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + c.token };
    const r = await fetch('/api/orders', { method: 'POST', headers: H, body: JSON.stringify({ instrument: 'ACME', side: 'buy', type: 'limit', price: 240000, qty: 5 }) }).then((x) => x.json());
    await new Promise((res) => setTimeout(res, 700));
    const me = await fetch('/api/me', { headers: H }).then((x) => x.json());
    return { id: r.order.id, status: r.order.status, inClientOpenOrders: c.openOrders.some((o) => o.id === r.order.id), reservedCash: me.reservedCash };
  });
  step('order_resting', placed);
  if (!placed.inClientOpenOrders || placed.reservedCash !== 1200000) throw new Error('precondition failed: ' + JSON.stringify(placed));

  // ---- restart mid-session ----
  server.kill('SIGKILL');
  await sleep(300);
  await page.waitForFunction(() => window.__cap.conn === 'reconnecting' || window.__cap.conn === 'connecting', { timeout: 5000 });
  await sleep(3500); // hold the outage across several retry attempts
  step('during_outage', await page.evaluate(() => ({ conn: window.__cap.conn, staleOpenOrders: window.__cap.openOrders.length })));

  server = await startServer(); // fresh process, same DB — boot reconciles orphans
  await page.waitForFunction(() => window.__cap.conn === 'live' && !window.__cap.bookSyncing, { timeout: 20000 });
  await sleep(1200); // let the reconnect resync (orders/me/tape/stats) land

  // The client book must exactly equal a REST snapshot at the same seq —
  // proves the fresh snapshot replaced ALL stale levels.
  let bookCheck = null;
  for (let i = 0; i < 6 && !bookCheck; i++) {
    bookCheck = await page.evaluate(async () => {
      const c = window.__cap;
      const snap = await fetch('/api/instruments/ACME/book?depth=50').then((r) => r.json());
      if (snap.seq !== c.bookSeq) return null; // book moved between reads; retry
      const same = (m, levels) => m.size === levels.length && levels.every(([p, q]) => m.get(p) === q);
      return { seq: snap.seq, bidsMatch: same(c.bidMap, snap.bids), asksMatch: same(c.askMap, snap.asks) };
    });
    if (!bookCheck) await sleep(400);
  }
  step('book_after_restart', bookCheck ?? { error: 'seq never aligned' });

  const post = await page.evaluate(async () => {
    const c = window.__cap;
    const me = await fetch('/api/me', { headers: { Authorization: 'Bearer ' + c.token } }).then((x) => x.json());
    return { conn: c.conn, openOrders: c.openOrders.length, reservedCash: me.reservedCash, tradeSeqNow: c.tradeSeq, lastEvent: c.lastEvent };
  });
  step('state_after_restart', post);

  const tapeResumed = await page.waitForFunction((before) => window.__cap.tradeSeq > before, { timeout: 20000 }, post.tradeSeqNow).then(() => true).catch(() => false);
  step('tape_resumed', { tapeResumed });

  const pass = !!(bookCheck && bookCheck.bidsMatch && bookCheck.asksMatch &&
    post.conn === 'live' && post.openOrders === 0 && post.reservedCash === 0 && tapeResumed);
  console.log(JSON.stringify({ PASS: pass, steps }, null, 2));
  process.exitCode = pass ? 0 : 1;
} finally {
  await browser.close().catch(() => {});
  server.kill('SIGKILL');
}
