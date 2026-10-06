import { readFileSync } from "fs"
import { fileURLToPath } from "url"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { createTestDb } from "../db/test-db.js"
import type { DB } from "../db/index.js"
import {
  EMPTY_BACKOFF_HOURS,
  loadMetrics,
  loadStatements,
  markFetch,
  scopeKey,
  shouldRefetch,
  storedPeriodCounts,
  upsertMetrics,
  upsertStatements,
  windowHours,
  type StatementScope,
} from "./fundamentals.js"

const FIXTURES = fileURLToPath(new URL("../../test/fixtures/fundamentals", import.meta.url))

function body(provider: string, file: string) {
  return JSON.parse(readFileSync(`${FIXTURES}/${provider}/${file}`, "utf8")) as {
    provider: string | null
    rows: Array<Record<string, unknown>>
  }
}

const ANNUAL: StatementScope = { statement: "income", period: "annual" }
const QUARTER: StatementScope = { statement: "income", period: "quarter" }

const HOUR = 3_600_000
const T0 = new Date("2026-10-01T00:00:00Z")
const at = (hoursLater: number) => new Date(T0.getTime() + hoursLater * HOUR)

describe("fundamentals store", () => {
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

  describe("upsertStatements", () => {
    it("stores every period of a body and reads it back", async () => {
      const b = body("yfinance", "PKO.WA-income-annual.json")
      expect(await upsertStatements(db, "PKO.WA", ANNUAL, b.provider, b.rows)).toBe(5)

      const stored = await loadStatements(db, "PKO.WA", ANNUAL)
      expect(stored.map((r) => r.periodKey)).toEqual(["2021-Q4", "2022-Q4", "2023-Q4", "2024-Q4", "2025-Q4"])
      expect(stored[4]!.provider).toBe("yfinance")
      expect(stored[4]!.periodEnd).toBe("2025-12-31")
    })

    it("overwrites a restated period and leaves every other period alone", async () => {
      const b = body("yfinance", "PKO.WA-income-annual.json")
      const before = await loadStatements(db, "PKO.WA", ANNUAL)

      const restated = b.rows.map((r) =>
        r.period_ending === "2025-12-31" ? { ...r, net_income: -1 } : r,
      )
      await upsertStatements(db, "PKO.WA", ANNUAL, b.provider, restated)

      const after = await loadStatements(db, "PKO.WA", ANNUAL)
      expect(after.length).toBe(before.length)
      expect(after.map((r) => r.periodKey)).toEqual(before.map((r) => r.periodKey))
      const newest = after.find((r) => r.periodKey === "2025-Q4")!
      expect(newest.payload.net_income).toBe(-1)
      // The untouched periods are byte-identical, not re-fetched copies.
      expect(after.find((r) => r.periodKey === "2024-Q4")!.payload).toEqual(
        before.find((r) => r.periodKey === "2024-Q4")!.payload,
      )
    })

    it("extends the history rather than forking it when the provider changes", async () => {
      const yf = body("yfinance", "AAPL-income-annual.json")
      await upsertStatements(db, "AAPL", ANNUAL, yf.provider, yf.rows)
      const fmp = body("fmp", "AAPL-income-annual.json")
      await upsertStatements(db, "AAPL", ANNUAL, fmp.provider, fmp.rows)

      const stored = await loadStatements(db, "AAPL", ANNUAL)
      // fmp reaches one year further back (2021); the shared years stay single.
      expect(stored.map((r) => r.periodKey)).toEqual([
        "2021-Q3", "2022-Q3", "2023-Q3", "2024-Q3", "2025-Q3",
      ])
      // And every row now records the provider that actually answered last,
      // including the fiscal labels fmp declares and yfinance did not.
      expect(stored.every((r) => r.provider === "fmp")).toBe(true)
      expect(stored.find((r) => r.periodKey === "2025-Q3")!.fiscalYear).toBe(2025)
      expect(stored.find((r) => r.periodKey === "2025-Q3")!.fiscalPeriod).toBe("FY")
    })

    it("keeps an annual and a quarterly row for the same period end apart", async () => {
      const yf = body("yfinance", "AAPL-income-annual.json")
      await upsertStatements(db, "AAPL", ANNUAL, yf.provider, yf.rows)
      await upsertStatements(db, "AAPL", QUARTER, yf.provider, body("yfinance", "AAPL-income-quarter.json").rows)

      const annual = await loadStatements(db, "AAPL", ANNUAL)
      const quarter = await loadStatements(db, "AAPL", QUARTER)
      const shared = annual.filter((a) => quarter.some((q) => q.periodKey === a.periodKey))
      expect(shared.length).toBeGreaterThan(0)
      expect(annual.every((r) => r.periodEnd !== null)).toBe(true)
    })

    it("drops a row with no usable period end instead of storing it", async () => {
      const written = await upsertStatements(db, "NODATE", ANNUAL, "yfinance", [
        { revenue: 1 },
        { period_ending: "2025-12-31", revenue: 2 },
      ])
      expect(written).toBe(1)
      const stored = await loadStatements(db, "NODATE", ANNUAL)
      expect(stored.length).toBe(1)
      expect(stored[0]!.payload).toEqual({ period_ending: "2025-12-31", revenue: 2 })
    })

    it("returns an empty set for a symbol with nothing stored", async () => {
      expect(await loadStatements(db, "AIPOWR.AS", ANNUAL)).toEqual([])
    })
  })

  describe("metrics", () => {
    it("round-trips a snapshot and overwrites it in place", async () => {
      expect(await loadMetrics(db, "PKO.WA")).toBeNull()

      const first = body("yfinance", "metrics-PKO.WA.json") as unknown as Record<string, unknown>
      await upsertMetrics(db, "PKO.WA", first)
      const stored = await loadMetrics(db, "PKO.WA")
      expect(stored!.payload.pe_ratio).toBe(first.pe_ratio)

      await upsertMetrics(db, "PKO.WA", { ...first, pe_ratio: 99 })
      const after = await loadMetrics(db, "PKO.WA")
      expect(after!.payload.pe_ratio).toBe(99)
      expect(await storedPeriodCounts(db, "PKO.WA")).toBeTruthy()
    })
  })

  describe("shouldRefetch", () => {
    it("is true when a scope has never been fetched", async () => {
      expect(await shouldRefetch(db, "AAPL", scopeKey(ANNUAL), T0)).toBe(true)
    })

    it("is false just inside the window and true just past it", async () => {
      const scope = scopeKey(ANNUAL)
      await markFetch(db, "AAPL", scope, "ok", T0)

      const window = windowHours(scope)
      expect(await shouldRefetch(db, "AAPL", scope, at(window - 0.01))).toBe(false)
      expect(await shouldRefetch(db, "AAPL", scope, at(window))).toBe(true)
      expect(await shouldRefetch(db, "AAPL", scope, at(window + 1))).toBe(true)
    })

    it("uses a 7-day window for a quarterly scope", async () => {
      const scope = scopeKey(QUARTER)
      expect(windowHours(scope)).toBe(7 * 24)
      await markFetch(db, "AAPL", scope, "ok", T0)
      expect(await shouldRefetch(db, "AAPL", scope, at(7 * 24 - 0.01))).toBe(false)
      expect(await shouldRefetch(db, "AAPL", scope, at(7 * 24))).toBe(true)
    })

    it("uses a 1-day window for metrics", () => {
      expect(windowHours("metrics")).toBe(24)
    })

    it("backs off a scope that came back empty instead of re-walking providers", async () => {
      const scope = scopeKey(ANNUAL)
      await markFetch(db, "AIPOWR.AS", scope, "empty", T0)

      expect(await shouldRefetch(db, "AIPOWR.AS", scope, at(6 * 24))).toBe(false)
      expect(await shouldRefetch(db, "AIPOWR.AS", scope, at(EMPTY_BACKOFF_HOURS))).toBe(true)
      // Nothing was written as data for a symbol that has no statements.
      expect(await loadStatements(db, "AIPOWR.AS", ANNUAL)).toEqual([])
    })

    it("restarts the backoff on every empty walk", async () => {
      const scope = scopeKey(ANNUAL)
      await markFetch(db, "ARK01", scope, "empty", T0)
      await markFetch(db, "ARK01", scope, "empty", at(EMPTY_BACKOFF_HOURS))
      expect(await shouldRefetch(db, "ARK01", scope, at(EMPTY_BACKOFF_HOURS))).toBe(false)
    })

    it("refetches rather than trusting a last_fetched_at from the future", async () => {
      // A restored database or a host clock jump leaves a timestamp that never
      // happened. Serving it as fresh would pin the scope to stale data for a
      // whole window measured from that date, so a walk is due instead.
      const scope = scopeKey(ANNUAL)
      await markFetch(db, "AAPL", scope, "ok", T0)
      expect(await shouldRefetch(db, "AAPL", scope, at(-HOUR))).toBe(true)
      expect(await shouldRefetch(db, "AAPL", scope, at(-30 * 24))).toBe(true)
      // …and a normal read of the same row is still fresh.
      expect(await shouldRefetch(db, "AAPL", scope, at(1))).toBe(false)
    })
  })
})
