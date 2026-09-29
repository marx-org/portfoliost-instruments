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
 * Convert a parallel price array bar-by-bar.
 *
 * §72.17 — a bar whose date has no rate row is NO LONGER kept verbatim. It used
 * to be, and the response then declared `currency: <target>` for the whole
 * series, so the value was a number in the BASE currency wearing the TARGET's
 * label: BTC-USD converted to PLN over 2022-02-13..21 returned
 * `fxFrom: 2022-02-14` and left 02-13 at a raw 42,197.5156 where its neighbours
 * were ~170,859. Callers multiplying that into a portfolio total got Crypto's
 * one-day +410% swings — 168.79 the day after a correct ~683 is a -75% crash
 * and a +300% recovery, neither a market move.
 *
 * Worse, the gaps are not a prefix: they are scattered wherever `fx_rates` has
 * no row, so `fxFrom` cannot tell a caller which later bars are unconverted. The
 * mask is therefore the real output, and the route drops the masked-out bars
 * from every price array together — so the series that leaves this function is
 * genuinely in `targetCcy` end to end, and a missing rate becomes a gap the
 * consumer already knows how to carry forward.
 *
 * `fxFrom` is kept: it is the first date that converted, and callers use it to
 * see how much of their window was covered.
 */
export function convertSeries(
  dates: string[],
  prices: number[],
  baseCcy: string,
  targetCcy: string,
  tables: Map<string, RateTable>,
): { converted: number[]; convertedMask: boolean[]; fxFrom: string | null } {
  const out = new Array<number>(prices.length)
  const mask = new Array<boolean>(prices.length)
  let fxFrom: string | null = null
  for (let i = 0; i < prices.length; i++) {
    const table = tables.get(dates[i])
    const c = table ? convert(prices[i], baseCcy, targetCcy, table) : undefined
    out[i] = c ?? prices[i]
    mask[i] = c !== undefined
    if (c !== undefined && fxFrom === null) fxFrom = dates[i]
  }
  return { converted: out, convertedMask: mask, fxFrom }
}
