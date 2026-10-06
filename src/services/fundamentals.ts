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
