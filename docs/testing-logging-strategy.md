# Testing & Logging Strategy — Cross-Reference

**Status**: Accepted (updated 2026-09-28: mock retired from prod; debug-log policy)
**Source**: `portfoliost/docs/proposals/testing-logging-strategy.md` (canonical copy)

> The full strategy lives in the frontend repo. This file is a pointer plus the parts
> of it that touch this module.

## Canonical Document

`portfoliost/docs/proposals/testing-logging-strategy.md` — three-tier testing,
database environment tiers, seed system, mock status, and the debug-log policy.

## Summary

1. **Three-tier testing** — backend unit tests (embedded Postgres via PGlite), frontend unit tests (mocked API), E2E tests (real backend + volatile seeded Postgres in docker compose)
2. **Database environment tiers** — volatile + seeded in docker compose, persistent in the cluster, fresh per-test with real migrations for unit tests
3. **Seed system** — `mocks/db-seed/` in the frontend repo, compose-only; module images ship no seeding code
4. **Mock status** — retired from production; remains a compose-only stand-in for endpoints with no real backend yet
5. **Debug logging** — `RECALC_DEBUG=1` gates `[recalc-debug]` output that narrates how valuations are computed

## Key Files

- `src/db/index.ts` — `DATABASE_URL` env var (postgres-js client)
- `src/db/test-db.ts` — PGlite test helper applying real migrations
- `src/db/schema.ts` — owns `instruments.fx_rates`, `ticker_reference`, `exchange_reference` (§48 moved FX here; the endpoints followed the data)
- `Dockerfile` — `CMD` runs `db:migrate && node dist/server.js` (no seeding; see below)
- `docker-compose.yml` (frontend repo) — `postgres` service (volatile, tmpfs), plus `mock-db-seed`

## Relevance to This Repo

- **Unit tests** run against embedded Postgres, exercising the real migration files
- **This module owns FX and ticker reference**, so it is on the critical path for every
  valuation elsewhere. Missing or stale `fx_rates` is the first thing to check when a
  portfolio total looks wrong.
- **No `seed/` directory here.** Seeding moved to the frontend repo's `mocks/db-seed/`, which runs as a compose one-shot. The module `CMD` deliberately does not seed — the schema is guaranteed by `db:migrate`, and fixtures are applied by the seed service.
- **All E2E tests** run against this module via docker compose
- **Debug logging** — this module does not currently emit `[recalc-debug]` lines. FX lookups are narrated from the consumer side (`cash-balance-series` logs the rate each leg was converted at). If this module gains a computation that feeds a user-visible number, it follows the canonical policy: one `RECALC_DEBUG` flag, one `[recalc-debug]` prefix, deterministic ordering, bounded volume, and a test asserting the line's contents.
