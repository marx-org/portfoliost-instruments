import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { sql } from "drizzle-orm"
import { createTestDb } from "../db/test-db.js"
import { LOCAL_PRICE_BARS_SETUP_SQL } from "../db/price-bars.js"
import type { DB } from "../db/index.js"
import { pruneOrphanedBars, protectedSymbols, venueFree } from "./prune-orphan-bars.js"

let db: DB
let client: Awaited<ReturnType<typeof createTestDb>>["client"]

async function seed(symbol: string, dates: string[], status: "ok" | "failed" = "ok") {
  for (const date of dates) {
    await db.execute(
      sql`insert into instruments.price_bars (symbol, date, close, source) values (${symbol}, ${date}, '10.00000000', 'openst') on conflict do nothing`,
    )
  }
  await db.execute(
    sql`insert into instruments.price_bar_metadata (symbol, fetch_status) values (${symbol}, ${status}) on conflict (symbol) do update set fetch_status = excluded.fetch_status`,
  )
}

// The production driver (postgres-js) returns the bare array; PGlite returns
// `{ rows }`. Assert against BOTH so the script cannot read "0 candidates" in
// prod and report success — which is exactly what happened before rowsOf().
const rows = (r: { rows?: unknown[] } | unknown[]) => (Array.isArray(r) ? r : (r.rows ?? []))

beforeAll(async () => {
  const t = await createTestDb()
  db = t.db
  client = t.client
  for (const stmt of LOCAL_PRICE_BARS_SETUP_SQL) await db.execute(sql.raw(stmt))
})

afterAll(async () => {
  await client.close()
})

describe("venueFree / protectedSymbols", () => {
  it("compares on the venue-free form, which is how price_bars keys a symbol", () => {
    expect(venueFree("AAPL.US")).toBe("AAPL")
    expect(venueFree(" snt.wa ")).toBe("SNT")
    expect(venueFree("7974.T")).toBe("7974")
    expect(venueFree("ALLIANZ SE")).toBe("ALLIANZ SE")
  })

  it("protects a referenced symbol whatever venue form the caller passes", () => {
    expect(protectedSymbols(["aapl.us"])).toEqual(new Set(["AAPL"]))
    expect(protectedSymbols(["AAPL", "MSFT"]).has("MSFT")).toBe(true)
  })

  it("ignores blanks and non-strings rather than protecting the empty symbol", () => {
    const s = protectedSymbols(["AAPL", "", "   ", null as unknown as string])
    expect(s).toEqual(new Set(["AAPL"]))
    expect(s.has("")).toBe(false)
  })

  it("adds the caller's explicit keep list", () => {
    expect(protectedSymbols(["AAPL"], ["VRC.WA"])).toEqual(new Set(["AAPL", "VRC"]))
  })
})

describe("pruneOrphanedBars (§63.15)", () => {
  it("finds candidates when the driver returns the bare array (production shape)", async () => {
    // postgres-js returns the array itself; PGlite returns `{ rows }`. The
    // script read `.rows` alone, found ZERO candidates in prod and cheerfully
    // reported "nothing to prune" — so the production shape is asserted here
    // against a stub db, not just described in a comment.
    // Answered by call order (metadata list, then the grouped bar counts)
    // rather than by matching the query text, which a SQL builder does not
    // expose usefully through String().
    let n = 0
    const stub = {
      execute: () => {
        n += 1
        if (n === 1) return Promise.resolve([{ symbol: "STALE1" }])
        if (n === 2) return Promise.resolve([{ symbol: "STALE1", n: 7 }])
        return Promise.resolve([])
      },
      transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(stub),
    } as unknown as DB
    const report = await pruneOrphanedBars(stub, [], { dryRun: true })
    expect(report.considered).toBe(1)
    expect(report.removed).toEqual(["STALE1"])
    expect(report.barRows).toBe(7)
    expect(n).toBe(2)
  })

  it("removes metadata and bars for a symbol nothing references", async () => {
    await seed("ORPH1", ["2026-01-02", "2026-01-03", "2026-01-04"])
    const report = await pruneOrphanedBars(db, ["HELD1"], { dryRun: true })
    expect(report.removed).toContain("ORPH1")
    // ORPH1's own three rows, not the fleet total — the number the report
    // quotes has to be attributable.
    expect(report.barRows).toBeGreaterThanOrEqual(3)

    await pruneOrphanedBars(db, ["HELD1"])
    const meta = await db.execute(sql`select symbol from instruments.price_bar_metadata where symbol = 'ORPH1'`)
    const bars = await db.execute(sql`select symbol from instruments.price_bars where symbol = 'ORPH1'`)
    expect(rows(meta)).toHaveLength(0)
    expect(rows(bars)).toHaveLength(0)
  })

  it("NEVER removes a symbol a transaction references, whatever the venue form", async () => {
    await seed("KEEP1", ["2026-01-02", "2026-01-03"])
    // wallets stores `KEEP1.US`; price_bars keys `KEEP1`. A sweep that compared
    // the raw strings would delete a live holding's entire history.
    const report = await pruneOrphanedBars(db, ["KEEP1.US"])
    expect(report.removed).not.toContain("KEEP1")
    expect(report.kept).toContainEqual({ symbol: "KEEP1", reason: "referenced" })
    const bars = await db.execute(sql`select symbol from instruments.price_bars where symbol = 'KEEP1'`)
    expect(rows(bars)).toHaveLength(2)
  })

  it("honours the caller's keep list (the live fetch set)", async () => {
    await seed("KEEP2", ["2026-01-02"])
    const report = await pruneOrphanedBars(db, [], { keep: ["KEEP2"] })
    expect(report.removed).not.toContain("KEEP2")
    const bars = await db.execute(sql`select symbol from instruments.price_bars where symbol = 'KEEP2'`)
    expect(rows(bars)).toHaveLength(1)
  })

  it("a dry run changes nothing", async () => {
    await seed("DRY1", ["2026-01-02"])
    const report = await pruneOrphanedBars(db, [], { dryRun: true })
    expect(report.removed).toContain("DRY1")
    const bars = await db.execute(sql`select symbol from instruments.price_bars where symbol = 'DRY1'`)
    expect(rows(bars)).toHaveLength(1)
  })

  it("removes bars for a symbol that has bars but no metadata row", async () => {
    // The metadata upsert means these normally agree, but a sweep that reads
    // only the metadata table would leave the rows behind forever.
    await db.execute(
      sql`insert into instruments.price_bars (symbol, date, close, source) values ('NOMETA', '2026-01-02', '5.00000000', 'openst') on conflict do nothing`,
    )
    const report = await pruneOrphanedBars(db, ["HELD1"])
    expect(report.removed).toContain("NOMETA")
    const bars = await db.execute(sql`select symbol from instruments.price_bars where symbol = 'NOMETA'`)
    expect(rows(bars)).toHaveLength(0)
  })

  it("deletes every bar of a venue-suffixed symbol too", async () => {
    await db.execute(
      sql`insert into instruments.price_bars (symbol, date, close, source) values ('ORPH2.WA', '2026-01-02', '5.00000000', 'openst') on conflict do nothing`,
    )
    await pruneOrphanedBars(db, ["HELD1"])
    const bars = await db.execute(sql`select symbol from instruments.price_bars where symbol = 'ORPH2.WA'`)
    expect(rows(bars)).toHaveLength(0)
  })

  it("reports the bar-row count it would free, not just a symbol count", async () => {
    await seed("COUNT1", ["2026-02-02", "2026-02-03", "2026-02-04", "2026-02-05"])
    const report = await pruneOrphanedBars(db, ["HELD1"], { dryRun: true })
    const before = report.barRows
    await pruneOrphanedBars(db, ["HELD1"])
    const after = await pruneOrphanedBars(db, ["HELD1"], { dryRun: true })
    expect(after.barRows).toBeLessThan(before)
  })
})
