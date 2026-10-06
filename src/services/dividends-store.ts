/** Dividend row identity and state lifecycle (issue #71).
 *
 *  One row per (symbol, ex_date). `ex_date` is the only cross-provider identity
 *  every shape shares: openst's normalized history rows use `date`, yfinance
 *  emits `ex_dividend_date`, dividendmax adds `payment_date` + a `status`
 *  field, biznesradar uses Polish `wyplacona`/`uchwalona`/`rekomendowana`
 *  statuses. `payment_date` is NOT identity — it is mutable, so a row keyed on
 *  `(symbol, ex_date, payment_date)` would fork when a forecast's payment date
 *  moves. It is stored, but as an attribute.
 */

export type DividendState = "predicted" | "confirmed" | "paid"
export type FetchStatus = "ok" | "empty"

export interface NormalizedDividend {
  exDate: string
  paymentDate: string | null
  declarationDate: string | null
  amount: string | null
  currency: string | null
  status: DividendState
  raw: Record<string, unknown>
}

const EX_DATE_KEYS = ["ex_dividend_date", "ex_date", "date"] as const
const PAYMENT_DATE_KEYS = ["payment_date", "pay_date"] as const
const DECLARATION_DATE_KEYS = ["declaration_date", "decl_date"] as const

function firstString(row: Record<string, unknown>, keys: readonly string[]): string | null {
  for (const key of keys) {
    const v = row[key]
    if (typeof v === "string" && v.trim() !== "") return v.trim()
    if (typeof v === "number" && Number.isFinite(v)) return String(v)
  }
  return null
}

/** First 10 chars of an ISO date, or null. Providers deliver `2026-08-10`,
 *  an ISO instant, or sometimes a datetime string — all share the date prefix. */
function isoDate(value: string | null): string | null {
  if (value === null) return null
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(value)
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null
}

/** Map a provider's raw status word onto the three-state lifecycle.
 *
 *  dividendmax uses `Paid`/`Forecast`; biznesradar uses `wyplacona` (paid),
 *  `uchwalona` (declared ⇒ confirmed), `rekomendowana` (recommended ⇒ predicted).
 *  openst's normalized history rows carry no status: the ex-date tells — a row
 *  about a past ex-date on the paid-history path is `paid`, a future one is
 *  `confirmed` (it was declared to get that far). */
export function deriveState(raw: Record<string, unknown>, exDate: string, today: string): DividendState {
  const s = firstString(raw, ["status"])?.toLowerCase() ?? ""
  if (s.includes("paid") || s.includes("wyplacona")) return "paid"
  if (s.includes("forecast") || s.includes("predicted") || s.includes("rekomendowana")) return "predicted"
  if (s.includes("declare") || s.includes("confirmed") || s.includes("uchwalona")) return "confirmed"
  return exDate <= today ? "paid" : "confirmed"
}

/** Normalise one raw provider row, or null when it has no usable ex-date. */
export function normalizeDividendRow(
  raw: Record<string, unknown>,
  today: string,
): NormalizedDividend | null {
  const exDate = isoDate(firstString(raw, EX_DATE_KEYS))
  if (exDate === null) return null
  const amount = firstString(raw, ["amount"])
  return {
    exDate,
    paymentDate: isoDate(firstString(raw, PAYMENT_DATE_KEYS)),
    declarationDate: isoDate(firstString(raw, DECLARATION_DATE_KEYS)),
    amount: amount === null ? null : amount,
    currency: firstString(raw, ["currency"]),
    status: deriveState(raw, exDate, today),
    raw,
  }
}

/** The whole body, with rows that have no ex-date dropped and duplicates
 *  collapsed onto the first row for that ex-date (provider order preserved). */
export function normalizeDividendRows(
  rows: Array<Record<string, unknown>>,
  today: string,
): NormalizedDividend[] {
  const seen = new Set<string>()
  const out: NormalizedDividend[] = []
  for (const raw of rows) {
    const row = normalizeDividendRow(raw, today)
    if (row === null || seen.has(row.exDate)) continue
    seen.add(row.exDate)
    out.push(row)
  }
  return out
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

import { and, desc, eq, sql } from "drizzle-orm"
import type { DB } from "../db/index.js"
import { dividends, dividendsFetchState } from "../db/schema.js"
import { UpstreamError } from "../adapters/cachest.js"

/** Revalidation cadence per scope, in hours. 7d everywhere: paid rows are
 *  immutable, and a predicted row revised by the provider is caught within a
 *  week — long enough that a portfolio full of symbols costs one walk a week,
 *  not one per navigation. Scopes are `history` (paid/declared) and
 *  `predicted` (dividendmax forecast), because the two are independent
 *  provider passes. */
const SCOPE_WINDOW_HOURS: Record<string, number> = {
  history: 7 * 24,
  predicted: 7 * 24,
}

/** How long a scope that came back empty stays unrefetched: a symbol that
 *  never pays must not re-walk the providers on every page view. */
export const EMPTY_BACKOFF_HOURS = 7 * 24

/** Revalidation window in hours for a scope. */
export function windowHours(scope: string): number {
  return SCOPE_WINDOW_HOURS[scope] ?? 7 * 24
}

export interface StoredDividend {
  exDate: string
  paymentDate: string | null
  declarationDate: string | null
  amount: string | null
  currency: string | null
  status: DividendState
  provider: string | null
  fetchedAt: Date
}

/** Every stored dividend for one symbol, NEWEST first (newest first is the
 *  order every provider sends, and the order the research tab shows). */
export async function loadDividends(db: DB, symbol: string): Promise<StoredDividend[]> {
  const rows = await db
    .select()
    .from(dividends)
    .where(eq(dividends.symbol, symbol))
    .orderBy(desc(dividends.exDate))
  return rows.map((r) => ({
    exDate: r.exDate,
    paymentDate: r.paymentDate,
    declarationDate: r.declarationDate,
    amount: r.amount,
    currency: r.currency,
    status: r.status as DividendState,
    provider: r.provider,
    fetchedAt: r.fetchedAt,
  }))
}

/**
 * Upsert one provider body. Returns the number of rows written.
 *
 *  Last-write-wins on `(symbol, ex_date)`, with one guard: a `predicted`
 *  incoming row never overwrites a stored `confirmed`/`paid` row — the
 *  store keeps the most evolved state of each ex-date, so a stale forecast
 *  refreshed from cachest cannot resurrect a declared dividend back to
 *  "predicted, no amount". `confirmed`/`paid` always replace `predicted`
 *  in place, even when the payment date moves.
 *
 *  Every derived column is in the set clause, not just the payload — a
 *  provider switch may declare or drop `payment_date`/`currency`, and leaving
 *  them out would strand the previous provider's metadata.
 */
export async function upsertDividends(
  db: DB,
  symbol: string,
  provider: string | null,
  rows: Array<Record<string, unknown>>,
  today: string,
): Promise<number> {
  let written = 0
  for (const row of normalizeDividendRows(rows, today)) {
    const [existing] = await db
      .select({ status: dividends.status })
      .from(dividends)
      .where(and(eq(dividends.symbol, symbol), eq(dividends.exDate, row.exDate)))
    // Guard: predicted never clobbers confirmed/paid.
    if (existing !== undefined && existing.status !== "predicted" && row.status === "predicted") {
      continue
    }
    await db
      .insert(dividends)
      .values({
        symbol,
        exDate: row.exDate,
        paymentDate: row.paymentDate,
        declarationDate: row.declarationDate,
        amount: row.amount,
        currency: row.currency,
        status: row.status,
        provider,
        payload: row.raw,
      })
      .onConflictDoUpdate({
        target: [dividends.symbol, dividends.exDate],
        set: {
          paymentDate: row.paymentDate,
          declarationDate: row.declarationDate,
          amount: row.amount,
          currency: row.currency,
          status: row.status,
          provider,
          payload: row.raw,
          fetchedAt: new Date(),
        },
      })
    written += 1
  }
  return written
}

/**
 * Drop `predicted` rows for a symbol that a fresh forecast fetch no longer
 * returns. Scoped to predicted rows only: a confirmed/paid row is history and
 * never pruned, and a prune of "no longer predicted" means the symbol's
 * forecast changed, not that its history is wrong.
 */
export async function prunePredictedMissing(
  db: DB,
  symbol: string,
  freshExDates: string[],
): Promise<number> {
  const rows = await db
    .select({ exDate: dividends.exDate })
    .from(dividends)
    .where(and(eq(dividends.symbol, symbol), eq(dividends.status, "predicted")))
  let removed = 0
  for (const row of rows) {
    if (freshExDates.includes(row.exDate)) continue
    await db
      .delete(dividends)
      .where(and(eq(dividends.symbol, symbol), eq(dividends.exDate, row.exDate)))
    removed += 1
  }
  return removed
}

/**
 * Whether a scope must be fetched from upstream.
 *
 *  True when there is nothing stored, or the stored copy is past its window.
 *  False for a scope last seen empty until the backoff expires. `now` is a
 *  parameter so a caller (and every test) controls the clock.
 */
export async function shouldRefetch(
  db: DB,
  symbol: string,
  scope: string,
  now: Date = new Date(),
): Promise<boolean> {
  const [state] = await db
    .select()
    .from(dividendsFetchState)
    .where(and(eq(dividendsFetchState.symbol, symbol), eq(dividendsFetchState.scope, scope)))

  if (state === undefined) return true
  const last = state.lastFetchedAt
  if (last === null) return true
  const ageHours = (now.getTime() - new Date(last).getTime()) / 3_600_000
  if (ageHours < 0) return true
  const window = state.lastStatus === "empty" ? EMPTY_BACKOFF_HOURS : windowHours(scope)
  return ageHours >= window
}

/** Record that a scope was walked. `empty` is a backoff marker, never data. */
export async function markFetch(
  db: DB,
  symbol: string,
  scope: string,
  status: FetchStatus,
  at: Date = new Date(),
): Promise<void> {
  await db
    .insert(dividendsFetchState)
    .values({ symbol, scope, lastFetchedAt: at, lastStatus: status })
    .onConflictDoUpdate({
      target: [dividendsFetchState.symbol, dividendsFetchState.scope],
      set: { lastFetchedAt: at, lastStatus: status },
    })
}

/**
 * One symbol's dividends, served from the store and refreshed on read.
 *
 *  Same read-path contract as `loadStatementsThrough` (#51):
 *
 *    1. read the store
 *    2. if `shouldRefetch`, walk the provider tier once and upsert
 *    3. read the store again and return *that*
 *
 *  Step 3 means the response is built from exactly what persisted, so a warm
 *  and a cold read agree. A provider 404 is recorded as `empty` — one walk a
 *  week, not one per page view — and everything else propagates as a 502.
 */
export async function loadDividendsThrough(
  db: DB,
  symbol: string,
  fetchRows: () => Promise<Array<Record<string, unknown>>>,
  provider: string | null = null,
  now: Date = new Date(),
): Promise<StoredDividend[]> {
  const scope = "history"
  if (await shouldRefetch(db, symbol, scope, now)) {
    try {
      const rows = await fetchRows()
      if (rows.length > 0) {
        await upsertDividends(db, symbol, provider, rows, now.toISOString().slice(0, 10))
        await markFetch(db, symbol, scope, "ok", now)
      } else {
        await markFetch(db, symbol, scope, "empty", now)
      }
    } catch (e) {
      if (e instanceof UpstreamError && e.status === 404) {
        await markFetch(db, symbol, scope, "empty", now)
        return loadDividends(db, symbol)
      }
      throw e
    }
  }
  return loadDividends(db, symbol)
}
