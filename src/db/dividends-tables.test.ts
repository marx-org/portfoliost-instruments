import { sql } from "drizzle-orm"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { closeDb, getDb, type DB } from "../db/index.js"
import { createTestDb } from "../db/test-db.js"
import { dividends, dividendsFetchState } from "../db/schema.js"

/** The migration journal itself is the fixture — `createTestDb()` replays every
 *  file in `drizzle/`, so a migration that PGlite cannot apply fails here. */
describe("dividends tables on the real journal", () => {
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

  it("exists after createTestDb(), which replays drizzle/0005_dividends.sql", async () => {
    for (const name of ["dividends", "dividends_fetch_state"]) {
      const found = await db.execute<{ n: number }>(
        sql`select count(*)::int as n from information_schema.tables
            where table_schema = 'instruments' and table_name = ${name}`,
      )
      expect(found.rows[0]?.n).toBe(1)
    }
  })

  it("collapses two upserts of the same ex-date onto one row", async () => {
    await db.insert(dividends).values({
      symbol: "AAPL", exDate: "2026-08-10", paymentDate: "2026-08-17", amount: "0.26",
      currency: "USD", status: "paid", provider: "dividendmax", payload: { amount: "0.26" },
    })
    await db
      .insert(dividends)
      .values({
        symbol: "AAPL", exDate: "2026-08-10", paymentDate: "2026-08-17", amount: "0.26",
        currency: "USD", status: "paid", provider: "nasdaq", payload: { amount: "0.26" },
      })
      .onConflictDoUpdate({
        target: [dividends.symbol, dividends.exDate],
        set: { amount: "0.26", currency: "USD", status: "paid", provider: "nasdaq", payload: { amount: "0.26" }, fetchedAt: new Date() },
      })
    const rows = await db.select().from(dividends)
    expect(rows.length).toBe(1)
    expect(rows[0]!.provider).toBe("nasdaq")
  })

  it("holds a predicted row with NULL amount and no payment date", async () => {
    await db.insert(dividends).values({
      symbol: "AAPL", exDate: "2027-02-05", declarationDate: "2027-01-28",
      currency: "USD", status: "predicted", provider: "dividendmax", payload: { note: "Forecast" },
    })
    const [row] = await db.select().from(dividends).where(sql`${dividends.exDate} = '2027-02-05'`)
    expect(row!.status).toBe("predicted")
    expect(row!.amount).toBeNull()
    expect(row!.paymentDate).toBeNull()
  })

  it("a confirmed row overwrites its predicted row in place (payment date may move)", async () => {
    await db
      .insert(dividends)
      .values({
        symbol: "AAPL", exDate: "2027-02-05", paymentDate: "2027-02-14", amount: "0.30",
        currency: "USD", status: "confirmed", provider: "nasdaq", payload: { amount: "0.30" },
      })
      .onConflictDoUpdate({
        target: [dividends.symbol, dividends.exDate],
        set: { paymentDate: "2027-02-14", amount: "0.30", currency: "USD", status: "confirmed", provider: "nasdaq", payload: { amount: "0.30" }, fetchedAt: new Date() },
      })
    const rows = await db.select().from(dividends).where(sql`${dividends.exDate} = '2027-02-05'`)
    expect(rows.length).toBe(1)
    expect(rows[0]!.status).toBe("confirmed")
    expect(rows[0]!.amount).toBe("0.30000000")
  })

  it("fetch-state rows are keyed per (symbol, scope)", async () => {
    await db.insert(dividendsFetchState).values({ symbol: "AAPL", scope: "history", lastStatus: "ok" })
    await db.insert(dividendsFetchState).values({ symbol: "AAPL", scope: "predicted", lastStatus: "empty" })
    const rows = await db.select().from(dividendsFetchState)
    expect(rows.length).toBe(2)
    expect(new Set(rows.map((r) => r.scope))).toEqual(new Set(["history", "predicted"]))
  })
})
