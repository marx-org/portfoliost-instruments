/**
 * price-data-architecture (H3) — read-through daily close-price series.
 *
 * Serves `GET /instruments/:symbol/price-bars?from=&to=` from `price_bars_all`
 * (one SQL call). When the series is stale near today it fetches missing days
 * from cachest (→ openst), writes them to `price_bars` (overflow), and on the
 * first overflow write for a symbol runs the split boundary check. A circuit
 * breaker in `price_bar_metadata` stops upstream hammering after a failed fetch.
 */
import { eq, sql } from "drizzle-orm"
import type { DB } from "../db/index.js"
import { priceBarMetadata, priceBars, splitCandidates, tickerReference } from "../db/schema.js"
import { fetchOhlcv, fetchBondOhlcv, fetchCryptoOhlcv } from "../adapters/cachest.js"
import { providerSymbol, venueFreeSymbol } from "../adapters/symbol.js"

const STALE_AFTER_DAYS = 3
const COOLDOWN_MS = 60 * 60 * 1000 // retry upstream at most hourly after a failure

/**
 * Normalize a raw `db.execute(sql`...`)` result to an array of rows. The
 * PGlite test driver returns `{ rows },` while the postgres-js prod driver
 * returns the row array directly; treat both the same.
 */
function rowsOf<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[]
  const r = result as { rows?: unknown }
  return (Array.isArray(r?.rows) ? r.rows : []) as T[]
}

/** A single daily close bar as returned by the price_bars_all view. */
export interface PriceBarRow {
  symbol: string
  date: string
  close: string
  source: string
}

/** Compact daily close series (mirrors the PriceBarSeries contract). */
export interface PriceBarSeriesResult {
  symbol: string
  stale: boolean
  currency: string | null
  dates: string[]
  closes: number[]
}

/**
 * Query `price_bars_all` — a single SQL call covering stooq + overflow.
 *
 * The view can hold duplicate (symbol, date) rows when an overflow write from
 * the passive write-through (openst) lands on a date stooq already covers. The
 * read path keeps both (the importer needs them), but their relative order for
 * an equal date is otherwise planner-dependent — make it deterministic by
 * sorting split-adjusted `stooq` rows ahead of `openst` overflow rows, so
 * callers that index-of a date see the stooq value first.
 */
export async function queryView(
  db: DB,
  symbol: string,
  from: string,
  to: string,
): Promise<PriceBarRow[]> {
  const result = await db.execute(sql`
    select symbol, date, close, source
    from instruments.price_bars_all
    where symbol = ${symbol}
      and date between ${from} and ${to}
    order by date asc, case when source = 'stooq' then 0 else 1 end
  `)
  return rowsOf<PriceBarRow>(result)
}

/** Last date present for a symbol across the whole view (for gap detection). */
export async function lastDateForSymbol(db: DB, symbol: string): Promise<string | null> {
  const result = await db.execute(sql`
    select max(date) as last_date
    from instruments.price_bars_all
    where symbol = ${symbol}
  `)
  return (rowsOf<{ last_date: string }>(result)[0]?.last_date as string | null) ?? null
}

/** D81 asset class for price-bars routing (canonical lowercase). */
export type PriceBarAssetType = "stock" | "etf" | "fund" | "crypto" | "bond" | "corp_bond"

/** Map a stored `ticker_reference.asset_type` (mixed case: "Stock", "ETF", "CRYPTO",
 * "corp_bond", …) onto the canonical routing set. Unknown values fall back to `stock`,
 * preserving the existing equity/stooq path. */
export function normalizeAssetType(raw: string | null | undefined): PriceBarAssetType {
  const v = (raw ?? "").trim().toLowerCase()
  if (v === "etf") return "etf"
  if (v === "fund" || v === "tfi" || v === "funds") return "fund"
  if (v === "crypto" || v === "cryptocurrency") return "crypto"
  if (v === "bond") return "bond"
  if (v === "corp_bond" || v === "corporate_bond" || v === "corporate bond") return "corp_bond"
  return "stock"
}

/**
 * Resolve a symbol's asset class from `ticker_reference` (D81). Matches the bare
 * venue-free ticker against the reference table (venue-qualified `SNT.WA` / US
 * `AAPL.US` resolve to their bare ticker). Returns `null` when the reference
 * table is absent or the symbol is not listed — callers treat that as `stock`.
 */
export async function lookupAssetType(db: DB, symbol: string): Promise<string | null> {
  const baseTicker = venueFreeSymbol(symbol).toUpperCase()
  const rows = await db
    .select({ assetType: tickerReference.assetType })
    .from(tickerReference)
    .where(eq(tickerReference.ticker, baseTicker))
    .limit(1)
  return rows[0]?.assetType ?? null
}

/** Whether the series has a gap near today (off by more than the tolerance). */
export function hasGap(lastDate: string, now = new Date()): boolean {
  const last = new Date(`${lastDate}T00:00:00Z`)
  const deltaDays = Math.floor((now.getTime() - last.getTime()) / 86_400_000)
  return deltaDays > STALE_AFTER_DAYS
}

/** Read the circuit-breaker row for a symbol. */
async function readMetadata(db: DB, symbol: string) {
  const rows = await db
    .select()
    .from(priceBarMetadata)
    .where(eq(priceBarMetadata.symbol, symbol))
    .limit(1)
  return rows[0]
}

/** Whether an earlier failed fetch should keep us from hitting upstream again. */
export function recentlyFailed(
  meta: { lastFetchedAt: Date | null; fetchStatus: string } | undefined,
  now = new Date(),
): boolean {
  if (!meta || meta.fetchStatus !== "failed" || !meta.lastFetchedAt) return false
  return now.getTime() - meta.lastFetchedAt.getTime() < COOLDOWN_MS
}

/**
 * Upsert fetched daily bars into `price_bars` (overflow). `close` is stored as
 * a scaled string (numeric(28,8)).
 */
export async function upsertOverflowBars(
  db: DB,
  symbol: string,
  bars: Array<{ date: string; close: string }>,
): Promise<void> {
  for (const b of bars) {
    await db
      .insert(priceBars)
      .values({ symbol, date: b.date, close: b.close, source: "openst" })
      .onConflictDoUpdate({
        target: [priceBars.symbol, priceBars.date],
        set: { close: sql`excluded.close`, source: sql`excluded.source` },
      })
  }
}

/** Earliest overflow write date for a symbol (NULL if none yet). */
export async function minOverflowDate(db: DB, symbol: string): Promise<string | null> {
  const rows = await db
    .select({ d: sql<string>`min(${priceBars.date})` })
    .from(priceBars)
    .where(eq(priceBars.symbol, symbol))
  return rows[0]?.d ?? null
}

const SPLIT_FACTORS = [1 / 2, 1 / 3, 1 / 4, 1 / 5, 1 / 7, 1 / 10, 1 / 20, 2, 3, 4, 5, 7, 10, 20]
const SPLIT_TOLERANCE = 0.03

/** Map a boundary ratio to its known split factor, else null. */
export function matchSplitFactor(ratio: number): number | null {
  for (const f of SPLIT_FACTORS) {
    if (Math.abs(ratio - f) / f <= SPLIT_TOLERANCE) return f
  }
  return null
}

/**
 * Detect a split discontinuity at the stooq/overflow boundary. Runs on the
 * first overflow write for a symbol; overflow already present means the
 * boundary is established and no re-check is needed.
 */
export async function checkSplitBoundary(
  db: DB,
  symbol: string,
  stooqTicker: string,
): Promise<void> {
  if (minOverflowDate(db, symbol) === null) return
  const lastStooqRows = rowsOf<{ date: string; close: string }>(
    await db.execute(sql`
      select date, close from instruments.stooq_daily_us
      where ticker = ${stooqTicker}
      order by date desc limit 1
    `),
  )
  const firstOverflowRows = rowsOf<{ date: string; close: string }>(
    await db.execute(sql`
      select date, close from instruments.price_bars
      where symbol = ${symbol}
      order by date asc limit 1
    `),
  )
  const lastStooqClose = lastStooqRows[0]?.close
  const lastStooqDate = lastStooqRows[0]?.date
  const firstOverflowClose = firstOverflowRows[0]?.close
  const firstOverflowDate = firstOverflowRows[0]?.date
  if (lastStooqClose == null || firstOverflowClose == null) return
  const ratio = Number(firstOverflowClose) / Number(lastStooqClose)
  if (ratio >= 0.85 && ratio <= 1.15) return

  const factor = matchSplitFactor(ratio)
  await db
    .insert(splitCandidates)
    .values({
      symbol,
      detectedAt: new Date().toISOString().slice(0, 10),
      lastStooqDate,
      lastStooqClose,
      firstOverflowDate,
      firstOverflowClose,
      ratio: ratio.toFixed(6),
      suggestedFactor: factor !== null ? factor.toFixed(6) : null,
      suggestedRatio: ratio.toFixed(6),
    })
    .onConflictDoNothing()
}

/** Convert an OHLCV row from cachest/OpenBB into a compact close bar. */
export function ohlcvToClose(row: Record<string, unknown>): { date: string; close: string } | null {
  const rawDate = String(row.date ?? row.index ?? "")
  const date = rawDate.slice(0, 10)
  const close = Number(row.close)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(close)) return null
  return { date, close: close.toFixed(8) }
}

/** Resolve the stooq ticker form for a system symbol (US symbols carry .US). */
export function stooqTickerFor(symbol: string): string {
  return `${symbol.toUpperCase().split(".")[0]}.US`
}

/**
 * D81 — resolve the cachest OHLCV upstream for an asset class.
 *
 *   crypto    → /crypto/ohlcv/{pair}        (pair kept as-is, e.g. BTC-USD)
 *   bond      → /fixedincome/ohlcv/{symbol} (savings-bond engine, e.g. ROD1033)
 *   corp_bond → /ohlcv/{symbol}             (biznesradar Catalyst, e.g. BST0327.WA)
 *   fund      → /ohlcv/{symbol}             (biznesradar TFI, e.g. NNEP25.TFI)
 *   stock/etf → /ohlcv/{symbol}             (equity tier, .US stripped for OpenBB)
 *
 * Only `stock`/`etf` ride the stooq-overflow split path (see getPriceBarSeries);
 * the other classes never touch stooq and write their series straight to overflow.
 */
export function upstreamFor(
  assetType: PriceBarAssetType,
  symbol: string,
  start: string,
  end: string,
): Promise<Array<Record<string, unknown>>> {
  switch (assetType) {
    case "crypto":
      return fetchCryptoOhlcv(symbol, start, end)
    case "bond":
      return fetchBondOhlcv(venueFreeSymbol(symbol), start, end)
    case "corp_bond":
    case "fund":
      return fetchOhlcv(symbol, start, end)
    case "stock":
    case "etf":
    default:
      return fetchOhlcv(providerSymbol(symbol), start, end)
  }
}

/**
 * Read-through daily close series. Returns the current DB state with a
 * `stale` flag. When stale and upstream is not cooling down, fills the gap.
 */
export async function getPriceBarSeries(
  db: DB,
  symbol: string,
  from: string,
  to: string,
  now = new Date(),
): Promise<PriceBarSeriesResult> {
  const full = await queryView(db, symbol, from, to)
  const empty = full.length === 0
  const lastDate = await lastDateForSymbol(db, symbol)

  let stale = true
  let rows = full

  if (lastDate !== null && !hasGap(lastDate, now)) {
    stale = false
  } else if (empty || lastDate !== null) {
    const meta = await readMetadata(db, symbol)
    if (recentlyFailed(meta, now)) {
      stale = true
    } else {
      // D81 — route the gap fill by asset class (ticker_reference.asset_type,
      // falling back to `stock` when the symbol is unlisted so the equity path
      // is unchanged). stooqTicker is only meaningful for the stock/etf
      // split-boundary check; the other classes write straight to overflow.
      const assetType = normalizeAssetType(await lookupAssetType(db, symbol))
      const stooqTicker = stooqTickerFor(symbol) // keep .US for stooq boundary check
      const hadRowsBefore = (await minOverflowDate(db, symbol)) !== null
      try {
        const raw = (await upstreamFor(assetType, symbol, lastDate ?? "1900-01-01", to)) ?? []
        const have = new Set(rows.map((r) => r.date))
        const bars = raw
          .map(ohlcvToClose)
          .filter((b): b is { date: string; close: string } => b !== null && !have.has(b.date))
        const hadNewBars = bars.length > 0
        await upsertOverflowBars(db, symbol, bars)
        await db
          .insert(priceBarMetadata)
          .values({ symbol, lastFetchedAt: new Date(), fetchStatus: "ok" })
          .onConflictDoUpdate({
            target: priceBarMetadata.symbol,
            set: { lastFetchedAt: sql`now()`, fetchStatus: "ok" },
          })
        if (!hadRowsBefore && hadNewBars && (assetType === "stock" || assetType === "etf")) {
          await checkSplitBoundary(db, symbol, stooqTicker).catch(() => undefined)
        }
        rows = await queryView(db, symbol, from, to)
        stale = false
      } catch {
        await db
          .insert(priceBarMetadata)
          .values({ symbol, lastFetchedAt: new Date(), fetchStatus: "failed" })
          .onConflictDoUpdate({
            target: priceBarMetadata.symbol,
            set: { lastFetchedAt: sql`now()`, fetchStatus: "failed" },
          })
        stale = true
      }
    }
  }

  return {
    symbol,
    stale,
    currency: null,
    dates: rows.map((r) => r.date),
    closes: rows.map((r) => Number(r.close)),
  }
}

/**
 * H4 — passive write-through.
 *
 * Called fire-and-forget (non-blocking) after a `/history` or `/price?date=`
 * response is served from openst. Upserts daily close bars into `price_bars`
 * so the overflow table accumulates organically for well-queried symbols,
 * without any dedicated scheduler.
 *
 * Errors are swallowed — the write-through is best-effort and must never
 * affect the response already sent to the client.
 */
export function backgroundUpsertBars(
  db: DB,
  symbol: string,
  rows: Array<{ date: string; close: number | string }>,
): void {
  if (rows.length === 0) return
  const bars = rows
    .map((r) => ({
      date: String(r.date).slice(0, 10),
      close: Number(r.close).toFixed(8),
    }))
    .filter((b) => /^\d{4}-\d{2}-\d{2}$/.test(b.date) && Number.isFinite(Number(b.close)))
  if (bars.length === 0) return
  void upsertOverflowBars(db, symbol, bars).catch(() => undefined)
}