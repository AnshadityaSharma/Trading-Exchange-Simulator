# Trading-Exchange-Simulator

A live paper-trading exchange — not a toy. Sign up, get virtual capital, and
trade against a real in-memory, price-time-priority matching engine with a live
order book streamed over WebSockets. Liquidity bots keep the book moving, and an
AI layer explains fills in plain language.

Everything is virtual: no real money, no real market data, no brokerage.

## Stack

Node.js + TypeScript (strict), Express, `ws`, Postgres (thin raw-SQL layer, no
ORM). The matching engine, order book, and benchmark harness are written by
hand — no dependency does the interesting work. Tests: Vitest.

## Running locally

```bash
# 1. Postgres (dev container on :5433)
docker run -d --name exchange-pg -e POSTGRES_PASSWORD=exsim -p 5433:5432 postgres:17

# 2. build + start
npm install
npm run build
npm start                 # serves API, WebSocket, and the web UI on :3000
```

Open <http://localhost:3000>, create an account, and trade. The order book is
already populated — the liquidity bots quote both sides and print trades, so
there is always something to trade against.

### Configuration (all optional)

| Env var             | Default                          | Effect |
| ------------------- | -------------------------------- | ------ |
| `PORT`              | `3000`                           | HTTP/WS port |
| `DATABASE_URL`      | local dev Postgres on `:5433`    | Postgres connection |
| `JWT_SECRET`        | dev secret                       | token signing key |
| `BOTS`              | on (`off` to disable)            | liquidity + noise bots |
| `ANTHROPIC_API_KEY` | *(unset)*                        | selects the AI explainer (see below) |
| `AI_MODEL`          | `claude-haiku-4-5`               | model used when a key is set |

## AI fill explanations

Every fill has an **Explain** button. It answers, in plain language, why an order
filled the way it did — the average price, price improvement or slippage across
levels, any unfilled remainder, and whether a limit order rested before filling.

There are two explainers behind one interface, chosen by environment:

- **No `ANTHROPIC_API_KEY` (the default):** a pure, offline rule-based engine.
  It builds the explanation from the exact same integer facts, with no network
  and no cost. **The public demo runs on this — zero API spend, no rate limits,
  works out of the box.**
- **`ANTHROPIC_API_KEY` set:** the Anthropic-backed explainer (Claude), for
  richer prose. It stays in the codebase and activates purely via the env var.

Both are handed the identical facts and the same rupee formatting, so they can
differ in phrasing but never in substance — neither can invent a number.

## Benchmarks

```bash
npm run bench        # engine-only throughput + latency
npm run bench:http   # full HTTP path
```

Results, with hardware specs, are in `bench/results.md`.

## Layout

```
src/engine/   matching engine + order book (pure, no I/O)
src/server/   express app, REST routes, WebSocket server, exchange coordinator
src/bots/     liquidity + noise bots
src/ai/       fill explainability (rule-based + Anthropic, one interface)
src/db/       schema, queries, write-behind persistence
web/          BB Terminal frontend (static, served by express)
bench/        benchmark harness + results
docs/         frozen API contract + decision log
```

See `docs/decisions.md` for the reasoning behind every non-obvious design choice,
and `CLAUDE.md` for the project's goals and constraints.
