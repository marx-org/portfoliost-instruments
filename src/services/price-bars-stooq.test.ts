/**
 * price-bars-stooq.test.ts (H9)
 *
 * Exercises the price_bars_all VIEW's stooq-side behaviour using the local
 * stand-in tables (LOCAL_PRICE_BARS_SETUP_SQL).  Covers:
 *  - US .US suffix stripped to system symbol
 *  - PL / world tickers passed through as-is
 *  - split_adjustments factor applied to stooq rows
 *  - overflow (price_bars) rows unified alongside stooq rows
 *  - priority: stooq rows for a date + overflow row → both appear
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { sql } from "drizzle-orm"
import { createTestDb } from "../db/test-db.js"
import type { DB } from "../db/index.js"
import { LOCAL_PRICE_BARS_SETUP_SQL } from "../db/price-bars.js"
import { getPriceBarSeries, queryView } from "./price-bars.js"

describe("price_bars_all view — stooq routing (H9)", () => {
  let db: DB
  let client: Awaited<ReturnType<typeof createTestDb>>["client"]

  beforeAll(async () => {
    const t = await createTestDb()
    db = t.db
    client = t.client
    for (const stmt of LOCAL_PRICE_BARS_SETUP_SQL) {
      await db.execute(sql.raw(stmt))
    }

    // US dataset: .US suffix must be stripped
    await db.execute(sql.raw(`
      INSERT INTO instruments.stooq_daily_us (ticker, period, date, close) VALUES
        ('MSFT.US', 'd', '2026-06-01', 420.00),
        ('MSFT.US', 'd', '2026-06-02', 425.00);
    `))

    // PL dataset: ticker passthrough (no suffix transformation)
    await db.execute(sql.raw(`
      INSERT INTO instruments.stooq_daily_pl (ticker, period, date, close) VALUES
        ('CDR.WA', 'd', '2026-06-01', 155.50);
    `))

    // World dataset: ticker passthrough
    await db.execute(sql.raw(`
      INSERT INTO instruments.stooq_daily_world (ticker, period, date, close) VALUES
        ('US10Y', 'd', '2026-06-01', 4.25);
    `))

    // Overflow row for MSFT — extends beyond stooq coverage
    await db.execute(sql.raw(`
      INSERT INTO instruments.price_bars (symbol, date, close, source)
      VALUES ('MSFT', '2026-06-03', 430.00, 'openst');
    `))

    // Split adjustment for CDR.WA: factor 0.25 (4:1 split)
    await db.execute(sql.raw(`
      INSERT INTO instruments.split_adjustments (symbol, detected_at, factor, split_ratio)
      VALUES ('CDR.WA', '2026-06-01', 0.25, '4:1');
    `))
  })

  afterAll(async () => { await client.close() })

  it("strips .US suffix — MSFT.US → symbol MSFT", async () => {
    const rows = await db.execute(sql`
      SELECT symbol, date, close FROM instruments.price_bars_all
      WHERE symbol = 'MSFT' AND date = '2026-06-01'
    `)
    const r = (rows.rows ?? rows) as Array<{ symbol: string; close: string }>
    expect(r).toHaveLength(1)
    expect(r[0].symbol).toBe("MSFT")
    expect(Number(r[0].close)).toBeCloseTo(420)
  })

  it("prefers the US dataset when a world ticker collides with a US symbol", async () => {
    // DIA is present in both stooq_daily_us (DIA.US, ~$520) and the world
    // dataset (DIA, ~$180). Both become symbol DIA in the unified view; the US
    // ETF row is the authoritative one for the benchmark symbol.
    await db.execute(sql.raw(`
      INSERT INTO instruments.stooq_daily_us (ticker, period, date, close) VALUES
        ('DIA.US', 'd', '2026-07-01', 522.40),
        ('DIA.US', 'd', '2026-07-02', 527.88);
    `))
    await db.execute(sql.raw(`
      INSERT INTO instruments.stooq_daily_world (ticker, period, date, close) VALUES
        ('DIA', 'd', '2026-07-01', 179.50),
        ('DIA', 'd', '2026-07-02', 181.50);
    `))

    const rows = await queryView(db, "DIA", "2026-07-01", "2026-07-02")
    expect(rows.map((r) => Number(r.close))).toEqual([522.4, 527.88])
    const series = await getPriceBarSeries(db, "DIA", "2026-07-01", "2026-07-02", new Date("2026-07-03T00:00:00Z"))
    expect(series.closes).toEqual([522.4, 527.88])
  })

  it("PL ticker passthrough — CDR.WA remains CDR.WA", async () => {
    const rows = await db.execute(sql`
      SELECT symbol FROM instruments.price_bars_all WHERE symbol = 'CDR.WA'
    `)
    const r = (rows.rows ?? rows) as Array<{ symbol: string }>
    expect(r.length).toBeGreaterThan(0)
    expect(r[0].symbol).toBe("CDR.WA")
  })

  it("world ticker passthrough — US10Y remains US10Y", async () => {
    const rows = await db.execute(sql`
      SELECT symbol, close FROM instruments.price_bars_all WHERE symbol = 'US10Y'
    `)
    const r = (rows.rows ?? rows) as Array<{ close: string }>
    expect(r).toHaveLength(1)
    expect(Number(r[0].close)).toBeCloseTo(4.25)
  })

  it("applies split_adjustments factor to stooq rows", async () => {
    // CDR.WA 155.50 × 0.25 = 38.875
    const rows = await db.execute(sql`
      SELECT close FROM instruments.price_bars_all
      WHERE symbol = 'CDR.WA' AND date = '2026-06-01'
    `)
    const r = (rows.rows ?? rows) as Array<{ close: string }>
    expect(Number(r[0].close)).toBeCloseTo(38.875, 4)
  })

  it("overflow row unifies with stooq rows in one series", async () => {
    const rows = await db.execute(sql`
      SELECT date, close, source FROM instruments.price_bars_all
      WHERE symbol = 'MSFT' AND date BETWEEN '2026-06-01' AND '2026-06-03'
      ORDER BY date
    `)
    const r = (rows.rows ?? rows) as Array<{ date: string; close: string; source: string }>
    expect(r.map((x) => x.date)).toEqual(["2026-06-01", "2026-06-02", "2026-06-03"])
    expect(Number(r[2].close)).toBeCloseTo(430) // overflow row
    expect(r[2].source).toBe("openst")
  })

  it("split adjustment does NOT apply to overflow rows", async () => {
    // Insert overflow for CDR.WA — should pass through unadjusted
    await db.execute(sql.raw(`
      INSERT INTO instruments.price_bars (symbol, date, close, source)
      VALUES ('CDR.WA', '2026-06-02', 40.00, 'openst');
    `))
    const rows = await db.execute(sql`
      SELECT close, source FROM instruments.price_bars_all
      WHERE symbol = 'CDR.WA' AND date = '2026-06-02'
    `)
    const r = (rows.rows ?? rows) as Array<{ close: string; source: string }>
    expect(r).toHaveLength(1)
    expect(Number(r[0].close)).toBeCloseTo(40) // no ×0.25 applied
    expect(r[0].source).toBe("openst")
  })
})
