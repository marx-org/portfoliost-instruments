import { describe, it, expect } from "vitest"
import {
  marketPhase,
  toInstrumentDetail,
  toInstrumentProfile,
  toQuote,
  toPriceHistory,
  toInstrumentMetrics,
  toOverviewMetrics,
  toSearchResponse,
} from "./translate.js"
import type { OpenstOhlcvRow } from "./openst-types.js"

const fmpProfile = {
  symbol: "AAPL",
  name: "Apple Inc.",
  currency: "USD",
  stock_exchange: "NASDAQ",
  hq_country: "US",
  hq_address1: "One Apple Park Way",
  hq_address_city: "Cupertino",
  hq_state: "CA",
  industry_category: "Technology",
  long_description: "Apple designs...",
  company_url: "https://www.apple.com",
  business_phone_no: "(408) 996-1010",
  employees: 164000,
  ceo: "Timothy Donald Cook",
  cik: "0000320193",
  market_cap: 4514709504000,
}

describe("toInstrumentDetail", () => {
  it("maps profile to stoxly detail shape", () => {
    expect(toInstrumentDetail("aapl", fmpProfile)).toEqual({
      id: "AAPL.US",
      symbol: "AAPL",
      name: "Apple Inc.",
      exchange: "NASDAQ",
      type: "STOCK",
      currency: "USD",
    })
  })
})

describe("toInstrumentProfile", () => {
  it("maps openst fields to finnhub-style contract", () => {
    const p = toInstrumentProfile("aapl", fmpProfile) as Record<string, any>
    expect(p.ticker).toBe("AAPL")
    expect(p.marketCapitalization).toBeCloseTo(4514709.504)
    expect(p.marketcapUSD).toBe(4514709504000)
    expect(p.employeeTotal).toBe(164000)
    expect(p.finnhubIndustry).toBe("Technology")
    expect(p.logo).toBeNull()
    expect(p.gicsSector).toBeNull()
  })
})

describe("marketPhase", () => {
  it("reports closed on weekend", () => {
    // 2026-08-22 is a Saturday
    const saturdayUtcNoon = new Date("2026-08-22T12:00:00Z")
    expect(marketPhase(saturdayUtcNoon).session).toBe("closed")
  })

  it("reports regular during US market hours", () => {
    // 2026-08-19 (Wed) 15:00 ET = 19:00 UTC (EDT, UTC-4)
    const during = new Date("2026-08-19T19:00:00Z")
    expect(marketPhase(during).phase).toBe("regular")
  })

  it("reports pre-market before open", () => {
    const early = new Date("2026-08-19T13:00:00Z") // 09:00 ET
    expect(marketPhase(early).phase).toBe("pre-market")
  })

  it("reports post-market after close", () => {
    const late = new Date("2026-08-19T21:30:00Z") // 17:30 ET
    expect(marketPhase(late).phase).toBe("post-market")
  })
})

describe("toQuote", () => {
  it("maps fmp-style quote and converts fractional change_percent", () => {
    const q = toQuote({
      symbol: "AAPL",
      last_price: 309.35,
      open: 312.05,
      high: 312.38,
      low: 307.01,
      prev_close: 311.3,
      volume: 42216056,
      change: -1.95,
      change_percent: -0.0062641,
      last_timestamp: "2026-08-21 20:00:01",
      bid: 307.5,
      ask: 307.62,
      bid_size: 10,
      ask_size: 20,
      currency: "USD",
    }) as Record<string, any>

    expect(q.symbol).toBe("AAPL")
    expect(q.currentPrice).toBe(309.35)
    expect(q.previousClose).toBe(311.3)
    expect(q.percentChange).toBeCloseTo(-0.62641, 4)
    expect(q.timestamp).toBe(Math.floor(Date.parse("2026-08-21T20:00:01Z") / 1000))
    expect(q.asOf).toBe(q.timestamp * 1000)
    expect(["pre-market", "regular", "post-market", "closed"]).toContain(q.marketSessionPhase)
    expect(q.timezone).toBe("America/New_York")
    expect(q.source).toBe("openst")
  })

  it("derives percentChange when provider omits it", () => {
    const q = toQuote({ last_price: 105, prev_close: 100 }) as Record<string, any>
    expect(q.percentChange).toBeCloseTo(5, 6)
    expect(q.change).toBe(5)
  })
})

describe("toPriceHistory", () => {
  const rows: OpenstOhlcvRow[] = [
    { date: "2026-08-18", open: 307.58, high: 311.49, low: 305.74, close: 310.2, volume: 100 },
    { date: "2026-08-19", open: 310.0, high: 315.0, low: 308.0, close: 312.5, volume: 150 },
    { date: "2026-09-01", open: 320.0, high: 325.0, low: 318.0, close: 324.0, volume: 200 },
  ]

  it("passes daily rows through into parallel arrays with epoch timestamps", () => {
    const h = toPriceHistory(rows, "daily") as Record<string, any>
    expect(h.closePrices).toEqual([310.2, 312.5, 324])
    expect(h.timestamps[0]).toBe(Math.floor(Date.parse("2026-08-18T00:00:00Z") / 1000))
    expect(h.status).toBe("ok")
  })

  it("aggregates monthly resolution", () => {
    const h = toPriceHistory(rows, "monthly") as Record<string, any>
    expect(h.closePrices).toEqual([312.5, 324])
    expect(h.openPrices).toEqual([307.58, 320])
    expect(h.highPrices).toEqual([315, 325])
    expect(h.lowPrices).toEqual([305.74, 318])
    expect(h.volumes).toEqual([250, 200])
  })
})

describe("toInstrumentMetrics", () => {
  it("groups metrics and attaches consensus price target", () => {
    const consensus = {
      target_high: 400,
      target_low: 245,
      target_consensus: 340.72,
      target_median: 360,
      number_of_analysts: 42,
    }
    const m = toInstrumentMetrics("AAPL", { pe_ratio: 35.47, dividend_yield: 0.44 }, consensus) as Record<string, any>
    expect(m.metrics.metric.pe_ratio).toBe(35.47)
    expect(m.metrics.metricType).toBe("all")
    expect(m.priceTarget.targetMean).toBeCloseTo(340.72)
    expect(m.priceTarget.numberAnalysts).toBe(42)
    expect(m.trailingValuation.peRatio).toBe(35.47)
    expect(m.trailingValuation.priceTarget).toBeCloseTo(340.72)
  })
})

describe("toOverviewMetrics", () => {
  it("combines metrics and profile", () => {
    const o = toOverviewMetrics(
      "aapl",
      { market_cap: 4514709504000, revenue: 416161000000 },
      { employees: 164000 },
    ) as Record<string, any>
    expect(o.symbol).toBe("AAPL")
    expect(o.marketCap).toBe(4514709504000)
    expect(o.revenue).toBe(416161000000)
    expect(o.employees).toBe(164000)
  })
})

describe("toSearchResponse", () => {
  it("maps sec rows to stoxly search results", () => {
    const r = toSearchResponse([
      { symbol: "AAPL", name: "Apple Inc.", cik: 320193 },
      { name: "Only Name" },
    ]) as Record<string, any>
    expect(r.count).toBe(2)
    expect(r.results[0]).toEqual({ symbol: "AAPL", name: "Apple Inc.", type: "STOCK", exchange: "US", source: "SEC" })
    expect(r.results[1].symbol).toBeUndefined()
  })
})
