# Seed state must enter through the same persisted path the system reloads from

Phase 3 review caught this *before* it became a bug: anything seeded straight
into in-memory state (`accounts.put(...)`, the test `seedPosition` helper)
works perfectly — until the first restart, because boot rebuilds memory from
Postgres and the seed was never there. Worse than disappearing: dependent
rows that DID persist (orders, fills of a bot with no `users` row) now
violate FKs or describe users that don't exist.

Phase 4 applied it: bot accounts are seeded as real DB rows (users, balances,
positions) in one idempotent transaction, *before* `loadAccounts`, so memory
picks them up through the normal boot path (`src/bots/seed.ts`, D21).

Why it matters generally: any system with "memory is authority, DB is the
reload journal" (D16) has ONE legitimate entry point for new state — the
journal. A second entry point that skips it creates state the journal can't
reproduce, and every such shortcut is invisible until a restart. Tests were
green the whole time; only a boot-again test exposes it (see the restart test
in `src/bots/bots.test.ts`).
