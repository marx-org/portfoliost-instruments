/**
 * plan §48.2 — rate lookups on `instruments.fx_rates`.
 *
 * The conversion join itself lives with the price read path
 * (services/price-bars.ts, `queryViewAs`) — one parameterized query over
 * `price_bars_all ⨝ fx_rates ⨝ fx_rates`. This module serves the genuine
 * rate-only needs that cannot ride the join: the provider-fetched series
 * (`/history`) and the single price (`/price`) read the raw rates and convert
 * with `@marx2/contracts/fx` (D27 — the conversion math never lives here).
 */
import { sql } from "drizzle-orm"
import type { DB } from "./index.js"

export interface FxRateRow {
  rateDate: string
  currency: string
  rate: string
}

/** Normalize a raw `db.execute(sql`...`)` result to an array of rows
 * (PGlite returns `{ rows }`, postgres-js returns the row array). */
function rowsOf<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[]
  const r = result as { rows?: unknown }
  return (Array.isArray(r?.rows) ? r.rows : []) as T[]
}

function inList(currencies: string[]) {
  return sql`(${sql.join(currencies.map((c) => sql`${c.toUpperCase()}`), sql`, `)})`
}

/** All rate rows for the given currencies within [from, to] — one read. */
export async function fxWindow(
  db: DB,
  currencies: string[],
  from: string,
  to: string,
): Promise<FxRateRow[]> {
  const result = await db.execute(sql`
    select rate_date, currency, rate
    from instruments.fx_rates
    where currency in ${inList(currencies)}
      and rate_date between ${from} and ${to}
    order by rate_date asc
  `)
  return rowsOf<{ rate_date: string; currency: string; rate: string }>(result).map((r) => ({
    rateDate: r.rate_date,
    currency: r.currency,
    rate: r.rate,
  }))
}

export interface LatestRate {
  currency: string
  rateDate: string
  rate: string
}

/** Newest rate row per currency with `rate_date <= asOf` — one read.
 * Currencies without a row on or before `asOf` are absent from the result. */
export async function latestFxRates(
  db: DB,
  currencies: string[],
  asOf: string,
): Promise<LatestRate[]> {
  const result = await db.execute(sql`
    select distinct on (currency) currency, rate_date, rate
    from instruments.fx_rates
    where currency in ${inList(currencies)}
      and rate_date <= ${asOf}
    order by currency, rate_date desc
  `)
  return rowsOf<{ currency: string; rate_date: string; rate: string }>(result).map((r) => ({
    currency: r.currency,
    rateDate: r.rate_date,
    rate: r.rate,
  }))
}
