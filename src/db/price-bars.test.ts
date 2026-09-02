import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { sql } from "drizzle-orm"
import { createTestDb } from "./test-db.js"
import type { DB } from "./index.js"
import { priceBars } from "./schema.js"
import { LOCAL_PRICE_BARS_SETUP_SQL } from "./price-bars.js"

describe("price_bars schema (H2)", () => {
  let db: DB
  let client: Awaited<ReturnType<typeof createTestDb>>["client"]

  beforeAll(async () => {
    const t = await createTestDb()
    db = t.db
    client = t.client
    // PGlite cannot load postgres_fdw, so build the local stooq stand-in
    // tables + the price_bars_all view over them (prod uses foreign tables).
    for (const stmt of LOCAL_PRICE_BARS_SETUP_SQL) {
      await db.execute(sql.raw(stmt))
    }
  })

  afterAll(async () => {
    await client.close()
  })

  it("creates the owned price tables via migration", async () => {
    for (const t of [
      "price_bars",
      "price_bar_metadata",
      "split_candidates",
      "split_adjustments",
    ]) {
      const rows = await db.execute(
        sql`select to_regclass('instruments.${sql.raw(t)}') as rel`,
      )
      expect(rows.rows[0]?.rel).not.toBeNull()
    }
  })

  it("upserts into price_bars idempotently", async () => {
    const row = { symbol: "AAPL", date: "2026-01-15", close: "210.50000000", source: "openst" }
    await db
      .insert(priceBars)
      .values(row)
      .onConflictDoUpdate({
        target: [priceBars.symbol, priceBars.date],
        set: { close: sql`excluded.close`, source: sql`excluded.source` },
      })
    await db
      .insert(priceBars)
      .values({ ...row, close: "212.00000000" })
      .onConflictDoUpdate({
        target: [priceBars.symbol, priceBars.date],
        set: { close: sql`excluded.close`, source: sql`excluded.source` },
      })
    const [rows] = await db
      .select({ close: priceBars.close })
      .from(priceBars)
      .where(sql`${priceBars.symbol} = 'AAPL' AND ${priceBars.date} = '2026-01-15'`)
    expect(Number(rows.close)).toBe(212)
  })

  it("unifies stooq (US, PL, world) and overflow rows in price_bars_all", async () => {
    // seed local stooq tables
    await db.execute(sql.raw(`
      INSERT INTO instruments.stooq_daily_us (ticker, period, date, close) VALUES
        ('AAPL.US', 'd', '2026-01-02', 200.00000000),
        ('AAPL.US', 'd', '2026-01-05', 205.00000000);
    `))
    await db.execute(sql.raw(`
      INSERT INTO instruments.stooq_daily_pl (ticker, period, date, close) VALUES
        ('PKN.WA', 'd', '2026-01-02', 55.00000000);
    `))
    await db.execute(sql.raw(`
      INSERT INTO instruments.stooq_daily_world (ticker, period, date, close) VALUES
        ('RHM.DE', 'd', '2026-01-02', 98.00000000);
    `))
    await db.execute(sql.raw(`
      INSERT INTO instruments.price_bars (symbol, date, close, source) VALUES
        ('AAPL',   '2026-01-06', 210.00000000, 'openst'),
        ('OBSCURE', '2026-01-03', 12.00000000, 'openst');
    `))

    const result = await db.execute(sql`
      select symbol, date, close, source
      from instruments.price_bars_all
      where date between '2026-01-02' and '2026-01-06'
      order by symbol, date
    `)

    type PriceBarsAllRow = { symbol: string; date: string; close: string; source: string }
    const map = new Map(
      (result.rows as PriceBarsAllRow[]).map((r) => [
        `${r.symbol}|${r.date}`,
        { close: Number(r.close), source: r.source },
      ]),
    )

    // US .US suffix stripped to system symbol
    expect(map.get("AAPL|2026-01-02")?.close).toBe(200)
    expect(map.get("AAPL|2026-01-05")?.close).toBe(205)
    // overflow tail for same symbol joins in
    expect(map.get("AAPL|2026-01-06")?.close).toBe(210)
    expect(map.get("AAPL|2026-01-06")?.source).toBe("openst")
    // PL / world passthrough
    expect(map.get("PKN.WA|2026-01-02")?.close).toBe(55)
    expect(map.get("RHM.DE|2026-01-02")?.close).toBe(98)
    // sole overflow symbol
    expect(map.get("OBSCURE|2026-01-03")?.close).toBe(12)
  })

  it("applies an approved split adjustment to stooq rows in the view", async () => {
    await db.execute(sql.raw(`
      INSERT INTO instruments.split_adjustments (symbol, detected_at, factor, split_ratio)
      VALUES ('RHM.DE', '2026-01-10', 0.250000, '4:1');
    `))
    const rows = await db.execute(sql`
      select close from instruments.price_bars_all where symbol = 'RHM.DE' and date = '2026-01-02'
    `)
    // 98 * 0.25 = 24.5
    expect(Number(rows.rows[0]?.close)).toBeCloseTo(24.5, 4)
  })
})
