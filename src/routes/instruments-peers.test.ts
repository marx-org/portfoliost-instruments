/**
 * §61.4 — `GET /:symbol/peers` compare rows carry the instrument identity
 * (country + asset class) the shared `TickerBadge` needs. The provider's
 * compare rows carry neither, so they come from the local ticker reference.
 *
 * A real (PGlite) reference table here, unlike `instruments.test.ts`, because
 * the point of the test is the *lookup* — mocking it away would test nothing.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { Hono } from "hono"
import { createInstrumentsRoutes } from "./instruments.js"
import type { DB } from "../db/index.js"
import { syncTickerReference } from "../scripts/tickerref-sync.js"
import * as cachest from "../adapters/cachest.js"

const dbState = vi.hoisted(() => ({ db: null as unknown }))

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
  fetchProfile: vi.fn(),
  fetchQuote: vi.fn(),
  fetchFixedincomeQuote: vi.fn(),
  fetchCryptoQuote: vi.fn(),
  fetchMetrics: vi.fn(),
  fetchProjections: vi.fn(),
  fetchOhlcv: vi.fn(),
  fetchFundamentals: vi.fn(),
  fetchCalendarEarnings: vi.fn(),
  fetchCalendarDividends: vi.fn(),
  fetchSearch: vi.fn(),
  fetchCryptoSearch: vi.fn(),
  fetchBondSearch: vi.fn(),
  fetchBondProfile: vi.fn(),
  fetchBondOhlcv: vi.fn(),
  fetchDividendHistory: vi.fn(),
  fetchFilings: vi.fn(),
  fetchMda: vi.fn(),
  fetchInsiderTrading: vi.fn(),
}))

const mocked = vi.mocked(cachest, true)

const FIXTURE = `listing_key,ticker,exchange,name,asset_type,stock_sector,etf_category,country,country_code,isin,aliases
NASDAQ::AAPL,AAPL,NASDAQ,Apple Inc,Stock,Information Technology,,United States,US,US0378331005,apple
NASDAQ::MSFT,MSFT,NASDAQ,Microsoft Corp,Stock,Information Technology,,United States,US,US5949181045,microsoft`

let close: () => void

function app() {
  const h = new Hono()
  h.route("/api/instruments", createInstrumentsRoutes())
  return h
}

const req = (path: string) =>
  app().request(path, { headers: { "X-User-Id": "user-1", "X-User-Email": "t@example.com" } })

beforeEach(() => {
  mocked.fetchProfile.mockReset()
  mocked.fetchQuote.mockReset()
  mocked.fetchMetrics.mockReset()
})

beforeAll(async () => {
  const { createTestDb } = await import("../db/test-db.js")
  const t = await createTestDb()
  dbState.db = t.db as unknown as DB
  close = () => void t.client.close()
  await syncTickerReference(FIXTURE, dbState.db as never)
})

afterAll(() => close())

describe("GET /:symbol/profile — instrument identity (§61.8)", () => {
  it("fills assetType from the ticker reference, alongside countryCode", async () => {
    mocked.fetchProfile.mockResolvedValue({ symbol: "AAPL", name: "Apple Inc", currency: "USD" })
    const res = await req("/api/instruments/AAPL/profile")
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.countryCode).toBe("US")
    expect(body.assetType).toBe("STOCK")
  })
})

describe("GET /:symbol/peers — instrument identity (§61.4)", () => {
  it("fills countryCode + assetType from the ticker reference", async () => {
    mocked.fetchProfile.mockImplementation(async (s: string) => ({
      symbol: s,
      name: `${s} Inc.`,
      sector: "Technology",
    }))
    mocked.fetchQuote.mockResolvedValue({ last_price: 100 })
    mocked.fetchMetrics.mockResolvedValue({ market_cap: 1e9, pe_ratio: 10 })

    const res = await req("/api/instruments/AAPL/peers")
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.items[0].symbol).toBe("AAPL")
    expect(body.items[0].countryCode).toBe("US")
    expect(body.items[0].assetType).toBe("STOCK")
    const msft = body.items.find((r: { symbol: string }) => r.symbol === "MSFT")
    expect(msft).toBeTruthy()
    expect(msft.countryCode).toBe("US")
    expect(msft.assetType).toBe("STOCK")
  })

  it("leaves both null for a symbol with no reference row — never guessed", async () => {
    mocked.fetchProfile.mockImplementation(async (s: string) => {
      if (s === "AAPL") return { symbol: s, name: "Apple Inc", sector: "Technology" }
      // TSLA is in the peer universe but deliberately absent from the fixture.
      if (s === "TSLA") return { symbol: s, name: "Tesla Inc", sector: "Technology" }
      return { symbol: s, name: `${s} Inc.`, sector: "Financials" }
    })
    mocked.fetchQuote.mockRejectedValue(new cachest.UpstreamError("q", 404))
    mocked.fetchMetrics.mockRejectedValue(new cachest.UpstreamError("m", 404))

    const res = await req("/api/instruments/AAPL/peers")
    expect(res.status).toBe(200)
    const body = await res.json()
    const tsla = body.items.find((r: { symbol: string }) => r.symbol === "TSLA")
    expect(tsla).toBeTruthy()
    expect(tsla.countryCode).toBeNull()
    expect(tsla.assetType).toBeNull()
  })
})
