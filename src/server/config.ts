// config.ts — all environment configuration and the instrument list.
// Why: one place where process.env is read; everything else takes values from
// here, so tests can construct a Config without touching the environment.
// Key tradeoff: instruments are code, not a DB table — the list is small,
// static for v1, and shipping it in code avoids a migration + admin UI for
// something that changes once a quarter (CLAUDE.md §2: no admin dashboards).

export interface InstrumentMeta {
  symbol: string;
  name: string;
  /** Display price = API price ÷ priceScale (API prices are integer paise). */
  priceScale: number;
  /** Valid prices are multiples of this, in API price units. */
  tickSize: number;
  lotSize: number;
  /** Reference price the liquidity bots quote around at boot (Phase 4). */
  referencePrice: number;
}

export const INSTRUMENTS: readonly InstrumentMeta[] = [
  { symbol: 'ACME', name: 'Acme Industries', priceScale: 100, tickSize: 5, lotSize: 1, referencePrice: 245000 },
  { symbol: 'GLXY', name: 'Galaxy Corporation', priceScale: 100, tickSize: 5, lotSize: 1, referencePrice: 87500 },
  { symbol: 'NIMB', name: 'Nimbus Logistics', priceScale: 100, tickSize: 5, lotSize: 1, referencePrice: 41200 },
];

/** Virtual cash for new signups: ₹10,00,000 in paise (api-contract.md). */
export const STARTING_CASH = 100_000_000;

export interface Config {
  port: number;
  databaseUrl: string;
  jwtSecret: string;
  /** Liquidity bots (Phase 4). Off in tests/benchmarks: they inject nondeterministic flow. */
  bots: boolean;
}

export function loadConfig(): Config {
  return {
    port: Number(process.env.PORT ?? 3000),
    databaseUrl:
      process.env.DATABASE_URL ?? 'postgres://postgres:exsim@localhost:5433/exchange',
    jwtSecret: process.env.JWT_SECRET ?? 'dev-secret-not-for-production',
    bots: process.env.BOTS !== 'off',
  };
}
