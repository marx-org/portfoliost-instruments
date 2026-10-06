/** Row identity for stored financial statements (issue #52).
 *
 *  A statement row arrives as a bare provider record with no statement schema
 *  (§79.3): `fmp` emits typed snake_case keys for every symbol, `yfinance`
 *  emits per-listing passthrough names. Measured on 2026-10-06 — see
 *  `test/fixtures/fundamentals/README.md` for the full capture.
 *
 *  Two measured facts decide the key:
 *
 *  - `period_ending` is the ONLY identity key in a yfinance row (no
 *    `fiscal_year`, no `fiscal_period`), and the two providers disagree about
 *    the same period: Apple's FY2025 is `2025-09-27` per fmp and `2025-09-30`
 *    per yfinance, because fmp uses the true 52/53-week fiscal calendar and
 *    yfinance reports the calendarised quarter end.
 *  - `fiscal_year`+`fiscal_period` are not comparable either — fmp labels the
 *    quarter ending 2026-06-27 "Q3 of FY2026", which is calendar Q2.
 *
 *  So neither field is a cross-provider identity, and keying on either forks a
 *  symbol's history the moment the provider changes. The one value both shapes
 *  agree on is the calendar quarter containing `period_ending`: 2025-09-27 and
 *  2025-09-30 are both 2025Q3.
 *
 *  `period` is therefore part of the key too, and not as an afterthought: the
 *  same `period_ending` legitimately appears in both scopes (AAPL `2025-09-30`
 *  is the FY2025 annual row AND the 2025Q3 quarterly row), so an annual and a
 *  quarterly row for one quarter must not collide.
 */

export type StatementPeriod = "annual" | "quarter"

export interface StatementScope {
  statement: "income" | "balance" | "cash"
  period: StatementPeriod
}

export interface StatementRow extends Record<string, unknown> {}

/** The store's primary key for one statement row. */
export interface RowIdentity {
  /** `YYYY-Qn` of the calendar quarter containing the period end. */
  periodKey: string
  /** The provider's own period end, kept for display — NOT the identity. */
  periodEnd: string | null
  /** Provider-declared fiscal year, when it declared one. */
  fiscalYear: number | null
  /** Provider-declared fiscal period, when it declared one. */
  fiscalPeriod: string | null
}

const PERIOD_END_KEYS = ["period_ending", "period_end", "date"] as const

function firstString(row: StatementRow, keys: readonly string[]): string | null {
  for (const key of keys) {
    const v = row[key]
    if (typeof v === "string" && v.trim() !== "") return v.trim()
  }
  return null
}

function firstNumber(row: StatementRow, keys: readonly string[]): number | null {
  for (const key of keys) {
    const v = row[key]
    if (typeof v === "number" && Number.isFinite(v)) return v
    if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v)
  }
  return null
}

/** The first 10 chars of an ISO date, or null when the value is not a date.
 *
 *  A `date` on a statement row is a period end in every provider measured, but
 *  the value arrives in three shapes: `2025-09-30` (yfinance), an ISO instant
 *  `2025-09-27T00:00:00.000` (fmp through pandas), and a full timestamp. The
 *  first 10 chars are the date in all three. */
function isoDate(value: string | null): string | null {
  if (value === null) return null
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(value)
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null
}

/** `YYYY-Qn` for a date, or null when the month is not 1-12. */
function calendarQuarter(date: string): string | null {
  const m = /^(\d{4})-(\d{2})-\d{2}$/.exec(date)
  if (!m) return null
  const month = Number(m[2])
  if (month < 1 || month > 12) return null
  return `${m[1]}-Q${Math.floor((month - 1) / 3) + 1}`
}

/** Identity of one statement row, or null when the row carries no period at all.
 *
 *  A row with no usable period end is not stored. Inventing a key for it would
 *  put an unidentifiable row into a table whose whole point is that a period is
 *  addressable. */
export function rowIdentity(row: StatementRow): RowIdentity | null {
  const rawEnd = firstString(row, PERIOD_END_KEYS)
  const periodEnd = isoDate(rawEnd)
  const quarter = periodEnd === null ? null : calendarQuarter(periodEnd)

  if (quarter === null) {
    // No usable date. The last resort is a provider that declares only a fiscal
    // year and period — `YYYY-FY` / `YYYY-Q3`. It is not comparable with a
    // calendar-quarter key, so it must not be mixed into the same column
    // silently: such a row is dropped rather than keyed under a value that
    // would collide with a different period.
    return null
  }

  return {
    periodKey: quarter,
    periodEnd,
    fiscalYear: firstNumber(row, ["fiscal_year", "calendar_year"]),
    fiscalPeriod: firstString(row, ["fiscal_period", "period"]) ?? null,
  }
}

/** Identity for every row of a statement body, in provider order.
 *
 *  Rows without a usable period end are dropped — see `rowIdentity`. */
export function rowsIdentity(rows: StatementRow[]): RowIdentity[] {
  const out: RowIdentity[] = []
  for (const row of rows) {
    const id = rowIdentity(row)
    if (id !== null) out.push(id)
  }
  return out
}

/** Rejection count for a body — how many rows `rowsIdentity` dropped. */
export function rejectedRowCount(rows: StatementRow[]): number {
  return rows.length - rowsIdentity(rows).length
}

// ---------------------------------------------------------------------------
// Store (pfire-docs #51 step 3)
// ---------------------------------------------------------------------------

import { and, eq, sql } from "drizzle-orm"
import type { DB } from "../db/index.js"
import { fundamentalsFetchState, fundamentalsMetrics, fundamentalsStatements } from "../db/schema.js"

/** How long a stored scope is served before upstream is asked again, in hours.
 *
 *  These are the whole answer to "when does the service ask for the newest
 *  data", and they are deliberately per scope rather than one number:
 *
 *  - An annual statement changes only when a new fiscal year is filed, and a
 *    filing lands weeks after the period ends. 30 days is a month's slack on a
 *    yearly event.
 *  - A quarter is restated for weeks after it is filed, so 7 days catches a
 *    restatement quickly without re-walking a provider every read.
 *  - Metrics are price-derived — P/E, market cap — and are wrong within a
 *    trading day, so this matches the 24h TTL they had in cachest.
 *
 *  Overridable per scope by env for operators who need to move a number without
 *  a release, and every test drives the clock explicitly rather than the env. */
const SCOPE_WINDOW_HOURS: Record<string, number> = {
  "income:annual": 30 * 24,
  "balance:annual": 30 * 24,
  "cash:annual": 30 * 24,
  "income:quarter": 7 * 24,
  "balance:quarter": 7 * 24,
  "cash:quarter": 7 * 24,
  metrics: 24,
}

/**
 * How long a scope that returned nothing stays unrefetched.
 *
 *  Without this, an ETF or a fund re-walks the whole provider chain on every
 *  read: none of them has financial statements, so every read is a miss, and a
 *  miss is exactly what the store is supposed to prevent. This is a backoff,
 *  not data — nothing is written to `fundamentals_statements`, so the symbol
 *  costs one walk a week instead of one per page view.
 *
 *  7 days, not the negative cache openst already keeps (6h): openst's is lost on
 *  a restart, this one is not, and a week is the shortest window that keeps a
 *  portfolio full of funds from walking providers on every navigation. */
export const EMPTY_BACKOFF_HOURS = 7 * 24

/** Scope string for one statement walk: `income:annual`. */
export function scopeKey(scope: StatementScope): string {
  return `${scope.statement}:${scope.period}`
}

/** Revalidation window in hours for a scope. */
export function windowHours(scope: string): number {
  return SCOPE_WINDOW_HOURS[scope] ?? 7 * 24
}

export interface StoredRow {
  periodKey: string
  periodEnd: string | null
  fiscalYear: number | null
  fiscalPeriod: string | null
  provider: string | null
  payload: StatementRow
  fetchedAt: Date
}

/** Every stored period for one statement scope, oldest first. */
export async function loadStatements(
  db: DB,
  symbol: string,
  scope: StatementScope,
): Promise<StoredRow[]> {
  const rows = await db
    .select()
    .from(fundamentalsStatements)
    .where(
      and(
        eq(fundamentalsStatements.symbol, symbol),
        eq(fundamentalsStatements.statement, scope.statement),
        eq(fundamentalsStatements.period, scope.period),
      ),
    )
    .orderBy(fundamentalsStatements.periodKey)

  return rows.map((r) => ({
    periodKey: r.periodKey,
    periodEnd: r.periodEnd,
    fiscalYear: r.fiscalYear,
    fiscalPeriod: r.fiscalPeriod,
    provider: r.provider,
    payload: r.payload as StatementRow,
    fetchedAt: r.fetchedAt,
  }))
}

/**
 * Upsert one statement body. Returns the number of rows written.
 *
 *  Last-write-wins on the primary key, and there is deliberately no delete: a
 *  restated quarter must overwrite its own period and nothing else, and a
 *  provider that stops returning an old period must not make the store forget it.
 *
 *  Every derived column is in the set clause, not just the payload — yfinance
 *  declares no fiscal labels and fmp declares both, so a provider switch that
 *  left them alone would strand the previous provider's metadata on a row it no
 *  longer describes.
 *
 *  `provider` is the §79.2 envelope's provider and may be null for a body cached
 *  before the envelope existed; that is recorded as null rather than guessed.
 */
export async function upsertStatements(
  db: DB,
  symbol: string,
  scope: StatementScope,
  provider: string | null,
  rows: StatementRow[],
): Promise<number> {
  let written = 0
  for (const payload of rows) {
    const id = rowIdentity(payload)
    if (id === null) continue
    await db
      .insert(fundamentalsStatements)
      .values({
        symbol,
        statement: scope.statement,
        period: scope.period,
        periodKey: id.periodKey,
        periodEnd: id.periodEnd,
        fiscalYear: id.fiscalYear,
        fiscalPeriod: id.fiscalPeriod,
        provider,
        payload,
      })
      .onConflictDoUpdate({
        target: [
          fundamentalsStatements.symbol,
          fundamentalsStatements.statement,
          fundamentalsStatements.period,
          fundamentalsStatements.periodKey,
        ],
        set: {
          payload,
          provider,
          periodEnd: id.periodEnd,
          fiscalYear: id.fiscalYear,
          fiscalPeriod: id.fiscalPeriod,
          fetchedAt: new Date(),
        },
      })
    written += 1
  }
  return written
}

export async function loadMetrics(db: DB, symbol: string): Promise<StoredRow | null> {
  const [row] = await db
    .select()
    .from(fundamentalsMetrics)
    .where(eq(fundamentalsMetrics.symbol, symbol))
  if (row === undefined) return null
  return {
    periodKey: "",
    periodEnd: null,
    fiscalYear: null,
    fiscalPeriod: null,
    provider: null,
    payload: row.payload as StatementRow,
    fetchedAt: row.fetchedAt,
  }
}

export async function upsertMetrics(
  db: DB,
  symbol: string,
  payload: Record<string, unknown>,
): Promise<void> {
  await db
    .insert(fundamentalsMetrics)
    .values({ symbol, payload })
    .onConflictDoUpdate({
      target: fundamentalsMetrics.symbol,
      set: { payload, fetchedAt: new Date() },
    })
}

export type FetchStatus = "ok" | "empty"

/**
 * Whether a scope must be fetched from upstream.
 *
 *  True when there is nothing stored, or the stored copy is past its window.
 *  False for a scope last seen empty until the backoff expires — see
 *  `EMPTY_BACKOFF_HOURS`.
 *
 *  `now` is a parameter so a caller (and every test) controls the clock rather
 *  than racing the wall.
 */
export async function shouldRefetch(
  db: DB,
  symbol: string,
  scope: string,
  now: Date = new Date(),
): Promise<boolean> {
  const [state] = await db
    .select()
    .from(fundamentalsFetchState)
    .where(
      and(
        eq(fundamentalsFetchState.symbol, symbol),
        eq(fundamentalsFetchState.scope, scope),
      ),
    )

  // Never fetched, or a fetch never recorded: a walk is due.
  if (state === undefined) return true

  const last = state.lastFetchedAt
  if (last === null) return true

  const ageHours = (now.getTime() - new Date(last).getTime()) / 3_600_000
  // A last_fetched_at in the future is as untrustworthy as no timestamp at all —
  // a restored database, a host clock jump, or two nodes with skewed clocks — and
  // serving it as fresh would pin the scope to stale data for the whole window
  // measured from a date that never happened. Walk again instead; it self-heals.
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
    .insert(fundamentalsFetchState)
    .values({ symbol, scope, lastFetchedAt: at, lastStatus: status })
    .onConflictDoUpdate({
      target: [fundamentalsFetchState.symbol, fundamentalsFetchState.scope],
      set: { lastFetchedAt: at, lastStatus: status },
    })
}

/** Stored periods per scope for one symbol — what a backfill actually wrote. */
export async function storedPeriodCounts(
  db: DB,
  symbol: string,
): Promise<Array<{ statement: string; period: string; periods: number }>> {
  return db
    .select({
      statement: fundamentalsStatements.statement,
      period: fundamentalsStatements.period,
      periods: sql<number>`count(*)::int`,
    })
    .from(fundamentalsStatements)
    .where(eq(fundamentalsStatements.symbol, symbol))
    .groupBy(fundamentalsStatements.statement, fundamentalsStatements.period)
}
