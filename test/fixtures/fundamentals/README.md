# Fundamentals fixtures

Captured 2026-10-06 from the local stack (issue #52 of the permanent-fundamentals-store
feature) and from openst's own container. They pin the row identity the store's primary key
depends on — read `../fundamentals.ts` (`periodKey`, `periodEnd`) alongside them.

## Layout

| Path | Source |
| --- | --- |
| `yfinance/*.json` | `GET http://localhost:8090/fundamentals/{symbol}?statement=…&period=…` — cachest → openst. Bodies carry the §79.2 envelope `{provider, rows}`. |
| `yfinance/metrics-*.json` | `GET http://localhost:8090/equity/metrics/{symbol}` — a bare record, no envelope. |
| `fmp/*.json` | `obb.equity.fundamental.<statement>(symbol, period=…, provider="fmp")` run **inside** the openst container. |
| `negative.json` | Symbols from `ticker_reference` with no statements: an ETF and an analizy.pl fund, both HTTP 404. |

The `fmp/` bodies were captured provider-directly, not through cachest, because openst's
container was serving `yfinance` for every statement at the time — see below.

## What the capture measured

**`period_ending` is the only identity key in a `yfinance` row.** No `fiscal_year`, no
`fiscal_period`. `fmp` declares all three plus `reported_currency`.

**The two providers disagree about the same period.** AAPL, captured on the same day:

| | `fmp` | `yfinance` |
| --- | --- | --- |
| income annual, FY2025 | `period_ending 2025-09-27`, `fiscal_year 2025`, `fiscal_period FY` | `period_ending 2025-09-30` |
| income quarter, Jun-2026 | `period_ending 2026-06-27`, `fiscal_year 2026`, `fiscal_period Q3` | `period_ending 2026-06-30` |

`fmp` uses Apple's true 52/53-week fiscal calendar and labels that June quarter **Q3 of
FY2026**. yfinance reports the calendarised quarter end and labels nothing. So neither
`period_ending` nor `fiscal_year`+`fiscal_period` is a cross-provider identity — keying on
either forks a symbol's history the moment the provider changes.

The only value both shapes agree on is **the calendar quarter containing `period_ending`**:
2025-09-27 and 2025-09-30 are both 2025Q3; 2026-06-27 and 2026-06-30 are both 2026Q2. That is
`periodKey()`.

**`period` has to be part of the key.** The same `period_ending` appears in both scopes — AAPL
`2025-09-30` is the FY2025 annual row *and* the 2025Q3 quarterly row. An annual and a quarterly
row for one quarter must not collide.

**History is shallow.** 4–5 annual and 5–6 quarterly periods per statement, not a full
history. Storing them is what stops them being re-walked.

**`fmp` is not answering through openst right now.** `STATEMENT_PROVIDERS` is
`["fmp", "yfinance", "polygon", "sec"]` (`openst/src/openbb_client.py:18`) and `fmp` 402s on
every non-US symbol (§79.4), which trips `_block_provider` and blocks it in-process for 24h
(`PROVIDER_BLOCK_HOURS = 24.0`, same file:54-78). The container has been up three days, so `fmp`
is currently blocked and every statement degrades to `yfinance` — including AAPL, which `fmp`
answers fine when called in a fresh process. That is why the `fmp/` fixtures are
provider-direct.

Consequence for the store: the provider of a row is **not stable**, so `provider` is stored per
row and the upsert is last-write-wins — a provider switch rewrites the period and the change is
visible in `provider`/`fetched_at` rather than silently forking.

**`metrics` carries no provenance and no date.** `get_metrics` goes through `_single_record`,
which returns `records[0]` with no envelope (`openbb/src/openbb_client.py:409-421`) — so there
is no `provider` to store, and nothing to key a history on. It is a pure current snapshot.
