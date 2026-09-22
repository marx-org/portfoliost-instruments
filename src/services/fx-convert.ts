/**
 * plan §48.2 — conversion of provider-fetched series (`/history`, `/price`).
 *
 * The DB read path converts inside the join (`queryViewAs` in
 * services/price-bars.ts). Provider rows are served straight from the
 * cachest fetch, so the same D27 cross-rate from `@marx2/contracts/fx` is
 * applied here per dated rate table. A bar whose date has no rate row stays
 * in the base currency — the same floor semantics as the SQL join (no
 * carry-forward).
 */
import { convert, type RateTable } from "@marx2/contracts/fx"

export interface FxRateRowLite {
  rateDate: string
  currency: string
  rate: string
}

/** Group rate rows into per-date EUR-quoted tables. */
export function rateTablesByDate(rows: FxRateRowLite[]): Map<string, RateTable> {
  const m = new Map<string, Record<string, number>>()
  for (const r of rows) {
    const v = Number(r.rate)
    if (!Number.isFinite(v) || v <= 0) continue
    const t = m.get(r.rateDate) ?? {}
    t[r.currency.toUpperCase()] = v
    m.set(r.rateDate, t)
  }
  return m
}

/**
 * Convert a parallel price array bar-by-bar. Bars without a rate row for
 * their date are kept verbatim (base currency). `fxFrom` = first date that
 * actually converted (null when nothing converted).
 */
export function convertSeries(
  dates: string[],
  prices: number[],
  baseCcy: string,
  targetCcy: string,
  tables: Map<string, RateTable>,
): { converted: number[]; fxFrom: string | null } {
  const out = new Array<number>(prices.length)
  let fxFrom: string | null = null
  for (let i = 0; i < prices.length; i++) {
    const table = tables.get(dates[i])
    const c = table ? convert(prices[i], baseCcy, targetCcy, table) : undefined
    if (c !== undefined) {
      out[i] = c
      if (fxFrom === null) fxFrom = dates[i]
    } else {
      out[i] = prices[i]
    }
  }
  return { converted: out, fxFrom }
}
