import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { sql } from "drizzle-orm"
import { convert } from "@marx2/contracts/fx"
import { createTestDb } from "./test-db.js"
import type { DB } from "./index.js"
import { LOCAL_PRICE_BARS_SETUP_SQL } from "./price-bars.js"
import { conversionJoinSql, queryViewAs } from "../services/price-bars.js"
import { fxWindow, latestFxRates } from "./fx-rates.js"

const RATES: Array<{ d: string; PLN: number; USD: number }> = [
  { d: "2026-09-16", PLN: 4.0, USD: 4.3 },
  { d: "2026-09-17", PLN: 4.1, USD: 4.2 },
  { d: "2026-09-18", PLN: 4.2, USD: 4.0 },
  { d: "2026-09-19", PLN: 4.3, USD: 4.4 },
]

const BARS: Array<{ d: string; close: number }> = [
  { d: "2026-09-16", close: 100 },
  { d: "2026-09-17", close: 102 },
  { d: "2026-09-18", close: 101 },
  { d: "2026-09-19", close: 105 },
]

describe("fx conversion read path (plan §48.2)", () => {
  let db: DB
  let client: Awaited<ReturnType<typeof createTestDb>>["client"]

  beforeAll(async () => {
    const t = await createTestDb()
    db = t.db
    client = t.client
    for (const stmt of LOCAL_PRICE_BARS_SETUP_SQL) {
      await db.execute(sql.raw(stmt))
    }
    await db.execute(
      sql.raw(`
        INSERT INTO instruments.price_bars (symbol, date, close, source) VALUES
          ('PKN', '2026-09-16', 100.00000000, 'openst'),
          ('PKN', '2026-09-17', 102.00000000, 'openst'),
          ('PKN', '2026-09-18', 101.00000000, 'openst'),
          ('PKN', '2026-09-19', 105.00000000, 'openst'),
          ('PKN', '2026-09-10', 98.00000000, 'openst');
      `),
    )
    await db.execute(
      sql.raw(`
        INSERT INTO instruments.fx_rates (rate_date, currency, rate, source) VALUES
          ('2026-09-16', 'PLN', 4.0000000000, 'ecb'),
          ('2026-09-16', 'USD', 4.3000000000, 'ecb'),
          ('2026-09-17', 'PLN', 4.1000000000, 'ecb'),
          ('2026-09-17', 'USD', 4.2000000000, 'ecb'),
          ('2026-09-18', 'PLN', 4.2000000000, 'ecb'),
          ('2026-09-18', 'USD', 4.0000000000, 'ecb'),
          ('2026-09-19', 'PLN', 4.3000000000, 'ecb'),
          ('2026-09-19', 'USD', 4.4000000000, 'ecb');
      `),
    )
  })

  afterAll(async () => {
    await client.close()
  })

  it("converts closes via the parameterized join, equal to contracts/fx crossRate", async () => {
    const rows = await queryViewAs(db, "PKN", "2026-09-16", "2026-09-19", "PLN", "USD")
    expect(rows).toHaveLength(4)
    for (const [i, r] of rows.entries()) {
      const { d, PLN, USD } = RATES[i]
      const expected = convert(Number(BARS[i].close), "PLN", "USD", { PLN, USD })!
      expect(Number(r.close)).toBeCloseTo(expected, 8)
      expect(r.date).toBe(d)
      expect(r.fxFrom).toBe("2026-09-16")
    }
  })

  it("§72.17: drops the bar before the fx floor instead of serving it unconverted", async () => {
    // This test used to assert the opposite: 5 rows, with 2026-09-10 (no fx row)
    // served at its raw close of 98 inside a series declared USD. That is a PLN
    // number wearing a USD label, and the wallets grid multiplied it into a
    // portfolio total. The old assertion is preserved below as the record of what
    // changed, because "we deliberately stopped doing this" is the useful part.
    const rows = await queryViewAs(db, "PKN", "2026-09-09", "2026-09-19", "PLN", "USD")

    // 2026-09-10 is gone; the 4 convertible days remain.
    expect(rows.map((r) => r.date)).not.toContain("2026-09-10")
    expect(rows).toHaveLength(4)
    const expected16 = convert(100, "PLN", "USD", { PLN: 4.0, USD: 4.3 })!
    expect(Number(rows[0].close)).toBeCloseTo(expected16, 8)
    expect(rows[0].fxFrom).toBe("2026-09-16")
  })

  it("treats EUR as the implicit base (no EUR row in fx_rates)", async () => {
    const rows = await queryViewAs(db, "PKN", "2026-09-16", "2026-09-16", "EUR", "USD")
    const expected = convert(100, "EUR", "USD", { USD: 4.3 })!
    expect(Number(rows[0].close)).toBeCloseTo(expected, 8)
    expect(rows[0].fxFrom).toBe("2026-09-16")
  })

  it("§72.17: a bar with no rate row is dropped, not served unconverted", async () => {
    // The window deliberately contains 2026-09-10, which has no fx_rates row.
    // A same-currency request needs no rate and returns every bar; a converted
    // request must return one fewer. That difference IS the fix, and it is
    // asserted from the query under test rather than from a second query that
    // would have to re-derive the same joins and could drift from them.
    const raw = await queryViewAs(db, "PKN", "2026-09-09", "2026-09-19", "PLN", "PLN")
    const converted = await queryViewAs(db, "PKN", "2026-09-09", "2026-09-19", "PLN", "USD")

    expect(raw.map((r) => r.date)).toContain("2026-09-10")
    expect(converted.map((r) => r.date)).not.toContain("2026-09-10")
    expect(converted).toHaveLength(raw.length - 1)

    // What survives is genuinely converted: the close matches the cross-rate, and
    // fxFrom still reports where conversion began.
    const expected16 = convert(100, "PLN", "USD", { PLN: 4.0, USD: 4.3 })!
    expect(Number(converted[0].close)).toBeCloseTo(expected16, 8)
    expect(converted[0].fxFrom).toBe("2026-09-16")
  })

  it("§72.17: a same-currency request is not filtered", async () => {
    // base === target needs no rate row. Filtering on one would silently empty a
    // series that never needed converting — the failure mode of "fix it by
    // dropping what you cannot convert" taken one step too far.
    const rows = await queryViewAs(db, "PKN", "2026-09-09", "2026-09-19", "PLN", "PLN")
    expect(rows).toHaveLength(5)
    const ninth = rows.find((r) => r.date === "2026-09-10")!
    expect(ninth).toBeDefined()
    // present, and passed through untouched — no rate asked for, none needed
    expect(Number(ninth.close)).toBe(98)
  })

  it("plan probes the price_bars + fx_rates PKs, never seq-scans fx_rates", async () => {
    await db.execute(sql`set enable_seqscan = off`)
    try {
      const result = await db.execute(
        sql`EXPLAIN ${conversionJoinSql("PKN", "2026-09-16", "2026-09-19", "PLN", "USD")}`,
      )
      const plan = (result as { rows: Array<Record<string, string>> }).rows
        .map((r) => Object.values(r)[0])
        .join("\n")
      // the overflow branch probes its (symbol, date) PK
      expect(plan).toContain("price_bars_symbol_date_pk")
      // both fx joins ride the (rate_date, currency) PK
      const fxPkHits = plan.match(/fx_rates_rate_date_currency_pk/g) ?? []
      expect(fxPkHits.length).toBeGreaterThanOrEqual(2)
      // no sequential scan anywhere on fx_rates
      expect(plan.split("\n").filter((l) => /Seq Scan/.test(l) && /fx_rates/.test(l))).toHaveLength(0)
    } finally {
      await db.execute(sql`set enable_seqscan = on`)
    }
  })

  it("fxWindow returns the bounded rate rows; latestFxRates the newest ≤ asOf", async () => {
    const win = await fxWindow(db, ["PLN", "USD"], "2026-09-17", "2026-09-18")
    expect(win).toHaveLength(4)
    expect(win.map((r) => `${r.currency}${r.rateDate}`).sort()).toEqual([
      "PLN2026-09-17",
      "PLN2026-09-18",
      "USD2026-09-17",
      "USD2026-09-18",
    ])

    const latest = await latestFxRates(db, ["PLN", "USD", "JPY"], "2026-09-18")
    expect(latest).toHaveLength(2)
    const pln = latest.find((r) => r.currency === "PLN")!
    expect(pln.rateDate).toBe("2026-09-18")
    expect(Number(pln.rate)).toBeCloseTo(4.2, 8)
  })
})


