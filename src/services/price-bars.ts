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
import { priceBarMetadata, priceBars, splitCandidates } from "../db/schema.js"
import {
  assetTypeForSymbol,
  normalizeAssetType,
  type AssetType,
} from "../db/tickerref-queries.js"
import { fetchOhlcv, fetchBondOhlcv, fetchCryptoOhlcv, UpstreamError } from "../adapters/cachest.js"
import { providerSymbol, venueFreeSymbol } from "../adapters/symbol.js"
import { resolveInstrumentCurrency } from "./instrument-currency.js"

// D81/34 — the asset-class helpers live in db/tickerref-queries.ts (shared
// with the quote dispatch); re-exported here for existing importers.
export { normalizeAssetType, assetTypeForSymbol }
export const lookupAssetType = assetTypeForSymbol
/** D81 asset class for price-bars routing (canonical lowercase). */
export type PriceBarAssetType = AssetType

const STALE_AFTER_DAYS = 3
/** §63.9.2 — cooldown after a failure whose upstream status says "there is
 * nothing to fetch" (a 404). Retrying an hour later is the point: the symbol
 * genuinely has no history and hammering it would be worse. */
export const COOLDOWN_MS = 60 * 60 * 1000
/** …and after a *transient* failure (429/502/503/504, a network error, a body that
 * would not parse). These say nothing about the symbol — most importantly
 * cachest returns 503 for its own rate limiter *without calling the upstream at
 * all* — so they must be retried in minutes, not parked for an hour. Before
 * §63.9.2 both cases shared one hour-long breaker, so a symbol that merely lost
 * a race in a 175-symbol sweep kept no price history for the rest of the day. */
export const TRANSIENT_COOLDOWN_MS = 5 * 60 * 1000
/** `last_error` is a diagnostic column, not a log store. */
const MAX_ERROR_CHARS = 300

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
  /** ISO-4217 currency of the served closes — the `?currency=` target when
   * converted, the native base otherwise (§48.2). */
  currency: string | null
  /** ISO-4217 the closes are natively denominated in (§48.2). */
  baseCurrency: string | null
  /** Earliest fx_rates date covering the window; bars before it are
   * unconverted (native base). Null when no conversion was applied. */
  fxFrom: string | null
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

/**
 * §48.2 — the parameterized conversion join (`price_bars_as`):
 * `close × rate(target)/rate(base)` over `price_bars_all ⨝ fx_rates`, both
 * rates EUR-quoted (the D27 cross-rate expressed in SQL). No new indexes
 * are needed — the fx joins are equality probes on the (rate_date, currency)
 * PK, and the ≤~2.5k-bar probe against the ~200k-row fx build side is a
 * trivial hash join (verified by EXPLAIN in the tests).
 *
 * A bar whose date has no rate row (before the fx floor, or inside a source
 * gap such as the ECB's ISK break 2008–2018) is served UNCONVERTED in the
 * base currency — no carry-forward. `fx_from` (repeated on every row) is the
 * earliest converted date in the window; null when nothing converted.
 *
 * Exported so the EXPLAIN test can pin the plan shape of the real query.
 */
export function conversionJoinSql(
  symbol: string,
  from: string,
  to: string,
  baseCcy: string,
  targetCcy: string,
) {
  const base = baseCcy.toUpperCase()
  const target = targetCcy.toUpperCase()
  // EUR is the implicit fx base — there is no EUR row in fx_rates.
  const baseRate = base === "EUR" ? sql`1.0::numeric` : sql`fb.rate`
  const convertible =
    base === "EUR" ? sql`f.rate is not null` : sql`f.rate is not null and fb.rate is not null`
  return sql`
    select b.symbol,
      b.date,
      case when ${convertible} then b.close * f.rate / ${baseRate} else b.close end as close,
      b.source,
      min(case when ${convertible} then b.date end) over () as "fxFrom"
    from instruments.price_bars_all b
    left join instruments.fx_rates f
      on f.rate_date = b.date and f.currency = ${target}
    left join instruments.fx_rates fb
      on fb.rate_date = b.date and fb.currency = ${base}
    where b.symbol = ${symbol}
      and b.date between ${from} and ${to}
    order by b.date asc, case when b.source = 'stooq' then 0 else 1 end
  `
}

export async function queryViewAs(
  db: DB,
  symbol: string,
  from: string,
  to: string,
  baseCcy: string,
  targetCcy: string,
): Promise<Array<PriceBarRow & { fxFrom: string | null }>> {
  const result = await db.execute(conversionJoinSql(symbol, from, to, baseCcy, targetCcy))
  return rowsOf<PriceBarRow & { fxFrom: string | null }>(result).map((r) => ({
    ...r,
    fxFrom: (r.fxFrom as string | null) ?? null,
  }))
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

/**
 * Whether a failure is worth retrying soon rather than parking the symbol.
 *
 * §63.9.2. An `UpstreamError` carries the status cachest answered with, and
 * cachest's own rate limiter answers 503 *without asking the provider anything*
 * (plan §63.9) — so a 503 says nothing about whether the symbol has history.
 * Everything that is not an explicit "no such data" is treated as transient.
 * A non-`UpstreamError` (fetch threw, body would not parse, a DB error inside the
 * try block) is transient too: retrying it is cheap and parking it is not.
 */
export function isTransientFailure(error: unknown): boolean {
  if (error instanceof UpstreamError) return error.status !== 404
  return true
}

/** Cooldown that applies to a recorded failure. */
export function cooldownFor(lastError: string | null | undefined): number {
  // A recorded 404 is the only "there is nothing to fetch" signal we persist, so
  // it is the only one that earns the hour-long breaker. Everything else — a 503
  // from cachest's rate limiter, a 502, a timeout, a thrown fetch — is transient.
  return lastError?.includes("HTTP 404") ? COOLDOWN_MS : TRANSIENT_COOLDOWN_MS
}

/** A one-line, bounded description of a failure for `price_bar_metadata.last_error`. */
export function describeFailure(error: unknown): string {
  const raw =
    error instanceof UpstreamError
      ? `HTTP ${error.status} ${error.message}`
      : `${(error as Error)?.name ?? "Error"}: ${(error as Error)?.message ?? String(error)}`
  return raw.length > MAX_ERROR_CHARS ? `${raw.slice(0, MAX_ERROR_CHARS - 1)}…` : raw
}

/** Whether an earlier failed fetch should keep us from hitting upstream again. */
export function recentlyFailed(
  meta: { lastFetchedAt: Date | null; fetchStatus: string } | undefined,
  now = new Date(),
  cooldownMs = COOLDOWN_MS,
): boolean {
  if (!meta || meta.fetchStatus !== "failed" || !meta.lastFetchedAt) return false
  return now.getTime() - meta.lastFetchedAt.getTime() < cooldownMs
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
 *
 * §48.2 — with `opts.targetCcy` (≠ the resolved base) the final read is the
 * currency-converted join (`queryViewAs`); the response then carries
 * `baseCurrency` + `fxFrom` and `currency` = the target. Same/absent target
 * short-circuits to the plain base series (identity, no join).
 */
export async function getPriceBarSeries(
  db: DB,
  symbol: string,
  from: string,
  to: string,
  now = new Date(),
  opts: { targetCcy?: string | null; baseCcy?: string | null } = {},
): Promise<PriceBarSeriesResult> {
  const resolvedBase = await resolveInstrumentCurrency(db, symbol)
  // §63.10.5 — the caller's declared base wins ONLY where the local resolver is
  // silent. plan §48.3b already established that a caller which knows an
  // instrument's currency (wallets reads it off the position/transaction) fetches
  // `?currency=<base>`; the local resolver is a fallback for read paths that have
  // no such fact, not an authority that can veto the caller. Without this, a
  // ticker listed on several venues in different countries (AFL: NYSE+ASX,
  // META: NASDAQ+LSE+STO) made `?currency=` 400 — and since §48.2 refuses an
  // unresolvable base, one such position took its whole portfolio unvaluable.
  const declared = opts.baseCcy?.toUpperCase() ?? null
  //
  // §71 — DO NOT "fix" this by letting the caller win outright. Measured over
  // PROD's 98 open symbols, the two disagree on exactly two, and in BOTH the
  // resolver is right and the caller is corrupt:
  //
  //   CRI.WA  position CAD (a resolver guess that overwrote the import's PLN)
  //           → resolver PLN
  //   SRT.F   position GBP → resolver EUR
  //
  // So the resolver winning is currently what keeps the stored bar series out of
  // CAD and GBP. Inverting it would silently reintroduce the corruption these two
  // positions still carry, and nothing would fail — the same way nothing failed
  // when the currency was first wrong. The precedence is defensible only because
  // the resolver is venue-aware and the caller's value is whatever last wrote the
  // position; that is an argument to keep hardening the resolver (§71 removed
  // its two guesses), not an argument to hand authority to the caller.
  const baseCcy = resolvedBase ?? declared
  const target = opts.targetCcy?.toUpperCase() ?? null
  const convertTo =
    target && baseCcy && target !== baseCcy.toUpperCase()
      ? { base: baseCcy, target: target.toUpperCase() }
      : null

  const full = convertTo
    ? await queryViewAs(db, symbol, from, to, convertTo.base, convertTo.target)
    : await queryView(db, symbol, from, to)
  const empty = full.length === 0
  const lastDate = await lastDateForSymbol(db, symbol)

  let stale = true
  let rows = full

  if (lastDate !== null && !hasGap(lastDate, now)) {
    stale = false
  } else if (empty || lastDate !== null) {
    const meta = await readMetadata(db, symbol)
    if (recentlyFailed(meta, now, cooldownFor(meta?.lastError))) {
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
        // `now` (not now()) so the breaker is measured against the same clock the
        // caller passed in — otherwise it is untestable and, in a replayed window,
        // nonsense.
        await db
          .insert(priceBarMetadata)
          .values({ symbol, lastFetchedAt: now, fetchStatus: "ok", lastError: null })
          .onConflictDoUpdate({
            target: priceBarMetadata.symbol,
            set: { lastFetchedAt: now, fetchStatus: "ok", lastError: null },
          })
        if (!hadRowsBefore && hadNewBars && (assetType === "stock" || assetType === "etf")) {
          await checkSplitBoundary(db, symbol, stooqTicker).catch(() => undefined)
        }
        rows = convertTo
          ? await queryViewAs(db, symbol, from, to, convertTo.base, convertTo.target)
          : await queryView(db, symbol, from, to)
        stale = false
      } catch (e) {
        // §63.9.2 — record *why*, and let `recentlyFailed` above pick the cooldown
        // from it: a 404 keeps the hour-long breaker, a 503 (cachest's rate
        // limiter, which never reached the provider) only parks the symbol for
        // minutes. The bare `catch` used to make both indistinguishable.
        await db
          .insert(priceBarMetadata)
          .values({
            symbol,
            lastFetchedAt: now,
            fetchStatus: "failed",
            lastError: describeFailure(e),
          })
          .onConflictDoUpdate({
            target: priceBarMetadata.symbol,
            set: {
              lastFetchedAt: now,
              fetchStatus: "failed",
              lastError: describeFailure(e),
            },
          })
        stale = true
      }
    }
  }

  // §48.2 — bars with no fx row for their date stay in the base currency;
  // fxFrom marks the first converted date (null when nothing converted).
  let fxFrom: string | null = null
  if (convertTo) {
    for (const r of rows as Array<PriceBarRow & { fxFrom: string | null }>) {
      if (r.fxFrom !== null) {
        fxFrom = r.fxFrom
        break
      }
    }
  }

  return {
    symbol,
    stale,
    currency: convertTo ? convertTo.target : baseCcy,
    baseCurrency: baseCcy,
    fxFrom,
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