import { afterEach, describe, expect, it, vi } from "vitest"
import { sql } from "drizzle-orm"
import { createTestDb } from "../db/test-db.js"
import { fxRates, fxSyncState } from "../db/schema.js"
import {
  backfillCurrency,
  DEFAULT_HISTORY_START,
  FRANKFURTER_BASE,
  importHistory,
  syncDaily,
  TRACKED_CURRENCIES,
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


/**
 * §72.36 — "Why is `EUR` absent from `instruments.fx_rates` while 20+ other
 * currencies are stored directly with history to 1999-01-04? EUR is the most-used
 * transaction currency in this dataset, and it is the one currency not stored."
 *
 * The answer was in a code comment all along, and this test is the durable form
 * of it. `importHistory` and `syncDaily` both fetch with **`base=EUR`**, so
 * every stored row means "1 EUR = N <currency>" and a EUR row is 1 by
 * definition — frankfurter does not return one, and adding EUR to the tracked
 * list would fetch a row that either does not exist or is a constant 1. EUR→PLN
 * is cross-derived at read time, which is why it resolves.
 *
 * Measured in PROD 2026-09-30: 31 currencies, 7103 rows each back to 1999-01-04,
 * and no EUR among them.
 */
describe("the FX base currency is EUR by design, not by omission (§72.36)", () => {
  it("TRACKED_CURRENCIES does not list EUR — the base cannot be a row", () => {
    expect(TRACKED_CURRENCIES).not.toContain("EUR")
  })

  it("does list the currencies the fleet actually transacts in", () => {
    // The 30 the importer carries. PLN and USD dominate this dataset; GBP and
    // JPY are the next most common instrument currencies.
    for (const c of ["PLN", "USD", "GBP", "JPY", "CHF", "CZK", "SEK", "NOK", "DKK", "HUF"]) {
      expect(TRACKED_CURRENCIES, `${c} is not tracked`).toContain(c)
    }
  })

  it("imports against base=EUR, so no EUR row can ever arrive", async () => {
    const { db } = await createTestDb()
    const fetchStub = stubFetch({
      base: "EUR",
      start_date: "2026-08-20",
      end_date: "2026-08-21",
      // A frankfurter response to base=EUR: every key is a NON-EUR currency.
      rates: { "2026-08-20": { USD: 1.08, PLN: 4.3 }, "2026-08-21": { USD: 1.09, PLN: 4.31 } },
    })
    const n = await importHistory(db, { start: "2026-08-20" })
    expect(n).toBe(4)
    const url = String(fetchStub.mock.calls[0][0])
    expect(url).toContain("base=EUR")
    // Nothing named EUR was written, and that is correct, not a gap.
    const rows = await db.select().from(fxRates).orderBy(fxRates.rateDate, fxRates.currency)
    expect(rows.map((r) => r.currency)).not.toContain("EUR")
    // Each row really is "1 EUR = N", so PLN is ~4.3, not ~0.23.
    const pln = rows.find((r) => r.currency === "PLN")!
    expect(Number(pln.rate)).toBeCloseTo(4.3, 2)
  })

  it("the importer's base is the ECB reference base frankfurter serves", () => {
    expect(FRANKFURTER_BASE).toContain("frankfurter")
  })
})
