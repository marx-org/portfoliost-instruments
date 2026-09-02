import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest"
import { sql } from "drizzle-orm"
import { createTestDb } from "../db/test-db.js"
import type { DB } from "../db/index.js"
import { priceBarMetadata } from "../db/schema.js"
import { LOCAL_PRICE_BARS_SETUP_SQL } from "../db/price-bars.js"
import {
  checkSplitBoundary,
  getPriceBarSeries,
  hasGap,
  queryView,
  recentlyFailed,
} from "./price-bars.js"

vi.mock("../adapters/cachest.js", () => ({
  fetchOhlcv: vi.fn(),
}))

import { fetchOhlcv } from "../adapters/cachest.js"

const mockFetchOhlcv = vi.mocked(fetchOhlcv)

async function seedStooq(db: DB, symbol: string, rows: Array<[string, string]>) {
  for (const [date, close] of rows) {
    await db.execute(sql.raw(`
      INSERT INTO instruments.stooq_daily_us (ticker, period, date, close)
      VALUES ('${symbol}.US', 'd', '${date}', ${close});
    `))
  }
}

describe("price-bars (H3) service", () => {
  let db: DB
  let client: Awaited<ReturnType<typeof createTestDb>>["client"]

  beforeAll(async () => {
    const t = await createTestDb()
    db = t.db
    client = t.client
    for (const stmt of LOCAL_PRICE_BARS_SETUP_SQL) {
      await db.execute(sql.raw(stmt))
    }
  })

  afterAll(async () => {
    await client.close()
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it("queryView unifies stooq and overflow rows into an ordered series", async () => {
    await seedStooq(db, "AAPL", [["2026-01-02", "200.00000000"], ["2026-01-05", "205.00000000"]])
    await db.execute(sql.raw(`
      INSERT INTO instruments.price_bars (symbol, date, close, source)
      VALUES ('AAPL', '2026-01-06', 210.00000000, 'openst');
    `))
    const rows = await queryView(db, "AAPL", "2026-01-01", "2026-01-31")
    expect(rows.map((r) => [r.date, Number(r.close)])).toEqual([
      ["2026-01-02", 200],
      ["2026-01-05", 205],
      ["2026-01-06", 210],
    ])
  })

  it("hasGap flakes only beyond the tolerance", () => {
    const now = new Date("2026-07-10T00:00:00Z")
    expect(hasGap("2026-07-09", now)).toBe(false) // 1 day
    expect(hasGap("2026-07-07", now)).toBe(false) // 3 days (weekend-tolerant floor)
    expect(hasGap("2026-07-06", now)).toBe(true) // 4 days
  })

  it("recentlyFailed honors the one-hour cooldown", () => {
    const now = new Date("2026-07-10T12:00:00Z")
    const freshFail = { lastFetchedAt: new Date("2026-07-10T11:30:00Z"), fetchStatus: "failed" }
    const oldFail = { lastFetchedAt: new Date("2026-07-10T10:00:00Z"), fetchStatus: "failed" }
    const ok = { lastFetchedAt: new Date("2026-07-10T11:30:00Z"), fetchStatus: "ok" }
    expect(recentlyFailed(freshFail, now)).toBe(true)
    expect(recentlyFailed(oldFail, now)).toBe(false)
    expect(recentlyFailed(ok, now)).toBe(false)
    expect(recentlyFailed(undefined, now)).toBe(false)
  })

  it("getPriceBarSeries returns fresh series with stale=false when last date is recent", async () => {
    // stooq data ending yesterday → not stale
    await seedStooq(db, "MSFT", [["2026-07-09", "410.00000000"]])
    mockFetchOhlcv.mockResolvedValue([])
    const now = new Date("2026-07-10T00:00:00Z")
    const res = await getPriceBarSeries(db, "MSFT", "2026-07-01", "2026-07-10", now)
    expect(res.stale).toBe(false)
    expect(res.dates).toEqual(["2026-07-09"])
    expect(mockFetchOhlcv).not.toHaveBeenCalled()
  })

  it("getPriceBarSeries fetches missing days and writes them to overflow", async () => {
    await seedStooq(db, "GOOG", [["2026-06-01", "150.00000000"]])
    mockFetchOhlcv.mockResolvedValue([
      { date: "2026-07-08", close: 175.0 },
      { date: "2026-07-09", close: 176.5 },
    ])
    const now = new Date("2026-07-10T00:00:00Z")
    const res = await getPriceBarSeries(db, "GOOG", "2026-06-01", "2026-07-10", now)
    expect(res.stale).toBe(false)
    expect(res.closes).toEqual([150, 175, 176.5])
    // persisted to overflow
    const persisted = await db.execute(sql`
      select date from instruments.price_bars where symbol = 'GOOG' order by date
    `)
    expect((persisted.rows as Array<{ date: string }>).map((r) => r.date)).toEqual([
      "2026-07-08",
      "2026-07-09",
    ])
    // metadata marked ok
    const meta = await db.select().from(priceBarMetadata).where(sql`symbol = 'GOOG'`)
    expect(meta[0].fetchStatus).toBe("ok")
  })

  it("serves stale data without fetching when a fetch failed within the hour", async () => {
    await seedStooq(db, "NFLX", [["2026-06-01", "600.00000000"]])
    mockFetchOhlcv.mockRejectedValue(new Error("boom"))
    const t1 = new Date("2026-07-10T12:00:00Z")
    await getPriceBarSeries(db, "NFLX", "2026-06-01", "2026-07-10", t1) // triggers failing fetch
    const t2 = new Date("2026-07-10T12:30:00Z")
    const res = await getPriceBarSeries(db, "NFLX", "2026-06-01", "2026-07-10", t2)
    expect(res.stale).toBe(true)
    expect(res.closes).toEqual([600])
    // still only one upstream attempt
    expect(mockFetchOhlcv).toHaveBeenCalledTimes(1)
  })

  it("detects a reverse split at the boundary and records a candidate", async () => {
    await seedStooq(db, "RHM", [["2026-01-02", "100.00000000"]]) // last stooq
    // overflow first write shows a 2:1 split price (half)
    await db.execute(sql.raw(`
      INSERT INTO instruments.price_bars (symbol, date, close, source)
      VALUES ('RHM', '2026-01-03', 50.00000000, 'openst');
    `))
    await checkSplitBoundary(db, "RHM", "RHM.US")
    const candidates = await db.execute(sql`
      select suggested_factor, suggested_ratio from instruments.split_candidates where symbol = 'RHM'
    `)
    expect(Number(candidates.rows[0]?.suggested_factor)).toBeCloseTo(0.5, 4)
  })

  it("does not record a candidate when the boundary is continuous", async () => {
    await seedStooq(db, "ORCL", [["2026-01-02", "100.00000000"]])
    await db.execute(sql.raw(`
      INSERT INTO instruments.price_bars (symbol, date, close, source)
      VALUES ('ORCL', '2026-01-03', 101.00000000, 'openst');
    `))
    await checkSplitBoundary(db, "ORCL", "ORCL.US")
    const rows = await db.execute(sql`
      select count(*)::int as n from instruments.split_candidates where symbol = 'ORCL'
    `)
    expect(rows.rows[0].n).toBe(0)
  })
})