# API Contract — Trading Exchange Simulator

**Status: FROZEN (signed off 2026-07-06). The backend conforms to this document;
breaking changes require a new version, not an edit.**

The frontend is built against this contract alone. Everything a client needs is
here; anything not here is a server internal.

---

## Conventions

- Base URL: `/api`. All bodies are JSON. Timestamps are ISO 8601 UTC strings.
- **Prices and money are integers in minor units** (paise). Each instrument has
  a `priceScale` (e.g. `100`): display price = API price ÷ priceScale. A price
  of `245050` with priceScale 100 renders as ₹2,450.50. Quantities are integer
  units (shares). No floats anywhere in the API.
- Order IDs are **opaque strings**. Do not parse them.
- Authenticated endpoints require `Authorization: Bearer <token>`.
- Errors always have the shape:

```json
{ "error": { "code": "INSUFFICIENT_FUNDS", "message": "human-readable detail" } }
```

Error codes: `VALIDATION` (400), `UNAUTHORIZED` (401), `NOT_FOUND` (404),
`UNKNOWN_INSTRUMENT` (404), `INSUFFICIENT_FUNDS` (400), `INSUFFICIENT_POSITION`
(400), `ORDER_NOT_OPEN` (409), `EMAIL_TAKEN` (409), `INVALID_CREDENTIALS` (401),
`RATE_LIMITED` (429), `INTERNAL` (500).

### Trading rules encoded in this contract

- **No short selling:** a sell order larger than your free position is rejected
  with `INSUFFICIENT_POSITION`.
- **Cash reservation:** a buy limit order reserves `price × qty` cash until it
  fills or is canceled. A buy market order reserves at the current best ask and
  is rejected with `INSUFFICIENT_FUNDS` if cash can't cover it (or with
  `VALIDATION` if the book is empty).
- **Market orders never rest:** any unfilled remainder is canceled immediately.
- **Self-trade prevention:** if your order would match your own resting order,
  the resting order is canceled automatically and matching continues (you'll
  see it as an `order_update` with status `canceled`).

---

## REST endpoints

### Auth

#### `POST /api/auth/signup`
```json
{ "email": "a@b.com", "password": "min 8 chars" }
```
→ `201 { "token": "<jwt>", "user": { "id": 1, "email": "a@b.com", "createdAt": "…" } }`
New users start with virtual cash of ₹10,00,000 (`100000000` paise).
Errors: `EMAIL_TAKEN`, `VALIDATION`.

#### `POST /api/auth/login`
Same body/response as signup (`200`). Error: `INVALID_CREDENTIALS`.

### Account

#### `GET /api/me` (auth)
```json
{
  "user": { "id": 1, "email": "a@b.com", "createdAt": "…" },
  "cash": 98211000,
  "reservedCash": 490100,
  "positions": [
    { "instrument": "ACME", "qty": 100, "reservedQty": 0, "costBasis": 1788900, "realizedPnl": 12400 }
  ]
}
```
`cash` is spendable (reservations already excluded); `costBasis` is the total
paise paid for the open `qty` (avg cost = costBasis ÷ qty, computed client-side);
`reservedQty` is position locked under open sell orders.

### Market data (public)

#### `GET /api/instruments`
```json
{ "instruments": [
  { "symbol": "ACME", "name": "Acme Industries", "priceScale": 100, "tickSize": 5, "lotSize": 1 }
] }
```
`tickSize` is in API price units: valid prices are multiples of `tickSize`.

#### `GET /api/instruments/:symbol/book?depth=20`
```json
{ "symbol": "ACME", "seq": 88231, "bids": [[245050, 300], [245000, 120]], "asks": [[245100, 80]] }
```
Levels are `[price, qty]`, best first, aggregated per price. `depth` default 20, max 50.

#### `GET /api/instruments/:symbol/stats`
```json
{ "symbol": "ACME", "lastPrice": 245050, "open24h": 243000, "high24h": 246000,
  "low24h": 242500, "volume24h": 18240, "ts": "…" }
```
Rolling 24-hour window. `volume24h` is in quantity units. All price fields are
`null` if there were no trades in the window (`lastPrice` falls back to the most
recent trade ever, or `null` if the instrument has never traded). Change and
percentage are computed client-side from `lastPrice` and `open24h` — the API
sends no derived/rounded values.

#### `GET /api/instruments/:symbol/trades?limit=50`
```json
{ "symbol": "ACME", "trades": [
  { "price": 245050, "qty": 10, "takerSide": "buy", "seq": 88230, "ts": "…" }
] }
```
Most recent first. `limit` default 50, max 200.

### Orders (auth)

#### `POST /api/orders`
```json
{ "instrument": "ACME", "side": "buy", "type": "limit", "price": 245050, "qty": 10 }
```
`price` is required for `limit`, forbidden for `market`.
→ `201`:
```json
{
  "order": {
    "id": "ord_8f3k2m", "instrument": "ACME", "side": "buy", "type": "limit",
    "price": 245050, "qty": 10, "filledQty": 4, "filledNotional": 980120,
    "status": "partially_filled", "createdAt": "…"
  },
  "fills": [ { "price": 245030, "qty": 4, "ts": "…" } ]
}
```
Matching is synchronous: immediate fills are in the response. `filledNotional`
is the exact integer sum of `price × qty` over fills (avg fill price =
filledNotional ÷ filledQty, computed client-side).

Order `status` enum: `open`, `partially_filled`, `filled`, `canceled`.
(A market order with unfilled remainder returns `canceled` or
`partially_filled`-then-`canceled` — terminal state is always `canceled` with
`filledQty` showing what executed. A rejected order is never created: rejections
are HTTP errors.)

Errors: `VALIDATION` (bad qty/price/tick), `UNKNOWN_INSTRUMENT`,
`INSUFFICIENT_FUNDS`, `INSUFFICIENT_POSITION`.

#### `DELETE /api/orders/:id`
→ `200 { "order": { …, "status": "canceled" } }`
Errors: `NOT_FOUND` (not yours / doesn't exist), `ORDER_NOT_OPEN` (already
filled or canceled).

#### `GET /api/orders?instrument=ACME&status=open&limit=50&before=<orderId>`
```json
{ "orders": [ { …order objects, most recent first… } ], "nextBefore": "ord_x" }
```
`status` ∈ `open` (includes `partially_filled`) | `filled` | `canceled` | `all`
(default `all`). Cursor pagination: pass `before=nextBefore` for the next page;
`nextBefore` is `null` on the last page.

#### `GET /api/orders/:id`
→ `200 { "order": { … }, "fills": [ { "price": 245030, "qty": 4, "ts": "…" } ] }`

#### `GET /api/fills?instrument=ACME&limit=50&before=<fillId>`
```json
{ "fills": [
  { "id": "fil_2a", "orderId": "ord_8f3k2m", "instrument": "ACME", "side": "buy",
    "price": 245030, "qty": 4, "role": "taker", "ts": "…" }
], "nextBefore": null }
```

### AI explainability (auth)

#### `GET /api/orders/:id/explain`
→ `200 { "explanation": "Your buy order filled at ₹2,450.30, 20 paise below your limit, because…", "generatedAt": "…" }`
Generates on first call (may take a few seconds), cached afterward. Only for
your own orders (`NOT_FOUND` otherwise). Error: `INTERNAL` if the AI backend is
unavailable — the order data itself is always available via `GET /api/orders/:id`.

### Meta

#### `GET /api/health`
→ `200 { "status": "ok" }` (no auth)

---

## WebSocket

Connect: `wss://<host>/ws` (public data) or `wss://<host>/ws?token=<jwt>` (also
enables the private `user` channel). All frames are JSON text.

### Client → server

```json
{ "type": "subscribe",   "channel": "book:ACME" }
{ "type": "unsubscribe", "channel": "book:ACME" }
{ "type": "ping" }
```
Channels: `book:<SYMBOL>`, `trades:<SYMBOL>`, `user` (auth required).

**Sequence numbers are independent per channel (and per instrument).** The
`seq` on `book:ACME` events and the `seq` on `trades:ACME` events are separate
counters — never compare them. The gap-detection rule applies *within* one
channel only. The REST book snapshot's `seq` belongs to the book sequence space
(so REST snapshot + WS deltas stitch together); the REST trades list's `seq`
belongs to the trade sequence space.

### Server → client

On connect: `{ "type": "hello", "authenticated": true }`

On subscribe ack: `{ "type": "subscribed", "channel": "book:ACME" }`
(then, for `book:*`, immediately a snapshot)

Heartbeat reply: `{ "type": "pong" }`

Errors: `{ "type": "error", "code": "UNKNOWN_CHANNEL" | "UNAUTHORIZED" | "VALIDATION", "message": "…" }`

#### Channel `book:<SYMBOL>` — snapshot, then deltas

```json
{ "type": "book_snapshot", "symbol": "ACME", "seq": 88231,
  "bids": [[245050, 300]], "asks": [[245100, 80]] }

{ "type": "book_delta", "symbol": "ACME", "seq": 88232,
  "bids": [[245050, 260]], "asks": [] }
```
Delta entries are **absolute replacement quantities** per price level —
`[price, 0]` means the level is gone. Apply deltas in `seq` order; `seq` is the
**book sequence** for this instrument and increases by exactly 1 per
`book_snapshot`/`book_delta` message on this channel (trades do not consume
book sequence numbers). **If you observe a gap, your state is invalid:
resubscribe to get a fresh snapshot.** Top 50 levels per side are maintained;
deltas outside the top 50 are not sent.

#### Channel `trades:<SYMBOL>` — the tape

```json
{ "type": "trade", "symbol": "ACME", "price": 245050, "qty": 10,
  "takerSide": "buy", "seq": 5121, "ts": "…" }
```
`seq` here is the **trade sequence** for this instrument (independent of the
book sequence), increasing by exactly 1 per trade — usable for tape gap
detection and deduplication against the REST trades endpoint.

#### Channel `user` — your orders and fills (private)

```json
{ "type": "order_update", "order": { …full order object… } }

{ "type": "fill", "fill": { "id": "fil_2a", "orderId": "ord_8f3k2m",
  "instrument": "ACME", "side": "buy", "price": 245030, "qty": 4,
  "role": "maker", "ts": "…" } }
```
`order_update` fires on every status/filledQty change, including self-trade
cancels. `fill` fires for both taker fills (your aggressive order) and maker
fills (your resting order got hit).

### Connection behavior

- Subscriptions do not survive reconnect — resubscribe on every connect.
- The server may close idle connections; send `ping` at least every 30s.
- A slow consumer that can't keep up may be disconnected; reconnect and
  resubscribe (you'll get a fresh snapshot).
