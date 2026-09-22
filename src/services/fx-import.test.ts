import { afterEach, describe, expect, it, vi } from "vitest"
import { sql } from "drizzle-orm"
import { createTestDb } from "../db/test-db.js"
import { fxRates, fxSyncState } from "../db/schema.js"
import {
  backfillCurrency,
  DEFAULT_HISTORY_START,
  importHistory,
  syncDaily,
  upsertRates,
} from "./fx-import.js"

function stubFetch(payload: unknown, status = 200) {
  const fn = vi.fn().mockResolvedValue({ ok: status < 400, status, json: async () => payload, text: async () => JSON.stringify(payload) })
  vi.stubGlobal("fetch", fn)
  return fn
}

afterEach(() => vi.unstubAllGlobals())

describe("fx import (plan §48.1)", () => {
  it("upserts rates idempotently (pk rate_date,currency)", async () => {
    const { db } = await createTestDb()
    const n1 = await upsertRates(db, [{ rateDate: "2026-08-21", rates: { USD: 1.08 } }])
    expect(n1).toBe(1)
    await upsertRates(db, [{ rateDate: "2026-08-21", rates: { USD: 1.09 } }])
    const rows = await db.select().from(fxRates)
    expect(rows.length).toBe(1)
    expect(Number(rows[0].rate)).toBeCloseTo(1.09, 8)
  })

  it("importHistory defaults to the 1999 deep-import floor and records sync state", async () => {
    const { db } = await createTestDb()
    const fetchMock = stubFetch({
      base: "EUR",
      start_date: DEFAULT_HISTORY_START,
      end_date: "2024-01-03",
      rates: {
        [DEFAULT_HISTORY_START]: { USD: 1.17, PLN: 3.74 },
        "2024-01-03": { USD: 1.0971, PLN: 4.35 },
      },
    })
    const count = await importHistory(db)
    expect(count).toBe(4)
    const called = fetchMock.mock.calls[0][0] as string
    expect(called).toContain(`/${DEFAULT_HISTORY_START}..?base=EUR`)
    expect(called).toContain("USD")

    const rows = await db.select().from(fxRates).orderBy(fxRates.rateDate)
    expect(rows.length).toBe(4)
    expect(rows[0].rateDate).toBe(DEFAULT_HISTORY_START)

    const [state] = await db.select().from(fxSyncState)
    expect(state.id).toBe(1)
    expect(state.lastStatus).toBe("import")
  })

  it("syncDaily records error status and rethrows on provider failure", async () => {
    const { db } = await createTestDb()
    stubFetch({}, 500)
    await expect(syncDaily(db)).rejects.toThrow(/frankfurter 500/)
    const [state] = await db.select().from(fxSyncState)
    expect(state.lastStatus).toMatch(/^error:/)
  })

  it("backfillCurrency stores a single-currency column", async () => {
    const { db } = await createTestDb()
    stubFetch({ base: "EUR", rates: { "2026-08-20": { ISK: 148.2 } } })
    const n = await backfillCurrency(db, "ISK", 7)
    expect(n).toBe(1)
    const rows = await db.execute(sql`select currency from instruments.fx_rates`)
    expect(rows.rows[0].currency).toBe("ISK")
  })
})
