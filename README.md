# Trading Exchange Simulator

A live paper-trading exchange. Sign up, receive virtual capital, and trade
against a real in-memory, price-time-priority matching engine with a live order
book streamed over WebSockets. Liquidity bots quote both sides continuously, so
there is always a market, and every fill can be explained in plain language by
an AI layer built from the exact execution facts.

Everything is virtual: no real money, no real market data, no brokerage.

**Live demo:** <https://trading-exchange-simulator-production.up.railway.app> —
sign up with any email (never verified, purely an identifier) and trade.

<!-- SCREENSHOT -->

## Benchmarks

The matching engine, order book, and benchmark harness are hand-written — no
dependency does the interesting work. Measured 2026-07-08 on the development
machine (Intel i7-10875H @ 2.30GHz laptop, 32GB RAM, Node v24.16.0, Windows 11;
the engine uses a single core by design):

| path | throughput | latency |
|---|---|---|
| Engine direct (`npm run bench`) | 2.10M mixed ops/sec mean, 1.54M worst run (≥1.4M worst across all sessions) | submit p50 0.3µs, p99 1.2µs |
| Engine, deep book (10,001 price levels/side) | 1.48M ops/sec mean | submit p99 2.3µs |
| Full HTTP path (`npm run bench:http`) | 1,306 orders/sec sustained | p50 13.9ms at 20 concurrent clients (queueing-dominated; ~0.77ms server-side per order) |

Against the targets: ≥50k orders/sec and p99 < 5ms — the engine sustains more
than 20× the throughput target at the most conservative reading, with roughly
4,000× latency headroom. The HTTP-path p50 is dominated by client-side queueing
(Little's law: 20 in-flight ÷ 1,306/sec ≈ 15ms); server-side cost per order is
~0.77ms, of which the engine itself is ~0.04%.

Full methodology, per-percentile tables, control runs, and honest caveats
(thermal variance, clock quantization, synthetic-flow limits) are in
[bench/results.md](bench/results.md). **The deployed instance (Railway trial
tier, with Neon serverless Postgres) is much slower than the benchmark
machine** — the published numbers describe the engine, not the demo host.

## Architecture

A modular monolith: one Node.js + TypeScript (strict) process serves the REST
API (Express), the WebSocket feed (`ws`), the static frontend, and the
liquidity bots. Postgres persists users, balances, orders, and fills.

- **Matching engine** (`src/engine/`) — in-memory, single-threaded per
  instrument, price-time priority. Pure and dependency-free: sorted price
  levels with intrusive FIFO queues per level and O(1) cancels via an order-ID
  hashmap. Single-threaded per instrument is how real exchanges shard; it makes
  matching deterministic and lock-free.
- **Server layer** (`src/server/`) — REST for accounts/orders/history, JWT
  auth, and a WebSocket server broadcasting order-book deltas (snapshot on
  connect, then per-channel sequenced deltas), the trade tape, and per-user
  fill notifications.
- **Persistence** (`src/db/`) — write-behind: the engine never blocks on the
  database. Mutations are queued and flushed in batches (latest-wins coalescing
  for row state, idempotent inserts for events). On restart, orders that were
  open in a previous process are reconciled as canceled, since the book lives
  in memory.
- **Liquidity bots** (`src/bots/`) — a market maker (diff-based quote
  maintenance around the last price) and a noise trader (small market orders
  with a mean-reverting side bias). They are ordinary user accounts trading
  through the public order path — same funds checks, same persistence.
- **AI explanations** (`src/ai/`) — every fill has an Explain button. Two
  implementations behind one interface, selected by environment: a pure
  rule-based engine (the default — zero cost, offline, built from exact
  integer execution facts) and an Anthropic-backed one (`ANTHROPIC_API_KEY`
  set) for richer prose. Both receive identical facts; neither can invent a
  number.
- **Frontend** (`web/`) — a terminal-style trading UI built against the frozen
  API contract, served as static files from the same origin as the API.

All prices and quantities are integers end to end (ticks/paise) — no floats
anywhere in money math.

## Design decisions

Every non-obvious choice is recorded with its reasoning in
[docs/decisions.md](docs/decisions.md). Highlights:

- Integer ticks everywhere; the API returns exact integers and never rounds (D1)
- Sorted price array over a heap or red-black tree, with the measured evidence
  for why (D2, D11)
- Fills always execute at the resting order's price — takers get price
  improvement (D3)
- Self-trade prevention with a cancel-resting policy (D5)
- Write-behind persistence with a stated, bounded crash-loss window (D14)
- Reservation-based funds model that makes no-shorting and no-negative-cash
  provable invariants (D16)
- Book deltas as diffs of the top-50 window with per-channel sequence numbers,
  so clients can detect gaps and resync (D12, D17)
- A rule-based fill explainer as the zero-cost default, the LLM behind an env
  var (D24, D26)

The frozen REST + WebSocket contract the frontend is built against is
[docs/api-contract.md](docs/api-contract.md).

## Limitations

Stated plainly, because they are real:

- **Database cold starts.** The database is Neon's free tier, whose compute
  suspends after ~5 minutes of idle; the next query resumes it (typically a
  second or two). An external pinger (cron-job.org) requests `GET /api/health`
  every 10 minutes — the endpoint runs a `SELECT 1` so each ping wakes both the
  web service and the database compute. With a 10-minute interval Neon can
  still suspend between pings, so a visitor may occasionally pay the ~1–2s
  resume on their first request; the pinger bounds how stale things get, it
  does not eliminate the suspend.
- **Restarts cancel open orders.** The order book is in memory. When the
  process restarts (deploy, crash, free-tier eviction), open orders are
  reconciled as canceled and reservations released — honest and simple, rather
  than replaying the book. Fills and balances persist.
- **Crash-loss window.** Persistence is write-behind; a hard crash can lose
  roughly the last 100ms of history. Acceptable for paper trading, stated
  openly.
- **Hosting runs on trial credit.** The web service runs on Railway's trial
  plan, which stops the service when the one-time credit is exhausted. If the
  live URL is down, that is the likely reason — the local run instructions
  below reproduce the full system in two commands.
- **Single instance, single core.** One process serves everything; per
  CLAUDE.md this is the v1 scope. Throughput scales by sharding instruments
  across processes, which is a design talking point, not a v1 feature.

## Running locally

```bash
# 1. Postgres (dev container on :5433)
docker run -d --name exchange-pg -e POSTGRES_PASSWORD=exsim -p 5433:5432 postgres:17

# 2. build + start
npm install
npm run build
npm start                 # serves API, WebSocket, and the web UI on :3000
```

Open <http://localhost:3000>, create an account, and trade. The bots populate
the book at boot, so there is always something to trade against. The schema
migrates automatically at startup (idempotent), and tests run with `npm test`.

### Configuration (all optional locally)

| Env var             | Default                          | Effect |
| ------------------- | -------------------------------- | ------ |
| `PORT`              | `3000`                           | HTTP/WS port |
| `DATABASE_URL`      | local dev Postgres on `:5433`    | Postgres connection; append `?sslmode=require` for managed Postgres (TLS without CA verification) |
| `JWT_SECRET`        | dev secret (never in production) | token signing key |
| `BOTS`              | on (`off` to disable)            | liquidity + noise bots |
| `ANTHROPIC_API_KEY` | *(unset)*                        | switches fill explanations from the rule-based engine to Claude |
| `AI_MODEL`          | `claude-haiku-4-5`               | model used when a key is set |

## Layout

```
src/engine/   matching engine + order book (pure, no I/O)
src/server/   express app, REST routes, WebSocket server, exchange coordinator
src/bots/     liquidity + noise bots
src/ai/       fill explainability (rule-based + Anthropic, one interface)
src/db/       schema, queries, write-behind persistence
web/          frontend (static, served by express)
e2e/          browser-level tests (mid-session server-restart recovery)
bench/        benchmark harness + results
docs/         frozen API contract + decision log
```
