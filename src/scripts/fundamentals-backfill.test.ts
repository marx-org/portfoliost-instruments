import { readFileSync } from "fs"
import { fileURLToPath } from "url"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const dbState = vi.hoisted(() => ({ db: null as unknown }))
const fetchCalls = vi.hoisted(() => ({ fundamentals: [] as Array<[string, string, string]>, metrics: [] as string[] }))

vi.mock("../db/index.js", () => ({
  getDb: () => dbState.db,
  closeDb: async () => {},
}))

vi.mock("../adapters/cachest.js", () => ({
  UpstreamError: class UpstreamError extends Error {
    constructor(
      public url: string,
      public status: number,
    ) {
      super(`upstream ${status} for ${url}`)
    }
  },
  fetchFundamentals: vi.fn(async (symbol: string, statement: string, period: string) => {
    fetchCalls.fundamentals.push([symbol, statement, period])
    if (symbol === "AIPOWR.AS") throw new (await import("../adapters/cachest.js")).UpstreamError("x", 404)
    return {
      provider: "yfinance",
      rows: [{ period_ending: "2025-12-31", revenue: 1 }, { period_ending: "2024-12-31", revenue: 2 }],
    }
  }),
  fetchMetrics: vi.fn(async (symbol: string) => {
    fetchCalls.metrics.push(symbol)
    return { pe_ratio: 10, market_cap: 1e9 }
  }),
}))

const FIXTURES = fileURLToPath(new URL("../../test/fixtures/fundamentals", import.meta.url))

import {
  backfillSymbol,
  backfillSymbols,
  backfillableSymbols,
  parseArgs,
  WALK_PAUSE_MS,
} from "./fundamentals-backfill.js"
import type { DB } from "../db/index.js"

const TICKERS = `listing_key,ticker,exchange,name,asset_type,stock_sector,etf_category,country,country_code,isin,aliases
STO::AAPL,AAPL,STO,Apple Inc.,Stock,,,,US,,
STO::MSFT,MSFT,STO,Microsoft,Stock,,,,US,,
GPW::PKO,PKO.WA,GPW,PKO BP,Stock,,,,PL,,
ANALIZY::ARK01,ARK01,ANALIZY,Erste Akcji Polskich,fund,,,,PL,,
ETF::AIPOWR,AIPOWR,ETF,Boreas ETF,ETF,,,,AE,,`

describe("fundamentals backfill", () => {
  let db: DB
  let store: { client: { close: () => Promise<void> } }

  beforeEach(async () => {
    fetchCalls.fundamentals = []
    fetchCalls.metrics = []
    const { createTestDb } = await import("../db/test-db.js")
    const { syncTickerReference } = await import("./tickerref-sync.js")
    const t = await createTestDb()
    await syncTickerReference(TICKERS, t.db)
    db = t.db as unknown as DB
    dbState.db = t.db
    store = t
  })
  afterEach(async () => {
    await store.client.close()
    dbState.db = null
  })

  it("fills every statement and both periods for one symbol", async () => {
    const r = await backfillSymbol(db, "PKO.WA")
    // 3 statements × 2 periods + metrics.
    expect(r.scopes).toBe(7)
    // Each of the six statement scopes stored the two periods in the body.
    expect(r.periods).toBe(12)
    expect(fetchCalls.fundamentals).toHaveLength(6)
    expect(fetchCalls.metrics).toEqual(["PKO.WA"])

    const { fundamentalsStatements } = await import("../db/schema.js")
    const rows = await db.select().from(fundamentalsStatements)
    expect(rows).toHaveLength(12)
    expect(new Set(rows.map((r) => r.periodEnd))).toEqual(new Set(["2025-12-31", "2024-12-31"]))
    // Annual and quarterly for the same period end are distinct rows.
    expect(rows.filter((r) => r.periodEnd === "2025-12-31")).toHaveLength(6)
  })

  it("is a no-op on a second run", async () => {
    await backfillSymbol(db, "PKO.WA")
    const { fundamentalsStatements } = await import("../db/schema.js")
    const before = await db.select().from(fundamentalsStatements)
    const beforeFetchedAt = before.map((r) => r.fetchedAt.getTime())

    fetchCalls.fundamentals = []
    fetchCalls.metrics = []
    const second = await backfillSymbol(db, "PKO.WA")

    // Nothing walked: the windows have not passed.
    expect(fetchCalls.fundamentals).toHaveLength(0)
    expect(fetchCalls.metrics).toEqual([])
    const after = await db.select().from(fundamentalsStatements)
    expect(after).toHaveLength(before.length)
    expect(after.map((r) => r.fetchedAt.getTime())).toEqual(beforeFetchedAt)
    expect(second.periods).toBe(12)
  })

  it("counts a 404 as an answer, not a failure, and stores only what exists", async () => {
    // An ETF has no financial statements but does have ratios — six scopes empty,
    // the metrics snapshot real. Counting a 404 as a failure here would fail the
    // whole run for a symbol that simply has no statements.
    const r = await backfillSymbol(db, "AIPOWR.AS")
    expect(r.empty).toBe(6)
    expect(r.periods).toBe(0)

    const { fundamentalsStatements, fundamentalsMetrics } = await import("../db/schema.js")
    expect(await db.select().from(fundamentalsStatements)).toEqual([])
    const metrics = await db.select().from(fundamentalsMetrics)
    expect(metrics).toHaveLength(1)
    expect(metrics[0]!.payload).toMatchObject({ pe_ratio: 10 })
  })

  it("leaves earlier symbols written when a later one fails", async () => {
    const cachest = await import("../adapters/cachest.js")
    const original = cachest.fetchMetrics as unknown as ReturnType<typeof vi.fn>
    original.mockImplementationOnce(async () => {
      throw new Error("provider tier exploded")
    })

    // The failing symbol is second, so the first one's rows must survive.
    await expect(
      backfillSymbols(db, { symbols: ["PKO.WA", "AAPL"] }),
    ).rejects.toThrow("provider tier exploded")

    const { fundamentalsStatements } = await import("../db/schema.js")
    const rows = await db.select().from(fundamentalsStatements)
    expect(rows.length).toBeGreaterThan(0)
    expect(rows.every((r) => r.symbol === "PKO.WA")).toBe(true)
  })

  it("walks the reference table for stock and ETF rows only", async () => {
    const symbols = await backfillableSymbols(db, 10)
    expect(symbols.sort()).toEqual(["AAPL", "AIPOWR", "MSFT", "PKO.WA"])
    expect(symbols).not.toContain("ARK01")
  })

  it("never runs two symbols at once", async () => {
    let inFlight = 0
    let peak = 0
    const pause = async () => {}
    const cachest = await import("../adapters/cachest.js")
    const original = cachest.fetchFundamentals as unknown as ReturnType<typeof vi.fn>
    original.mockImplementation(async (symbol: string, statement: string, period: string) => {
      inFlight += 1
      peak = Math.max(peak, inFlight)
      await new Promise((r) => setTimeout(r, 5))
      inFlight -= 1
      return { provider: "yfinance", rows: [{ period_ending: "2025-12-31", revenue: 1 }] }
    })

    await backfillSymbols(db, { symbols: ["AAPL", "MSFT", "PKO.WA"], pause })

    // Sequential by design: each symbol costs up to seven provider walks, and a
    // parallel sweep is the provider flood this command exists to avoid.
    expect(peak).toBe(1)
    expect(WALK_PAUSE_MS).toBeGreaterThan(0)
  })

  it("writes nothing on a dry run", async () => {
    const r = await backfillSymbol(db, "PKO.WA", true)
    expect(r.periods).toBe(0)
    expect(fetchCalls.fundamentals).toHaveLength(0)

    const { fundamentalsStatements } = await import("../db/schema.js")
    expect(await db.select().from(fundamentalsStatements)).toEqual([])
  })

  it("parses the flags it documents", () => {
    expect(parseArgs(["--symbol", "pko.wa"])).toMatchObject({ symbol: "PKO.WA", fromReference: false, dryRun: false })
    expect(parseArgs(["--from-ticker-reference", "--limit", "5"])).toMatchObject({
      symbol: undefined,
      fromReference: true,
      limit: 5,
    })
    expect(parseArgs(["--from-ticker-reference", "--dry-run"]).dryRun).toBe(true)
    expect(parseArgs([])).toMatchObject({ symbol: undefined, fromReference: false, limit: 50 })
  })

  it("uses the captured fixture shape rather than a synthetic one", async () => {
    const body = JSON.parse(readFileSync(`${FIXTURES}/yfinance/PKO.WA-income-annual.json`, "utf8")) as {
      rows: Array<Record<string, unknown>>
    }
    const cachest = await import("../adapters/cachest.js")
    const original = cachest.fetchFundamentals as unknown as ReturnType<typeof vi.fn>
    original.mockResolvedValue({ provider: "yfinance", rows: body.rows })

    await backfillSymbol(db, "PKO.WA")
    const { loadStatements } = await import("../services/fundamentals.js")
    const stored = await loadStatements(db, "PKO.WA", { statement: "income", period: "annual" })
    expect(stored).toHaveLength(body.rows.length)
    expect(stored[0]!.periodKey).toBe("2025-Q4")
    expect(stored[0]!.payload.total_revenue).toBe(body.rows[0]!.total_revenue)
  })
})
