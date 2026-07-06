-- schema.sql — full database schema, applied idempotently at boot.
-- Money/prices are BIGINT paise (see docs/decisions.md D1); no floats.
-- The DB is a durable journal behind the in-memory engine (write-behind),
-- and the system of record for auth, history, and balances across restarts.

CREATE TABLE IF NOT EXISTS users (
  id            SERIAL PRIMARY KEY,
  email         TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS balances (
  user_id       INT PRIMARY KEY REFERENCES users(id),
  cash          BIGINT NOT NULL,
  reserved_cash BIGINT NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS positions (
  user_id      INT NOT NULL REFERENCES users(id),
  symbol       TEXT NOT NULL,
  qty          BIGINT NOT NULL,
  reserved_qty BIGINT NOT NULL,
  cost_basis   BIGINT NOT NULL,
  realized_pnl BIGINT NOT NULL,
  PRIMARY KEY (user_id, symbol)
);

CREATE TABLE IF NOT EXISTS orders (
  id              TEXT PRIMARY KEY,
  user_id         INT NOT NULL REFERENCES users(id),
  symbol          TEXT NOT NULL,
  side            TEXT NOT NULL,
  type            TEXT NOT NULL,
  price           BIGINT,
  qty             BIGINT NOT NULL,
  filled_qty      BIGINT NOT NULL,
  filled_notional BIGINT NOT NULL,
  status          TEXT NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL,
  updated_at      TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS orders_user_created ON orders (user_id, created_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS fills (
  id        TEXT PRIMARY KEY,
  order_id  TEXT NOT NULL,
  user_id   INT NOT NULL,
  symbol    TEXT NOT NULL,
  side      TEXT NOT NULL,
  role      TEXT NOT NULL, -- 'maker' | 'taker'
  price     BIGINT NOT NULL,
  qty       BIGINT NOT NULL,
  trade_seq BIGINT NOT NULL,
  ts        TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS fills_user_ts ON fills (user_id, ts DESC, id DESC);
CREATE INDEX IF NOT EXISTS fills_order ON fills (order_id);

-- One row per trade event (a fill has two rows above, one per side).
CREATE TABLE IF NOT EXISTS trades (
  symbol     TEXT NOT NULL,
  seq        BIGINT NOT NULL,
  price      BIGINT NOT NULL,
  qty        BIGINT NOT NULL,
  taker_side TEXT NOT NULL,
  ts         TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (symbol, seq)
);
CREATE INDEX IF NOT EXISTS trades_symbol_ts ON trades (symbol, ts DESC);
