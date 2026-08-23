import { describe, it, expect, vi, beforeEach } from "vitest"
import { Hono } from "hono"
import { createInstrumentsRoutes } from "./instruments.js"
import * as cachest from "../adapters/cachest.js"

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
  fetchMetrics: vi.fn(),
  fetchProjections: vi.fn(),
  fetchOhlcv: vi.fn(),
  fetchFundamentals: vi.fn(),
  fetchCalendarEarnings: vi.fn(),
  fetchCalendarDividends: vi.fn(),
  fetchSearch: vi.fn(),
}))

function appWithUser() {
  const app = new Hono()
  app.route("/api/instruments", createInstrumentsRoutes())
  return app
}

const USER_HEADERS = { "X-User-Id": "user-1", "X-User-Email": "t@example.com" }

function req(path: string) {
  return appWithUser().request(path, { headers: USER_HEADERS })
}

const mocked = vi.mocked(cachest, true)

beforeEach(() => {
  mocked.fetchProfile.mockReset()
  mocked.fetchQuote.mockReset()
  mocked.fetchMetrics.mockReset()
  mocked.fetchProjections.mockReset()
  mocked.fetchOhlcv.mockReset()
  mocked.fetchSearch.mockReset()
})

describe("GET /api/instruments/search", () => {
  it("returns empty result for blank query without upstream call", async () => {
    const res = await req("/api/instruments/search")
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ count: 0, results: [] })
    expect(mocked.fetchSearch).not.toHaveBeenCalled()
  })

  it("translates sec rows into example-service search response", async () => {
    mocked.fetchSearch.mockResolvedValue([{ symbol: "AAPL", name: "Apple Inc.", cik: 320193 }])
    const res = await req("/api/instruments/search?q=apple")
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.count).toBe(1)
    expect(body.results[0].source).toBe("SEC")
    expect(mocked.fetchSearch).toHaveBeenCalledWith("apple")
  })
})

describe("GET /api/instruments/:symbol/profile", () => {
  it("maps profile payload", async () => {
    mocked.fetchProfile.mockResolvedValue({
      name: "Apple Inc.",
      market_cap: 2_000_000_000_000,
      employees: 164000,
    })
    const res = await req("/api/instruments/AAPL/profile")
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ticker).toBe("AAPL")
    expect(body.marketcapUSD).toBe(2_000_000_000_000)
  })

  it("maps upstream 404 to contract NotFound", async () => {
    mocked.fetchProfile.mockRejectedValue(new cachest.UpstreamError("x", 404))
    const res = await req("/api/instruments/NOPE/profile")
    expect(res.status).toBe(404)
    expect((await res.json()).error).toBe("NotFound")
  })

  it("maps other upstream failures to 502", async () => {
    mocked.fetchProfile.mockRejectedValue(new cachest.UpstreamError("x", 503))
    const res = await req("/api/instruments/AAPL/profile")
    expect(res.status).toBe(502)
  })
})

describe("GET /api/instruments/:symbol/quote", () => {
  it("maps quote payload with symbol override", async () => {
    mocked.fetchQuote.mockResolvedValue({
      last_price: 309.35,
      prev_close: 311.3,
      change: -1.95,
      change_percent: -0.0062641,
      currency: "USD",
      last_timestamp: "2026-08-21 20:00:01",
    })
    const res = await req("/api/instruments/aapl/quote")
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.symbol).toBe("AAPL")
    expect(body.currentPrice).toBe(309.35)
    expect(body.percentChange).toBeCloseTo(-0.62641, 4)
  })
})

describe("GET /api/instruments/:symbol/history", () => {
  it("returns parallel-array history from ohlcv rows", async () => {
    mocked.fetchOhlcv.mockResolvedValue([
      { date: "2026-08-18", open: 1, high: 2, low: 0.5, close: 1.5, volume: 10 },
      { date: "2026-08-19", open: 1.5, high: 2.5, low: 1.2, close: 2.2, volume: 12 },
    ])
    const res = await req("/api/instruments/AAPL/history?resolution=daily")
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.symbol).toBe("AAPL")
    expect(body.closePrices).toEqual([1.5, 2.2])
    expect(body.timestamps).toHaveLength(2)
  })

  it("aggregates monthly resolution", async () => {
    mocked.fetchOhlcv.mockResolvedValue([
      { date: "2026-08-01", open: 1, high: 3, low: 0.5, close: 2, volume: 10 },
      { date: "2026-08-19", open: 2, high: 2.5, low: 1.2, close: 2.2, volume: 12 },
      { date: "2026-09-01", open: 3, high: 4, low: 2.8, close: 3.5, volume: 30 },
    ])
    const res = await req("/api/instruments/AAPL/history?resolution=monthly")
    const body = await res.json()
    expect(body.closePrices).toEqual([2.2, 3.5])
    expect(body.volumes).toEqual([22, 30])
  })
})

describe("GET /api/instruments/:symbol/metrics", () => {
  it("attaches consensus when projections succeed and degrades gracefully when not", async () => {
    mocked.fetchMetrics.mockResolvedValue({ pe_ratio: 35.5 })
    mocked.fetchProjections.mockResolvedValue({
      target_high: 400,
      target_low: 245,
      target_consensus: 340.72,
      target_median: 360,
    })
    const ok = await req("/api/instruments/AAPL/metrics")
    expect(ok.status).toBe(200)
    expect((await ok.json()).priceTarget.targetMean).toBeCloseTo(340.72)

    mocked.fetchProjections.mockRejectedValue(new cachest.UpstreamError("x", 404))
    const degraded = await req("/api/instruments/AAPL/metrics")
    expect(degraded.status).toBe(200)
    expect((await degraded.json()).priceTarget).toBeUndefined()
  })
})

describe("GET /api/instruments/:symbol/overview-metrics", () => {
  it("merges metrics with profile employees", async () => {
    mocked.fetchMetrics.mockResolvedValue({ market_cap: 1000 })
    mocked.fetchProfile.mockResolvedValue({ employees: 164000 })
    const res = await req("/api/instruments/AAPL/overview-metrics")
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.marketCap).toBe(1000)
    expect(body.employees).toBe(164000)
  })
})
