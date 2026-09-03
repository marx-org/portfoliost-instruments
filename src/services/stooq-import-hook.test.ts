/**
 * stooq-import-hook.test.ts (H10)
 *
 * Tests the post-import cleanup logic using the PGlite stand-in stooq tables.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { sql } from "drizzle-orm"
import { createTestDb } from "../db/test-db.js"
import type { DB } from "../db/index.js"
import { LOCAL_PRICE_BARS_SETUP_SQL } from "../db/price-bars.js"
import { runPostImportHook, tableForDataset, isUsDataset } from "./stooq-import-hook.js"

describe("tableForDataset / isUsDataset", () => {
  it("maps dataset to table name", () => {
    expect(tableForDataset("daily_us")).toBe("stooq_daily_us")
    expect(tableForDataset("daily_pl")).toBe("stooq_daily_pl")
    expect(tableForDataset("daily_world")).toBe("stooq_daily_world")
  })
  it("identifies US dataset correctly", () => {
    expect(isUsDataset("daily_us")).toBe(true)
    expect(isUsDataset("daily_pl")).toBe(false)
    expect(isUsDataset("daily_world")).toBe(false)
  })
})

describe("runPostImportHook (H10)", () => {
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

  afterAll(async () => { await client.close() })

  it("returns latestDate from stooq table and deletes superseded overflow rows", async () => {
    // Seed stooq US data up to 2026-07-30
    await db.execute(sql.raw(`
      INSERT INTO instruments.stooq_daily_us (ticker, period, date, close) VALUES
        ('AAPL.US', 'd', '2026-07-28', 220.00),
        ('AAPL.US', 'd', '2026-07-29', 225.00),
        ('AAPL.US', 'd', '2026-07-30', 230.00)
      ON CONFLICT DO NOTHING;
    `))
    // Seed overflow rows: some before and some after stooq MAX date
    await db.execute(sql.raw(`
      INSERT INTO instruments.price_bars (symbol, date, close, source) VALUES
        ('AAPL', '2026-07-28', 220.00, 'openst'),
        ('AAPL', '2026-07-29', 225.00, 'openst'),
        ('AAPL', '2026-07-31', 231.00, 'openst')
      ON CONFLICT (symbol, date) DO UPDATE SET close = excluded.close;
    `))

    const result = await runPostImportHook(db, "daily_us", "stooq-daily-us-job-1")

    expect(result.latestDate).toBe("2026-07-30")
    expect(result.rowsDeleted).toBe(2) // Jul 28 + Jul 29 deleted; Jul 31 kept

    // Verify only the post-stooq overflow row remains
    const remaining = await db.execute(sql`
      SELECT date FROM instruments.price_bars WHERE symbol = 'AAPL' ORDER BY date
    `)
    const rows = (remaining.rows ?? remaining) as Array<{ date: string }>
    expect(rows.map(r => r.date)).toEqual(["2026-07-31"])
  })

  it("auto-dismisses pending split_candidates for covered symbols", async () => {
    // Insert a pending candidate
    await db.execute(sql.raw(`
      INSERT INTO instruments.split_candidates (symbol, detected_at, suggested_factor, suggested_ratio, status)
      VALUES ('AAPL', '2026-07-15', '0.500000', '0.500000', 'pending')
      ON CONFLICT DO NOTHING;
    `))

    await runPostImportHook(db, "daily_us", "stooq-daily-us-job-2")

    const rows = await db.execute(sql`
      SELECT status FROM instruments.split_candidates WHERE symbol = 'AAPL'
    `)
    const r = (rows.rows ?? rows) as Array<{ status: string }>
    expect(r[0]?.status).toBe("dismissed")
  })

  it("returns latestDate=null and rowsDeleted=0 when stooq table is empty", async () => {
    // daily_pl has no rows yet
    const result = await runPostImportHook(db, "daily_pl", "stooq-daily-pl-job-1")
    expect(result.latestDate).toBeNull()
    expect(result.rowsDeleted).toBe(0)
  })

  it("passthrough symbols for non-US datasets (no .US stripping)", async () => {
    await db.execute(sql.raw(`
      INSERT INTO instruments.stooq_daily_pl (ticker, period, date, close)
      VALUES ('CDR.WA', 'd', '2026-07-30', 155.00)
      ON CONFLICT DO NOTHING;
    `))
    await db.execute(sql.raw(`
      INSERT INTO instruments.price_bars (symbol, date, close, source)
      VALUES ('CDR.WA', '2026-07-29', 150.00, 'openst')
      ON CONFLICT (symbol, date) DO UPDATE SET close = excluded.close;
    `))

    const result = await runPostImportHook(db, "daily_pl", "stooq-daily-pl-job-2")

    expect(result.latestDate).toBe("2026-07-30")
    expect(result.rowsDeleted).toBe(1)

    const remaining = await db.execute(sql`
      SELECT count(*)::int AS n FROM instruments.price_bars WHERE symbol = 'CDR.WA'
    `)
    const r = (remaining.rows ?? remaining) as Array<{ n: number }>
    expect(r[0].n).toBe(0)
  })
})
