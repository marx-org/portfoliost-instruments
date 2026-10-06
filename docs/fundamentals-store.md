# Fundamentals store

`instruments.fundamentals_statements`, `fundamentals_metrics` and
`fundamentals_fetch_state` hold the fundamentals data permanently. This is the code
adjacent companion to [database-postgres-drizzle.md](database-postgres-drizzle.md)
(which owns the migration mechanics) and the board feature that specified it,
`pfire-docs#51`.

## Why it exists

Fundamentals used to live only in two volatile caches: openst kept them in Redis for 24h
and cachest proxied them with another 24h TTL. Both are evictions from gone — after a
wipe the next page view re-paid the whole provider walk, three requests per symbol,
every time. Statement history for a filed period does not change, so it belongs in a
database with an upsert rather than behind a TTL.

The question this store answers is not "how long is the TTL" but **"when do we ask
upstream for the newest period"**.

## What is permanent, and what is not

| Scope | Stored | Window | Why that window |
|---|---|---|---|
| income / balance / cash, `annual` | yes | 30 d | a new fiscal year only appears when it is filed |
| income / balance / cash, `quarter` | yes | 7 d | a quarter is restated for weeks after filing |
| `/equity/metrics` snapshot | yes | 1 d | P/E, market cap and the margins are price-derived and wrong within a trading day |
| anything that returned nothing | backoff only | 7 d | see below |

**Not stored, and deliberately:** MD&A, filings, insider and institutional ownership,
calendars, projections and consensus. Their providers revise them, so they stay on their
cachest TTLs. MD&A in particular is prose rewritten every quarter — a "permanent" copy
would be quietly wrong within one.

The empty case is the one that decides whether the store is a net win. An ETF or a fund
has no financial statements, so every read is a miss, and a miss is exactly what the
store exists to prevent. `last_status = 'empty'` is a **backoff, not data** — nothing is
written to `fundamentals_statements`, so such a symbol costs one provider walk a week
instead of one per page view.

## Row identity is the load-bearing decision

`period_key` is the **calendar quarter containing the provider's period end** (`YYYY-Qn`).
Not `period_ending`, and not `fiscal_year` + `fiscal_period`. Measured on 2026-10-06, on
21 live statement bodies plus both provider shapes
(`test/fixtures/fundamentals/README.md` has the capture):

- `period_ending` is the *only* identity key in a `yfinance` row; `fmp` declares
  `fiscal_year`, `fiscal_period` and `reported_currency` as well.
- The two providers **disagree about the same period**. Apple's FY2025 ends `2025-09-27`
  per fmp (true 52/53-week fiscal calendar) and `2025-09-30` per yfinance (calendarised).
- `fiscal_year` + `fiscal_period` are not comparable either: fmp labels the quarter
  ending `2026-06-27` "Q3 of FY2026", which is calendar Q2.

Keying on either field forks a symbol's history the moment the provider changes — and the
provider *does* change: fmp 402s on every non-US symbol, which trips openst's 24h
in-process provider block, so a long-lived openst container degrades to yfinance for
everything including symbols fmp answers fine. The calendar quarter is the one value both
shapes agree on.

`period` is in the key as well, not as an afterthought: `2025-09-30` is legitimately both
Apple's FY2025 annual row *and* its 2025Q3 quarterly row.

## Behaviour worth knowing before you change it

- **The provider of a row is not stable.** The upsert is last-write-wins and records
  `provider` per row, so a provider switch rewrites the period and is visible in
  `provider`/`fetched_at` rather than forking a second row set. Every derived column is
  in the set clause — leaving `fiscal_year` out would strand the previous provider's
  metadata on a row it no longer describes.
- **The response is built from a re-read of the store**, not from the body the walk
  returned, so a warm read and a cold read cannot disagree and a partial write is never
  served as complete.
- **§79.2 provenance comes off the stored rows.** A warm read makes no provider call, so
  reading provenance off the request would report `null` for every stored symbol.
- **A row with no usable period end is dropped, not stored** — the point of the key is
  that a period is addressable.
- **A 404 is recorded as a backoff; a 500 is recorded as nothing.** A broken provider tier
  is not a fact about the symbol, and remembering it would serve a failure as an answer
  for a week.
- **A `last_fetched_at` in the future counts as due**, not as fresh. A restored database or
  a host clock jump leaves a timestamp that never happened.
- **The store is not self-healing inside a window.** Delete a row and the next read serves
  the periods that remain until the window expires or `npm run fundamentals:backfill` runs.
  A store that re-walked providers because a row was missing would defeat its own purpose.

## Operating it

```sh
npm run fundamentals:backfill -- --symbol PKO.WA
npm run fundamentals:backfill -- --from-ticker-reference --limit 50
npm run fundamentals:backfill -- --from-ticker-reference --dry-run
```

One-shot, by hand, no CronJob. The store fills itself on read; this exists for warming a
symbol before anyone opens it and for re-seeding after a database restore. The walk is
sequential with a pause on purpose — each symbol costs up to seven provider walks, and a
parallel sweep would turn "warm the cache" into a provider flood.

## Where the numbers live

`cachest`'s `OPENST_FUNDAMENTALS` TTL no longer decides freshness for these scopes; it only
bounds how often a cold cache re-walks the providers. It must stay *within* the windows
above, or cachest can serve a body the store has already decided is due for a refetch.
