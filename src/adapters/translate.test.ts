import { describe, it, expect } from "vitest"
import {
  marketPhase,
  toInstrumentDetail,
  toInstrumentType,
  toInstrumentProfile,
  toQuote,
  toPriceHistory,
  toInstrumentMetrics,
  toOverviewMetrics,
  toSearchResponse,
  toCryptoSearchResponse,
  toBondSearchResponse,
  toReferenceSearchResponse,
  mergeSearchResults,
  toProjections,
  toCompare,
  toOwnershipData,
  toNewsArticleItem,
  toNewsArticleList,
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
      id: "AAPL",
      symbol: "AAPL",
      name: "Apple Inc.",
      exchange: "NASDAQ",
      type: "STOCK",
      currency: "USD",
    })
  })

  it("maps a savings-bond profile to a PL/BOND detail", () => {
    const bondProfile = {
      symbol: "EDO0936",
      name: "Obligacje 10-letnie EDO",
      series_code: "EDO",
      rate_rule: "cpi_12m+margin",
    }
    expect(toInstrumentDetail("EDO0936", bondProfile)).toEqual({
      id: "EDO0936",
      symbol: "EDO0936",
      name: "Obligacje 10-letnie EDO",
      exchange: "PL",
      type: "BOND",
      currency: "PLN",
    })
  })

  it("maps a Catalyst corporate-bond profile to CORP_BOND (D82)", () => {
    const corpProfile = {
      symbol: "BST0327",
      name: "Best S.A.",
      asset_type: "corp_bond",
      stock_exchange: "GPW RR",
      currency: "PLN",
    }
    const d = toInstrumentDetail("BST0327", corpProfile)
    expect(d.type).toBe("CORP_BOND")
    expect(d.exchange).toBe("GPW RR")
    expect(d.currency).toBe("PLN")
  })

  it("maps a TFI fund profile to FUND (D82)", () => {
    const fundProfile = {
      symbol: "NNEP25.TFI",
      name: "ING Emerytura 2025",
      asset_type: "fund",
      stock_exchange: "GPW",
    }
    expect(toInstrumentDetail("NNEP25.TFI", fundProfile).type).toBe("FUND")
  })
})

describe("toInstrumentType (D82)", () => {
  it("maps stored asset types onto the contract InstrumentType", () => {
    expect(toInstrumentType("Stock")).toBe("STOCK")
    expect(toInstrumentType("ETF")).toBe("ETF")
    expect(toInstrumentType("CRYPTO")).toBe("CRYPTO")
    expect(toInstrumentType("BOND")).toBe("BOND")
    expect(toInstrumentType("corp_bond")).toBe("CORP_BOND")
    expect(toInstrumentType("corporate bond")).toBe("CORP_BOND")
    expect(toInstrumentType("fund")).toBe("FUND")
    expect(toInstrumentType(null)).toBe("STOCK")
    expect(toInstrumentType("")).toBe("STOCK")
    expect(toInstrumentType("unknown-thing")).toBe("STOCK")
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

  it("carries the instrument currency (defaults to USD) — §36", () => {
    expect((toPriceHistory(rows, "daily") as Record<string, any>).currency).toBe("USD")
    expect((toPriceHistory(rows, "daily", "PLN") as Record<string, any>).currency).toBe("PLN")
    expect((toPriceHistory(rows, "monthly", "EUR") as Record<string, any>).currency).toBe("EUR")
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
    expect(r.results[0]).toEqual({ symbol: "AAPL", name: "Apple Inc.", type: "STOCK", exchange: "US", countryCode: "US", source: "SEC" })
    expect(r.results[1].symbol).toBeUndefined()
  })
})

describe("toCryptoSearchResponse", () => {
  it("emits type CRYPTO for normalized yfinance pairs and drops wrapped rows", () => {
    const r = toCryptoSearchResponse([
      { symbol: "BTCUSD", name: "Bitcoin USD" },
      { symbol: "TBTCUSD", name: "tBTC USD" },
      { symbol: "ETHUSD", name: "Ethereum USD" },
    ]) as Record<string, any>
    expect(r.count).toBe(2)
    expect(r.results[0]).toEqual({
      symbol: "BTC-USD",
      name: "Bitcoin USD",
      type: "CRYPTO",
      exchange: "CRYPTO",
      countryCode: null,
      source: "CRYPTO",
    })
    expect(r.results[1].symbol).toBe("ETH-USD")
  })

  it("returns an empty response for no tradeable rows", () => {
    const r = toCryptoSearchResponse([{ symbol: "TBTCUSD", name: "tBTC USD" }])
    expect(r).toEqual({ count: 0, results: [] })
  })
})

describe("toBondSearchResponse", () => {
  it("maps savings-bond rows to type BOND with PL exchange", () => {
    const r = toBondSearchResponse([
      { symbol: "ROD0938", name: "Obligacje Rodzinne 4-letnie ROD", maturity_date: "2030-09-01" },
      { symbol: "EDO0936", name: "Obligacje 10-letnie EDO" },
    ]) as Record<string, any>
    expect(r.count).toBe(2)
    expect(r.results[0]).toEqual({
      symbol: "ROD0938",
      name: "Obligacje Rodzinne 4-letnie ROD",
      type: "BOND",
      exchange: "PL",
      countryCode: "PL",
      source: "OBLIGACJE",
    })
  })

  it("returns empty when no bond rows match", () => {
    const r = toBondSearchResponse([])
    expect(r).toEqual({ count: 0, results: [] })
  })
})

describe("toReferenceSearchResponse", () => {
  it("widens assetType mapping to ETF / CRYPTO / BOND", () => {
    const r = toReferenceSearchResponse([
      { ticker: "SPY", exchange: "NYSE", name: "SPDR S&P 500 ETF", assetType: "ETF", yahooSuffix: null, countryCode: "US" },
      { ticker: "BTC", exchange: "CRYPTO", name: "Bitcoin", assetType: "CRYPTO", yahooSuffix: null, countryCode: null },
      { ticker: "TLT", exchange: "NASDAQ", name: "iShares 20+ Year Treasury Bond ETF", assetType: "BOND", yahooSuffix: null, countryCode: "US" },
    ]) as Record<string, any>
    expect(r.results.map((x: any) => x.type)).toEqual(["ETF", "CRYPTO", "BOND"])
    expect(r.results[1].source).toBe("TICKERDB")
  })
})

describe("mergeSearchResults", () => {
  it("de-duplicates by symbol keeping the first leg and caps at the limit", () => {
    const r = mergeSearchResults(
      [{ symbol: "BTCS", name: "BTCS Inc", type: "STOCK", source: "SEC" }],
      [
        { symbol: "BTC-USD", name: "Bitcoin USD", type: "CRYPTO", source: "CRYPTO" },
        { symbol: "BTCS", name: "BTCS Inc", type: "STOCK", source: "SEC" },
      ],
    )
    expect(r.count).toBe(2)
    expect(r.results!.map((x) => x.symbol)).toEqual(["BTCS", "BTC-USD"])
  })

  it("skips rows without a symbol", () => {
    const r = mergeSearchResults([{ name: "Nameless" } as any])
    expect(r).toEqual({ count: 0, results: [] })
  })
})

describe("toProjections estimate/recommendation blocks", () => {
  it("derives earnings/revenue baselines from reported quarters", () => {
    const out = toProjections(
      "AAPL",
      { target_high: 400, target_low: 215, target_consensus: 324, recommendation: { mean: 2.18, rating: "buy", analysts: 39 } },
      { last_price: 309.35 },
      [
        { period_ending: "2025-09-30", diluted_earnings_per_share: 1.0, total_revenue: 100 },
        { period_ending: "2025-12-31", diluted_earnings_per_share: 1.5, revenue: 200 },
        { period_ending: "2026-03-31", diluted_earnings_per_share: 1.25, operating_revenue: 150 },
      ],
    )
    expect(out.earnings).toMatchObject({ avg: 1.25, high: 1.5, low: 1 })
    expect(out.revenue).toMatchObject({ avg: 150, high: 200, low: 100 })
    expect((out.earnings as any).periods).toHaveLength(4)
    // mean 2.18 rounds to "buy" — all analysts land in that bucket
    expect(out.recommendation).toMatchObject({ buy: 39, strongBuy: 0, hold: 0, analysts: 39 })
  })

  it("survives missing consensus and fundamentals with null blocks", () => {
    const out = toProjections("ZZZ", undefined, undefined, [])
    expect(out.priceTarget).toMatchObject({ low: null, high: null })
    expect(out.earnings).toMatchObject({ avg: null, periods: expect.any(Array) })
    expect(out.recommendation).toMatchObject({ buy: 0, analysts: null })
  })
})

describe("toCompare", () => {
  it("emits a ResearchCompare-shaped snapshot including fcfMargin and sharesOutstanding", () => {
    const out = toCompare(
      { symbol: "AAPL", name: "Apple Inc.", currency: "USD" } as never,
      { last_price: 309.35 } as never,
      { pe_ratio: 35.47, fcf_margin: 28.54, shares_outstanding: 2515201893 } as never,
    )
    expect(out.symbol).toBe("AAPL")
    expect(out.price).toBe(309.35)
    expect(out.peRatio).toBe(35.47)
    expect(out.fcfMargin).toBe(28.54)
    expect(out.sharesOutstanding).toBe(2515201893)
    expect(out.currency).toBe("USD")
  })

  it("leaves unavailable metrics undefined", () => {
    const out = toCompare({ symbol: "ZZZ", name: "Z", currency: "USD" } as never, undefined, {} as never)
    expect(out.fcfMargin).toBeUndefined()
    expect(out.peRatio).toBeUndefined()
  })
})

describe("toNewsArticleItem / toNewsArticleList", () => {
  const row = {
    url: "https://example.com/1",
    title: "Apple unveils new chip",
    summary: "AAPL details",
    source: "polygon",
    publishedAt: new Date("2026-09-08T08:30:00Z"),
    symbols: ["AAPL", "MSFT"],
  }

  it("maps a DB row to the SPA/mock NewsArticle shape", () => {
    const item = toNewsArticleItem(row, "AAPL")
    expect(item.id).toBe("https://example.com/1")
    expect(item.type).toBe("article")
    expect(item.ticker).toBe("AAPL")
    expect(item.metadata).toEqual({ source: "polygon" })
    expect(item.article).toMatchObject({
      title: "Apple unveils new chip",
      url: "https://example.com/1",
      source: "polygon",
      description: "AAPL details",
      published_at: "2026-09-08T08:30:00.000Z",
    })
    expect(item.published_at).toBe("2026-09-08T08:30:00.000Z")
  })

  it("falls back to fetch fallbackTicker when symbols are empty", () => {
    const item = toNewsArticleItem({ ...row, symbols: [] }, "AAPL")
    expect(item.ticker).toBe("AAPL")
  })

  it("builds a single-page NewsArticleList with null cursors", () => {
    const out = toNewsArticleList([row, { ...row, url: "https://example.com/2" }], "AAPL")
    expect(out.data).toHaveLength(2)
    expect(out.pagination).toEqual({
      count: 2,
      total_count: 2,
      has_next_page: false,
      has_previous_page: false,
      next_cursor: null,
      previous_cursor: null,
    })
  })
})

describe("toOwnershipData", () => {
  it("maps Form 4 rows to insiderTransactions with company-value and filing date", () => {
    const out = toOwnershipData("aapl", [
      {
        symbol: "AAPL",
        filing_date: "2026-09-03T10:00:00",
        transaction_date: "2026-09-01",
        owner_name: "Newstead Jennifer",
        acquisition_or_disposition: "Disposition",
        transaction_type: "Open market or private sale",
        securities_transacted: 1439,
        transaction_price: 317.011,
      },
    ])
    expect(out.insiderTransactions).toHaveLength(1)
    expect(out.insiderTransactions![0]).toMatchObject({
      title: "Newstead Jennifer",
      transactionDate: "2026-09-01",
      transactionCode: "Disposition",
      transactionText: "Open market or private sale",
      transactionAmount: 1439,
      transactionValue: roundish(1439 * 317.011),
      filingDate: "2026-09-03",
    })
    expect(out.institutional).toEqual([])
    expect(out.mutualFund).toEqual([])
    expect(out.insider).toEqual([])
  })

  it("drops rows without any usable content", () => {
    const out = toOwnershipData("AAPL", [{ symbol: "AAPL", filing_date: "2026-01-01" }])
    expect(out.insiderTransactions).toEqual([])
  })

  it("keeps holder groups empty when no rows given", () => {
    const out = toOwnershipData("AAPL", null)
    expect(out).toEqual({ institutional: [], mutualFund: [], insider: [], insiderTransactions: [] })
  })
})

function roundish(n: number): number {
  return Math.round(n * 100) / 100
}
