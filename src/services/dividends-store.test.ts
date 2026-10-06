import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { createTestDb } from "../db/test-db.js"
import type { DB } from "../db/index.js"
import {
  EMPTY_BACKOFF_HOURS,
  loadDividends,
  markFetch,
  prunePredictedMissing,
  shouldRefetch,
  upsertDividends,
  windowHours,
} from "./dividends-store.js"

const HOUR = 3_600_000
const T0 = new Date("2026-10-01T00:00:00Z")
const at = (hoursLater: number) => new Date(T0.getTime() + hoursLater * HOUR)
const TODAY = "2026-10-06"

const nasdaqPastRow = { date: "2026-08-10", amount: "0.2600", payment_date: "2026-08-17" }
const dividendmaxPastRow = {
  symbol: "AAPL", ex_dividend_date: "2026-08-10", amount: "0.26", payment_date: "2026-08-17",
  declaration_date: "2026-07-29", currency: "USD", dividend_type: "Quarterly", status: "Paid",
}

describe("dividends store", () => {
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

  describe("upsertDividends", () => {
    it("stores history rows as confirmed/paid and reads them back newest first", async () => {
      await upsertDividends(db, "AAPL", "nasdaq", [
        { date: "2026-08-10", amount: "0.26", payment_date: "2026-08-17" },
        { date: "2026-05-11", amount: "0.25", payment_date: "2026-05-18" },
      ], TODAY)
      const rows = await loadDividends(db, "AAPL")
      expect(rows.length).toBe(2)
      expect(rows[0]!.exDate).toBe("2026-08-10")
      expect(rows[0]!.status).toBe("paid")
      expect(rows[1]!.exDate).toBe("2026-05-11")
    })

    it("collapses the same ex-date from nasdaq and dividendmax onto one row", async () => {
      await upsertDividends(db, "AAPL", "dividendmax", [dividendmaxPastRow], TODAY)
      const rows = await loadDividends(db, "AAPL")
      expect(rows.filter((r) => r.exDate === "2026-08-10").length).toBe(1)
      expect(rows.find((r) => r.exDate === "2026-08-10")!.provider).toBe("dividendmax")
    })

    it("drops rows with no usable ex-date instead of storing them", async () => {
      const written = await upsertDividends(db, "GOOG", "nasdaq", [{ amount: "1.00" }], TODAY)
      expect(written).toBe(0)
      expect(await loadDividends(db, "GOOG")).toEqual([])
    })

    it("a confirmed row overwrites its predicted row in place, payment date moving", async () => {
      await upsertDividends(db, "MSFT", "dividendmax", [
        { ex_dividend_date: "2027-02-05", payment_date: "2027-02-12", currency: "USD", status: "Forecast" },
      ], TODAY)
      let rows = await loadDividends(db, "MSFT")
      expect(rows[0]!.status).toBe("predicted")
      expect(rows[0]!.amount).toBeNull()

      await upsertDividends(db, "MSFT", "nasdaq", [
        { date: "2027-02-05", amount: "0.83", payment_date: "2027-02-19", declaration_date: "2027-01-20" },
      ], TODAY)
      rows = await loadDividends(db, "MSFT")
      expect(rows.length).toBe(1)
      expect(rows[0]!.status).toBe("confirmed")
      expect(rows[0]!.amount).toBe("0.83000000")
      expect(rows[0]!.paymentDate).toBe("2027-02-19")
    })

    it("a late predicted row never clobbers a stored confirmed/paid row", async () => {
      await upsertDividends(db, "MSFT", "dividendmax", [
        { ex_dividend_date: "2027-02-05", status: "Forecast" },
      ], TODAY)
      const rows = await loadDividends(db, "MSFT")
      expect(rows.length).toBe(1)
      expect(rows[0]!.status).toBe("confirmed")
      expect(rows[0]!.amount).toBe("0.83000000")
    })
  })

  describe("prunePredictedMissing", () => {
    it("drops predicted rows the fresh fetch no longer returns, keeping confirmed/paid", async () => {
      await upsertDividends(db, "AAPL", "dividendmax", [
        { ex_dividend_date: "2027-03-01", status: "Forecast" },
        { ex_dividend_date: "2027-04-01", status: "Forecast" },
      ], TODAY)
      const removed = await prunePredictedMissing(db, "AAPL", ["2027-04-01"])
      expect(removed).toBe(1)
      const rows = await loadDividends(db, "AAPL")
      expect(rows.map((r) => r.exDate)).toEqual(["2027-04-01", "2026-08-10", "2026-05-11"])
    })
  })

  describe("shouldRefetch + markFetch", () => {
    it("is true when a scope has never been fetched", async () => {
      expect(await shouldRefetch(db, "IBM", "history", T0)).toBe(true)
    })
    it("is false just inside the window and true just past it", async () => {
      await markFetch(db, "IBM", "history", "ok", T0)
      expect(await shouldRefetch(db, "IBM", "history", at(7 * 24 - 1))).toBe(false)
      expect(await shouldRefetch(db, "IBM", "history", at(7 * 24))).toBe(true)
    })
    it("windowHours is 7d for both history and predicted", () => {
      expect(windowHours("history")).toBe(168)
      expect(windowHours("predicted")).toBe(168)
    })
    it("backs off an empty scope instead of re-walking providers", async () => {
      await markFetch(db, "ETF", "history", "empty", T0)
      expect(await shouldRefetch(db, "ETF", "history", at(EMPTY_BACKOFF_HOURS - 1))).toBe(false)
      expect(await shouldRefetch(db, "ETF", "history", at(EMPTY_BACKOFF_HOURS + 1))).toBe(true)
    })
    it("refetches rather than trusting a last_fetched_at from the future", async () => {
      await markFetch(db, "AAPL", "predicted", "ok", at(24))
      expect(await shouldRefetch(db, "AAPL", "predicted", T0)).toBe(true)
    })
  })
})
