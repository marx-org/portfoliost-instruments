import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const dbState = vi.hoisted(() => ({ db: null as unknown }))
const fetchCalls = vi.hoisted(() => ({ dividends: [] as string[] }))

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
  fetchDividendHistory: vi.fn(async (symbol: string) => {
    fetchCalls.dividends.push(symbol)
    if (symbol === "AIPOWR.AS") throw new (await import("../adapters/cachest.js")).UpstreamError("x", 404)
    return [
      { date: "2026-08-10", amount: "0.26", payment_date: "2026-08-13" },
      { date: "2026-05-11", amount: "0.25", payment_date: "2026-05-14" },
    ]
  }),
}))

import { backfillSymbol, backfillSymbols, backfillableSymbols, parseArgs, WALK_PAUSE_MS } from "./dividends-backfill.js"
import type { DB } from "../db/index.js"

const TICKERS = `listing_key,ticker,exchange,name,asset_type,stock_sector,etf_category,country,country_code,isin,aliases
STO::AAPL,AAPL,STO,Apple Inc.,Stock,,,,US,,
STO::MSFT,MSFT,STO,Microsoft,Stock,,,,US,,
GPW::PKO,PKO.WA,GPW,PKO BP,Stock,,,,PL,,
ANALIZY::ARK01,ARK01,ANALIZY,Erste Akcji Polskich,fund,,,,PL,,
ETF::AIPOWR,AIPOWR,ETF,Boreas ETF,ETF,,,,AE,,`

describe("dividends backfill", () => {
  let store: { client: { close: () => Promise<void> } } | null = null

  beforeEach(async () => {
    fetchCalls.dividends = []
    const { createTestDb } = await import("../db/test-db.js")
    const t = await createTestDb()
    dbState.db = t.db
    store = t
    const { syncTickerReference } = await import("./tickerref-sync.js")
    await syncTickerReference(TICKERS, t.db as DB)
  })

  afterEach(async () => {
    await store!.client.close()
    dbState.db = null
  })

  it("backfillSymbol stores what the provider tier returns, once", async () => {
    const r = await backfillSymbol(dbState.db as DB, "AAPL")
    expect(r.rows).toBe(2)
    expect(fetchCalls.dividends).toEqual(["AAPL"])
    // a second run obeys the window: no new upstream call
    const r2 = await backfillSymbol(dbState.db as DB, "AAPL")
    expect(r2.rows).toBe(2)
    expect(fetchCalls.dividends).toEqual(["AAPL"])
  })

  it("a 404 symbol is counted empty, not failed", async () => {
    const r = await backfillSymbol(dbState.db as DB, "AIPOWR.AS")
    expect(r.empty).toBe(true)
    expect(fetchCalls.dividends).toEqual(["AIPOWR.AS"])
  })

  it("backfillSymbols runs sequentially and reports per-symbol counts", async () => {
    const results = await backfillSymbols(dbState.db as DB, { symbols: ["AAPL", "MSFT"] })
    expect(results.length).toBe(2)
    expect(fetchCalls.dividends).toEqual(["AAPL", "MSFT"])
  })

  it("backfillableSymbols returns Stock/ETF rows only", async () => {
    const rows = await backfillableSymbols(dbState.db as DB, 10)
    expect(rows).toEqual(["AAPL", "MSFT", "PKO.WA", "AIPOWR"])
  })

  it("--dry-run collects no fetches", async () => {
    const results = await backfillSymbols(dbState.db as DB, { symbols: ["AAPL"], dryRun: true })
    expect(results[0]!.rows).toBe(0)
    expect(fetchCalls.dividends).toEqual([])
  })

  it("parseArgs matches the fundamentals shape", () => {
    expect(parseArgs(["--symbol", "aapl"])).toEqual({ symbol: "AAPL", fromReference: false, limit: 50, dryRun: false })
    expect(parseArgs(["--from-ticker-reference", "--limit", "3", "--dry-run"])).toEqual({ symbol: undefined, fromReference: true, limit: 3, dryRun: true })
  })

  it("WALK_PAUSE_MS is a trickle, not parallelism", () => {
    expect(WALK_PAUSE_MS).toBeGreaterThan(0)
  })
})
