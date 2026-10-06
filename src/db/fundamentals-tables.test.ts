import { readFileSync } from "fs"
import { fileURLToPath } from "url"
import { sql } from "drizzle-orm"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { closeDb, getDb, type DB } from "../db/index.js"
import { createTestDb } from "../db/test-db.js"
import { fundamentalsStatements } from "../db/schema.js"
import { rowIdentity } from "../services/fundamentals.js"

/** The migration journal itself is the fixture — `createTestDb()` replays every
 *  file in `drizzle/`, so a migration that PGlite cannot apply fails here. */
const FIXTURES = fileURLToPath(new URL("../../test/fixtures/fundamentals", import.meta.url))

interface Envelope {
  provider: string | null
  rows: Array<Record<string, unknown>>
}

function body(provider: string, file: string): Envelope {
  return JSON.parse(readFileSync(`${FIXTURES}/${provider}/${file}`, "utf8")) as Envelope
}

async function rowsToDb(
  db: DB,
  symbol: string,
  statement: string,
  period: string,
  provider: string,
  rows: Array<Record<string, unknown>>,
): Promise<void> {
  for (const row of rows) {
    const id = rowIdentity(row)
    if (id === null) continue
    await db
      .insert(fundamentalsStatements)
      .values({
        symbol,
        statement,
        period,
        periodKey: id.periodKey,
        periodEnd: id.periodEnd,
        fiscalYear: id.fiscalYear,
        fiscalPeriod: id.fiscalPeriod,
        provider,
        payload: row,
      })
      .onConflictDoUpdate({
        target: [fundamentalsStatements.symbol, fundamentalsStatements.statement, fundamentalsStatements.period, fundamentalsStatements.periodKey],
        // Every derived column has to be in the set clause, not just the payload.
        // A provider switch changes which of them the provider declared at all —
        // yfinance sends no fiscal_year, fmp sends both — so leaving them out
        // strands the previous provider's metadata on a row it no longer
        // describes.
        set: {
          payload: row,
          provider,
          periodEnd: id.periodEnd,
          fiscalYear: id.fiscalYear,
          fiscalPeriod: id.fiscalPeriod,
          fetchedAt: new Date(),
        },
      })
  }
}

describe("fundamentals_statements on the real journal", () => {
  let db: DB
  let client: { close: () => Promise<void> }

  beforeAll(async () => {
    const t = await createTestDb()
    db = t.db as unknown as DB
    client = t.client
  })
  afterAll(async () => {
    await client.close()
  })

  it("exists after createTestDb(), which replays drizzle/0004_fundamentals.sql", async () => {
    const found = await db.execute<{ n: number }>(
      sql`select count(*)::int as n from information_schema.tables
          where table_schema = 'instruments' and table_name = 'fundamentals_statements'`,
    )
    expect(found.rows[0]?.n).toBe(1)
  })

  it("collapses two upserts of the same period onto one row", async () => {
    await rowsToDb(db, "AAPL", "income", "annual", "yfinance", body("yfinance", "AAPL-income-annual.json").rows)
    const first = await db.select().from(fundamentalsStatements)
    expect(first.length).toBe(body("yfinance", "AAPL-income-annual.json").rows.length)

    await rowsToDb(db, "AAPL", "income", "annual", "yfinance", body("yfinance", "AAPL-income-annual.json").rows)
    const second = await db.select().from(fundamentalsStatements)
    expect(second.length).toBe(first.length)
  })

  it("keeps both scopes when they share a period end", async () => {
    await rowsToDb(db, "AAPL", "income", "quarter", "yfinance", body("yfinance", "AAPL-income-quarter.json").rows)
    const rows = await db.select().from(fundamentalsStatements)
    // 2025-09-30 is both the FY2025 annual row and the 2025Q3 quarterly row.
    const shared = rows.filter((r) => r.periodEnd === "2025-09-30")
    expect(shared.length).toBe(2)
    expect(shared.map((r) => r.period).sort()).toEqual(["annual", "quarter"])
    expect(shared.map((r) => r.periodKey)).toEqual(["2025-Q3", "2025-Q3"])
  })

  it("stores one row per period when the provider changes", async () => {
    // The fmp body has five periods where yfinance had four, and both agree on
    // the period key for the years they share — so a provider switch extends the
    // history instead of forking it.
    await rowsToDb(db, "AAPL", "income", "annual", "fmp", body("fmp", "AAPL-income-annual.json").rows)
    const rows = await db
      .select()
      .from(fundamentalsStatements)
      .where(sql`${fundamentalsStatements.symbol} = 'AAPL'
                   and ${fundamentalsStatements.statement} = 'income'
                   and ${fundamentalsStatements.period} = 'annual'`)

    expect(rows.length).toBe(5)
    expect(new Set(rows.map((r) => r.periodKey)).size).toBe(5)
    // …and every row now records fmp as the provider that answered.
    expect(rows.every((r) => r.provider === "fmp")).toBe(true)
  })

  it("round-trips a payload and its provider-declared fiscal labels", async () => {
    const [row] = await db
      .select()
      .from(fundamentalsStatements)
      .where(sql`${fundamentalsStatements.symbol} = 'AAPL'
                   and ${fundamentalsStatements.periodKey} = '2025-Q3'
                   and ${fundamentalsStatements.period} = 'annual'`)
    expect(row!.fiscalYear).toBe(2025)
    expect(row!.fiscalPeriod).toBe("FY")
    expect(row!.periodEnd).toBe("2025-09-27")
    expect(row!.payload).toMatchObject({ reported_currency: "USD" })
  })
})
