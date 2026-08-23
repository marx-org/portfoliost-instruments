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
  fetchDividendHistory: vi.fn(),
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

  it("translates sec rows into stoxly search response", async () => {
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

beforeEach(() => {
  mocked.fetchProfile.mockReset()
  mocked.fetchQuote.mockReset()
  mocked.fetchMetrics.mockReset()
  mocked.fetchProjections.mockReset()
  mocked.fetchOhlcv.mockReset()
  mocked.fetchSearch.mockReset()
  mocked.fetchFundamentals.mockReset()
  mocked.fetchCalendarEarnings.mockReset()
  mocked.fetchCalendarDividends.mockReset()
  mocked.fetchDividendHistory.mockReset()
})

describe("pt2 routes", () => {
  beforeEach(() => {
    mocked.fetchFundamentals?.mockReset?.()
    mocked.fetchCalendarEarnings?.mockReset?.()
    mocked.fetchCalendarDividends?.mockReset?.()
    mocked.fetchDividendHistory?.mockReset?.()
  })

  describe("GET /:symbol/fundamentals", () => {
    it("assembles financial highlights from the three statements", async () => {
      mocked.fetchFundamentals
        .mockResolvedValueOnce([
          { fiscal_year: 2024, period_ending: "2024-09-28 00:00:00", revenue: 100, net_income: 20, diluted_earnings_per_share: 1.2, ebit: 30, ebitda: 35 },
          { fiscal_year: 2023, period_ending: "2023-09-30 00:00:00", revenue: 90, net_income: 10, diluted_earnings_per_share: 1.0 },
        ])
        .mockResolvedValueOnce([
          { fiscal_year: 2024, total_assets: 500, total_liabilities: 300, shareholders_equity: 200, total_debt: 100, total_current_assets: 150, total_current_liabilities: 100 },
        ])
        .mockResolvedValueOnce([
          { fiscal_year: 2024, operating_cash_flow: 80, capital_expenditure: 20, depreciation_and_amortization: 10 },
        ])

      const res = await req("/api/instruments/AAPL/fundamentals")
      expect(res.status).toBe(200)
      const body = await res.json()
      const inc = body.financialHighlights.incomeStatement
      expect(inc[0].year).toBe(2024)
      expect(inc[0].revenue).toBe(100)
      expect(inc[0].netIncomeGrowth).toBeCloseTo(100) // 20 vs 10 → +100%
      expect(inc[0].netIncomeMargin).toBe(20)
      expect(body.financialHighlights.balanceSheet[0].workingCapital).toBe(50)
      expect(body.financialHighlights.cashFlow[0].freeCashFlow).toBe(60)
    })

    it("maps upstream failure to 502", async () => {
      mocked.fetchFundamentals.mockRejectedValue(new cachest.UpstreamError("x", 500))
      const res = await req("/api/instruments/AAPL/fundamentals")
      expect(res.status).toBe(502)
    })
  })

  describe("GET /:symbol/calendar", () => {
    it("filters window entries by symbol", async () => {
      mocked.fetchCalendarEarnings.mockResolvedValue([
        { symbol: "AAPL", report_date: "2026-09-15" },
        { symbol: "MSFT", report_date: "2026-09-16" },
      ])
      mocked.fetchCalendarDividends.mockResolvedValue([
        { symbol: "AAPL", ex_dividend_date: "2026-09-01", amount: 0.26 },
      ])
      const res = await req("/api/instruments/AAPL/calendar")
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.earnings).toHaveLength(1)
      expect(body.earnings[0]).toMatchObject({ date: "2026-09-15", year: 2026, quarter: 3 })
      expect(body.exDividend[0]).toMatchObject({ date: "2026-09-01", amount: 0.26 })
    })
  })

  describe("GET /:symbol/dividends", () => {
    it("maps openst dividend rows into stoxly history shape", async () => {
      mocked.fetchDividendHistory.mockResolvedValue([
        { date: "2026-05-12", amount: "0.2600" },
        { date: "2026-02-09", amount: "0.2500" },
      ])
      const res = await req("/api/instruments/AAPL/dividends")
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.history[0]).toEqual({ date: "2026-05-12", year: 2026, amount: 0.26, currency: "USD", type: "regular" })
    })
  })

  describe("GET /:symbol/projections", () => {
    it("builds price target block and survives missing quote/consensus", async () => {
      mocked.fetchProjections.mockResolvedValue({ target_high: 400, target_low: 245, target_consensus: 340.72, target_median: 360 })
      mocked.fetchQuote.mockResolvedValue({ last_price: 309.35 })
      const ok = await req("/api/instruments/AAPL/projections")
      expect(ok.status).toBe(200)
      const pt = (await ok.json()).priceTarget
      expect(pt.mean).toBeCloseTo(340.72)
      expect(pt.current).toBeCloseTo(309.35)
      expect(pt.high).toBe(400)

      mocked.fetchQuote.mockRejectedValue(new cachest.UpstreamError("x", 404))
      const degraded = await req("/api/instruments/AAPL/projections")
      expect(degraded.status).toBe(200)
      expect((await degraded.json()).priceTarget.current).toBeNull()
    })
  })

  describe("GET /:symbol/compare", () => {
    it("composes profile+quote+metrics into compare snapshot", async () => {
      mocked.fetchProfile.mockResolvedValue({ symbol: "AAPL", name: "Apple Inc.", currency: "USD" })
      mocked.fetchQuote.mockResolvedValue({ last_price: 309.35 })
      mocked.fetchMetrics.mockResolvedValue({ market_cap: 4514709504000, pe_ratio: 35.47, dividend_yield: 0.44 })
      const res = await req("/api/instruments/AAPL/compare")
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.symbol).toBe("AAPL")
      expect(body.price).toBe(309.35)
      expect(body.peRatio).toBe(35.47)
      expect(body.marketCap).toBe(4514709504000)
    })
  })

  describe("GET /:symbol/price", () => {
    it("rejects malformed dates", async () => {
      const res = await req("/api/instruments/AAPL/price?date=19-08-2026")
      expect(res.status).toBe(400)
    })

    it("returns last close on or before the requested date", async () => {
      mocked.fetchOhlcv.mockResolvedValue([
        { date: "2026-08-14", open: 1, high: 1, low: 1, close: 305.93, volume: 1 },
        { date: "2026-08-18", open: 1, high: 1, low: 1, close: 310.2, volume: 1 },
      ])
      const res = await req("/api/instruments/AAPL/price?date=2026-08-19")
      expect(res.status).toBe(200)
      expect(await res.json()).toMatchObject({ symbol: "AAPL", date: "2026-08-18", price: 310.2 })
      expect(mocked.fetchOhlcv).toHaveBeenCalledWith("AAPL", expect.any(String), "2026-08-19")
    })

    it("returns current price when no date is given (pt1 behavior)", async () => {
      mocked.fetchQuote.mockResolvedValue({ last_price: 309.35, currency: "USD" })
      const res = await req("/api/instruments/AAPL/price")
      expect(res.status).toBe(200)
      expect(await res.json()).toMatchObject({ symbol: "AAPL", price: 309.35, currency: "USD" })
    })

    it("404s when no close exists on or before the date", async () => {
      mocked.fetchOhlcv.mockResolvedValue([])
      const res = await req("/api/instruments/AAPL/price?date=1990-01-01")
      expect(res.status).toBe(404)
    })
  })
})
