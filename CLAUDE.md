# CLAUDE.md — Trading Exchange Simulator ("Exchange")

This file is the single source of truth for this project. Read it fully at the start of every session. If reality diverges from this file, update this file.

---

## 1. What this is and why it exists

A live paper-trading exchange — not a toy simulator. Users sign up, get virtual capital, and trade against a real in-memory matching engine with a live order book streamed over WebSockets. Liquidity bots keep the book alive. An AI layer explains fills and market moves in plain language.

**Who it's for / why it's being built:** This is a placement-portfolio flagship for a fintech-targeted SDE role (companies like Groww, Zerodha-adjacent). The evaluation criteria that matter, in order:
1. **Measured performance numbers** (orders/sec, p50/p99 matching latency) published in the README
2. **Deployed and publicly usable** — a recruiter clicks a link and trades within 30 seconds, no setup
3. **Interview survivability** — every design decision must be explainable and defensible by the author. No magic. No dependency doing the interesting work for us.

Every decision should be tested against those three. "Would this help in a system-design interview?" beats "is this the enterprise-standard way?"

## 2. Non-goals (do not build these)

- Real money, real market data feeds, or brokerage integration
- Auth beyond simple email+password or OAuth (no 2FA, no KYC flows)
- Multi-asset classes — equities-style limit/market orders only for v1. No options, no futures, no margin
- Microservices. This is a modular monolith. Do not split services, add message queues, or introduce Kafka/RabbitMQ. If a component needs isolation, a module boundary is enough
- Kubernetes, Terraform, multi-region. One deploy target
- Admin dashboards, email verification, password reset flows (stub them)

## 3. Architecture (decided — do not re-litigate)

- **Matching engine:** In-memory, single-threaded per instrument, price-time priority (FIFO within price level). Order book = sorted price levels (two sides), each level a FIFO queue. Justify data structure choice in code comments (e.g., sorted map / heap + hashmap for O(1) order lookup by ID for cancels)
- **Why in-memory single-threaded:** deterministic matching, no lock contention, this is how real exchanges shard (per-instrument). This is a core interview talking point — keep it clean
- **Persistence:** Postgres for users, balances, order history, fills (write-behind from the engine — engine never blocks on DB). Redis optional only if a concrete need appears; do not add preemptively
- **API:** REST (Express + TypeScript) for account ops, order submission, history
- **Realtime:** WebSocket server broadcasting order book deltas (not full snapshots per tick) + trade tape + user-specific fill notifications. Snapshot-on-connect, then deltas
- **Liquidity bots:** In-process market-maker bots per instrument (configurable spread, size, refresh rate) so the book is never empty
- **AI explainability:** Separate module. On fill or on demand, generate a plain-language explanation of what happened (why the order filled at that price, slippage, book state). Anthropic API, isolated behind an interface so it can be stubbed in tests
- **Frontend:** Built separately in Claude Design against `docs/api-contract.md`. Backend must conform to the contract, not the other way around
- **Benchmarking:** A dedicated `bench/` harness that fires synthetic order flow at the engine directly (no HTTP) and separately through the full HTTP path, reporting throughput and p50/p95/p99 latency. Results go in README with hardware specs

## 4. Tech stack (decided)

- Node.js + TypeScript (strict mode), Express, `ws` for WebSockets
- Postgres via a thin query layer (no heavy ORM — raw SQL or a minimal builder; author must be able to explain every query)
- Vitest for tests
- Deploy: single VPS or Railway/Render — whatever gets a public URL fastest
- No dependency may replace core logic: matching, order book, and benchmark logic are written by hand. Utility deps (validation, logging) are fine

## 5. Performance targets

- Engine-only: ≥ 50k orders/sec sustained on dev hardware, p99 match latency < 5ms
- Full HTTP path: report honestly whatever it is; do not tune HTTP at the expense of code clarity
- WebSocket: 500 concurrent clients receiving book deltas without falling behind
- If a target is missed, report the real number and the bottleneck. Never massage numbers.

## 6. Conventions

- TypeScript strict; no `any` in engine code
- Engine code is dependency-free and pure where possible — it should be testable without the server
- Every module gets a short header comment: what it does, why it exists, key tradeoff made
- Commits: small, imperative, one logical change each
- Tests: matching engine has exhaustive unit tests (partial fills, price improvement, cancels, self-match, empty book, crossing spreads). Correctness of the engine is non-negotiable — it's the first thing an interviewer will probe
- Simplest thing that works well. No premature abstraction, no feature flags, no error handling for impossible states. Validate at boundaries only (user input, API edges)

## 7. Project structure

```
src/
  engine/        # matching engine + order book (pure, no I/O)
  server/        # express app, routes, ws server
  bots/          # liquidity bots
  ai/            # explainability module (interface + anthropic impl)
  db/            # schema, migrations, queries
web/             # frontend (BB Terminal, built in Claude Design) — static files served by express
e2e/             # browser-level tests that own server processes (restart recovery)
bench/           # benchmark harness + results
docs/
  api-contract.md    # frozen REST + WS contract for frontend
  decisions.md       # running log of decisions + why (interview prep gold)
notes/           # lessons memory (see §9)
```

## 8. Verification protocol

- After every engine change: run the engine test suite before claiming anything works
- Every claim of "done" must point to a passing test run or command output from this session. If untested, say "untested" explicitly
- At the end of each build phase, run a fresh-context review of the phase's code against this file and the spec (subagent if available)
- Benchmarks are rerun after any engine change and results updated

## 9. Memory / lessons

Store lessons in `notes/`, one file per lesson, one-line summary at top. Record corrections and confirmed approaches, including why they mattered. Don't duplicate what git history or this file already records. Update existing notes rather than duplicating; delete notes proven wrong.

## 10. Working style

- The author (Ansh) reviews and studies all code — write it to be read. Prefer clear over clever
- When a decision genuinely needs the author (scope change, destructive action, something only he knows), ask and end the turn. Otherwise proceed
- Lead summaries with the outcome, then detail. No arrow-chain shorthand in user-facing summaries
- Do not re-derive or re-debate decisions recorded in this file; propose changes by pointing at the specific section and giving a concrete reason
