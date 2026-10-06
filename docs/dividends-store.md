# Dividends store

The instruments Postgres now owns dividends the same way it owns fundamentals
(pfire-docs #51): `schema` `instruments`, tables `dividends` and
`dividends_fetch_state`, migration `drizzle/0005_dividends.sql`.

## What is stored

- **Paid / confirmed history** — every declared dividend with a real amount,
  ex-date, payment date, and declaration date. Every provider that carries
  history was already covered by the §52 stack: nasdaq first for US names,
  yfinance for EU listings, the §52.6 `dividendmax` public-page scrape as the
  last-resort fallback with full `payment_date` + `declaration_date` +
  currency.
- **Predicted** — dividendmax's public `/dividends` page carries ~5 years of
  `Forecast` rows (fixture-verified: full date triple + currency; the amount
  cell is sign-up gated). openst ≥#2 exposes them with `amount=None` and
  `status='Forecast'`, and union-merges them onto the winning provider's
  paid-history response. In the store they are `status='predicted'`,
  `amount NULL`. The calendar consumes only their dates, which is why rows
  surface there without amounts.

## The three-state lifecycle

| status | meaning |
|---|---|
| `predicted` | forecast dates, no declared amount |
| `confirmed` | declared by the company (amount known) |
| `paid` | ex-date has passed, row is history |

Upserts are last-write-wins on `(symbol, ex_date)`, with the guard that a
`predicted` row never overwrites a `confirmed`/`paid` row — a later cachehit
forecast cannot roll a declared dividend back to date-only. `confirmed`/`paid`
replace a `predicted` row in place even when the payment date moves.
`prunePredictedMissing` deletes a symbol's `predicted` rows that a fresh
forecast fetch no longer returns; confirmed/paid rows are never pruned.
`amount` being NULL is exactly what makes a row "predicted" in practice, so the
calendar's required `amount` is never invented.

## Windows

| scope | window | why |
|---|---|---|
| history | 7d | paid rows are immutable; declared rows keep arriving |
| predicted | 7d | forecasts move around the declaration, a week is the drift tolerance |
| empty (any scope that returned nothing) | 7d backoff | funds/ETFs never pay; without this every read re-walks providers |

## Cachest side

`OPENST_DIVIDENDS` cache_ttl is 604800 (7d, was 24h): the store owns
freshness, and that TTL only bounds how often a cold cache fans out at openst.
`OPENST_CALENDAR_DIVIDEND` stays 1h — the store dominates the per-symbol
calendar path now, but the global route is still the last working source for
GPW, so 1h keeps a freshly-declared coupon/foward ex-date visible within the hour.
