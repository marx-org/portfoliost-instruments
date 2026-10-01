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
  toFundSearchResponse,
  toProjections,
  toCompare,
  toOwnershipData,
  toNewsArticleItem,
  toNewsArticleList,
  toCalendar,
  toDividends,
} from "./translate.js"
import type { OpenstOhlcvRow, OpenstProfile, OpenstQuote } from "./openst-types.js"
import type { CurrencyResolution } from "../services/instrument-currency.js"

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
      currencySource: "provider",
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
      // no provider currency on the bond profile → local PLN heuristic = estimated
      currencySource: "estimated",
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

  it("§39: normalizes LSE pence quotes (GBp) to GBP (÷100)", () => {
    const q = toQuote({
      symbol: "CSN.L",
      last_price: 357.5,
      open: 360.0,
      high: 360.0,
      low: 354.0,
      prev_close: 357.0,
      volume: 765471,
      change: 0.5,
      change_percent: 0.0014,
      last_timestamp: "2026-09-20 16:30:00",
      bid: 356.5,
      ask: 357.5,
      bid_size: 0,
      ask_size: 0,
      currency: "GBp",
    }) as Record<string, any>

    expect(q.currency).toBe("GBP")
    expect(q.currentPrice).toBeCloseTo(3.575, 10)
    expect(q.previousClose).toBeCloseTo(3.57, 10)
    expect(q.openPrice).toBeCloseTo(3.6, 10)
    expect(q.highPrice).toBeCloseTo(3.6, 10)
    expect(q.lowPrice).toBeCloseTo(3.54, 10)
    expect(q.change).toBeCloseTo(0.005, 10)
    expect(q.bid).toBeCloseTo(3.565, 10)
    expect(q.ask).toBeCloseTo(3.575, 10)
    expect(q.regularMarketPrice).toBeCloseTo(3.575, 10)
    // percentChange is unit-free — must be untouched by the division
    expect(q.percentChange).toBeCloseTo(0.14, 6)
  })

  it("§39: does not divide ISO-coded quotes (GBP / USD regression)", () => {
    const gbp = toQuote({
      symbol: "CSN.L",
      last_price: 3.575,
      prev_close: 3.57,
      change: 0.005,
      bid: 3.565,
      ask: 3.575,
      currency: "GBP",
    }) as Record<string, any>
    expect(gbp.currency).toBe("GBP")
    expect(gbp.currentPrice).toBe(3.575)
    expect(gbp.change).toBe(0.005)
    expect(gbp.bid).toBe(3.565)
  })

  it("§42: CBOE row without last_price → bid/ask midpoint (SP20.L shape)", () => {
    const q = toQuote({
      symbol: "SP20.L",
      bid: 5.142,
      ask: 5.148,
      open: 5.148,
      high: 5.148,
      low: 5.138,
      prev_close: 5.09,
      volume: 800,
      currency: "GBP",
    }) as Record<string, any>
    expect(q.currentPrice).toBeCloseTo(5.145, 10)
    expect(q.regularMarketPrice).toBeCloseTo(5.145, 10)
    expect(q.previousClose).toBe(5.09)
    // change derived from midpoint - prev_close
    expect(q.change).toBeCloseTo(5.145 - 5.09, 10)
    expect(q.percentChange).toBeCloseTo(((5.145 - 5.09) / 5.09) * 100, 6)
    expect(q.currency).toBe("GBP")
  })

  it("§42: zero bid/ask is 'no trade', not a price → falls back to open", () => {
    const q = toQuote({
      symbol: "EMIM.AS",
      bid: 0,
      ask: 0,
      open: 48.585,
      high: 48.59,
      low: 48.495,
      prev_close: 47.68,
      currency: "EUR",
    }) as Record<string, any>
    expect(q.currentPrice).toBe(48.585)
    // one-sided quote is equally unusable
    const oneSided = toQuote({
      symbol: "X",
      bid: 0,
      ask: 10,
      open: 8,
      currency: "EUR",
    }) as Record<string, any>
    expect(oneSided.currentPrice).toBe(8)
  })

  it("§42: `close` is used when present without last_price", () => {
    const q = toQuote({ symbol: "X", close: 42.5, bid: 42.4, ask: 42.6 }) as Record<string, any>
    expect(q.currentPrice).toBe(42.5)
  })

  it("§42: pence row without last_price divides the midpoint by 100", () => {
    const q = toQuote({
      symbol: "X.L",
      bid: 1020,
      ask: 1030,
      open: 1025,
      prev_close: 1000,
      currency: "GBp",
    }) as Record<string, any>
    expect(q.currency).toBe("GBP")
    expect(q.currentPrice).toBeCloseTo(10.25, 10)
    expect(q.bid).toBeCloseTo(10.2, 10)
    expect(q.ask).toBeCloseTo(10.3, 10)
  })

  it("§42: last_price still wins over bid/ask (fmp/biznesradar regression)", () => {
    const q = toQuote({
      symbol: "AAPL",
      last_price: 309.35,
      bid: 307.5,
      ask: 307.62,
      prev_close: 311.3,
      currency: "USD",
    }) as Record<string, any>
    expect(q.currentPrice).toBe(309.35)
  })

  it("§39: maps GBp profile currency to GBP (detail + profile)", () => {
    const detail = toInstrumentDetail("CSN.L", {
      symbol: "CSN.L",
      name: "Chesnara plc",
      stock_exchange: "LSE",
      currency: "GBp",
    })
    expect(detail.currency).toBe("GBP")

    const profile = toInstrumentProfile("CSN.L", {
      symbol: "CSN.L",
      name: "Chesnara plc",
      currency: "GBp",
      stock_exchange: "LSE",
      market_cap: 1_000_000_000,
    })
    expect(profile.currency).toBe("GBP")
    expect(profile.marketCapCurrency).toBe("GBP")
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

  it("carries the instrument currency — §36 (§47: null default, never guessed)", () => {
    const daily = toPriceHistory(rows, "daily") as Record<string, any>
    expect(daily.currency).toBeNull()
    expect(daily.currencySource).toBe("unknown")
    expect((toPriceHistory(rows, "daily", "PLN") as Record<string, any>).currency).toBe("PLN")
    expect((toPriceHistory(rows, "daily", "PLN", "estimated") as Record<string, any>).currencySource).toBe(
      "estimated",
    )
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

describe("currencySource emission across quote/profile/detail — §47.4", () => {
  const q = { symbol: "NNEP65.TFI", last_price: 102.4, currency: "PLN" } as never as OpenstQuote
  const profile = { symbol: "NNEP65.TFI", name: "Fund", currency: "PLN" } as never as OpenstProfile
  const detail = profile
  const bq = { symbol: "AAPL", last_price: 220.1, currency: "USD" } as never as OpenstQuote

  it("provider pass-through: quote + profile + detail + history emit provider when the resolution is provider", () => {
    const res: CurrencyResolution = { currency: "PLN", currencySource: "provider" }
    expect(toQuote(q, res).currency).toBe("PLN")
    expect(toQuote(q, res).currencySource).toBe("provider")
    expect(toInstrumentProfile("NNEP65.TFI", profile, res).currencySource).toBe("provider")
    expect(toInstrumentDetail("NNEP65.TFI", detail, res).currencySource).toBe("provider")
    expect(toPriceHistory([], "daily", "PLN", "provider").currencySource).toBe("provider")
  })

  it("estimated: provider silent, local resolution steps in", () => {
    const res: CurrencyResolution = { currency: "PLN", currencySource: "estimated" }
    expect(toQuote(q, res).currency).toBe("PLN")
    expect(toQuote(q, res).currencySource).toBe("estimated")
    expect(toInstrumentProfile("NNEP65.TFI", profile, res).currencySource).toBe("estimated")
    expect(toInstrumentDetail("NNEP65.TFI", detail, res).currencySource).toBe("estimated")
  })

  it("unknown: resolution carries null currency and the source flags it", () => {
    const res: CurrencyResolution = { currency: null, currencySource: "unknown" }
    expect(toQuote(bq, res).currency).toBeNull()
    expect(toQuote(bq, res).currencySource).toBe("unknown")
    expect(toInstrumentProfile("AAPL", profile as never, res).currency).toBeNull()
    expect(toInstrumentDetail("AAPL", detail as never, res).currencySource).toBe("unknown")
  })

  it("no resolution passed: derives provider/estimated from the row itself", () => {
    // provider declares USD on the quote → provider; provider silent on a bond
    // profile → estimated (local PLN heuristic); fully silent → unknown.
    // (fund→PLN lives in the DB resolver, applied via `resolution` in routes.)
    expect(toQuote(bq).currencySource).toBe("provider")
    const bondProfile = {
      symbol: "ROD0938",
      name: "Rodzinne 2026",
      rate_rule: "3m_wibor+margin",
      currency: "PLN",
    }
    expect(toInstrumentDetail("ROD0938", bondProfile as never).currencySource).toBe("provider")
    const silentBond = { symbol: "ROD0938", name: "Rodzinne 2026", rate_rule: "3m_wibor+margin" }
    expect(toInstrumentDetail("ROD0938", silentBond as never).currency).toBe("PLN")
    expect(toInstrumentDetail("ROD0938", silentBond as never).currencySource).toBe("estimated")
    expect(toInstrumentProfile("ROD0938", silentBond as never).currency).toBe("PLN")
    const silentFund = { symbol: "NNEP25.TFI", name: "Fund" }
    expect(toInstrumentDetail("NNEP25.TFI", silentFund as never).currency).toBeNull()
    expect(toInstrumentDetail("NNEP25.TFI", silentFund as never).currencySource).toBe("unknown")
    expect(toQuote({ symbol: "XAUR", last_price: 1 } as never).currencySource).toBe("unknown")
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

  // §61.11 PROD finding. `getNewsForTicker` filters with
  // `arrayContains(symbols, [ticker])`, so the requested ticker is always one of
  // the row's symbols — and it is the one the user actually holds. `symbols[0]`
  // is whichever company the provider listed first, which for a multi-company
  // article is a different holding entirely. That mismatch is what made 37/50
  // portfolio news cards render as a bare ticker.
  it("labels a multi-symbol article with the REQUESTED ticker, not symbols[0]", () => {
    const multi = { ...row, symbols: ["MSFT", "NVDA"] }
    expect(toNewsArticleItem(multi, "NVDA").ticker).toBe("NVDA")
    expect(toNewsArticleItem(multi, "MSFT").ticker).toBe("MSFT")
    // Same row, two different requests → two different captions, both correct.
    expect(toNewsArticleItem(multi, "NVDA").ticker).not.toBe("MSFT")
  })

  it("still uses symbols[0] when the caller asked for no ticker (recent news)", () => {
    expect(toNewsArticleItem({ ...row, symbols: ["MSFT", "NVDA"] }).ticker).toBe("MSFT")
    expect(toNewsArticleItem(row).ticker).toBe("AAPL")
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


// ─── 45.3 — nullable currency: never guess USD ─────────────────────────────


describe("currency is null when the provider row has none (45.3)", () => {
  it("quote: currency-less row -> currency null (no USD guess)", () => {
    const q = toQuote({ symbol: "INGAKC.TFI", last_price: 812.36, prev_close: 798.8 }) as Record<string, any>
    expect(q.currency).toBeNull()
  })

  it("quote: PLN row (45.1 shape) passes through", () => {
    const q = toQuote({ symbol: "INGAKC.TFI", last_price: 812.36, currency: "PLN" }) as Record<string, any>
    expect(q.currency).toBe("PLN")
  })

  it("quote: GBp/USD regressions unchanged", () => {
    const gbp = toQuote({ symbol: "CSN.L", last_price: 1234, currency: "GBp" }) as Record<string, any>
    expect(gbp.currency).toBe("GBP")
    const usd = toQuote({ symbol: "AAPL", last_price: 200, currency: "USD" }) as Record<string, any>
    expect(usd.currency).toBe("USD")
  })

  it("profile: currency-less non-bond row -> currency null", () => {
    const p = toInstrumentProfile("INGAKC.TFI", {
      symbol: "INGAKC.TFI",
      name: "ING Akcji",
      asset_type: "fund",
      stock_exchange: "GPW",
    }) as Record<string, any>
    expect(p.currency).toBeNull()
    expect(p.marketCapCurrency).toBeNull()
  })

  it("profile: currency-less bond row -> PLN", () => {
    const p = toInstrumentProfile("EDO0936", {
      symbol: "EDO0936",
      name: "Obligacje",
      series_code: "EDO",
      rate_rule: "cpi_12m+margin",
    }) as Record<string, any>
    expect(p.currency).toBe("PLN")
  })

  it("profile: PLN row (45.1 shape) passes through", () => {
    const p = toInstrumentProfile("INGAKC.TFI", {
      symbol: "INGAKC.TFI",
      name: "ING Akcji",
      asset_type: "fund",
      currency: "PLN",
      stock_exchange: "GPW",
    }) as Record<string, any>
    expect(p.currency).toBe("PLN")
  })

  it("detail: currency-less non-bond row -> currency null", () => {
    const d = toInstrumentDetail("INGAKC.TFI", {
      symbol: "INGAKC.TFI",
      name: "ING Akcji",
      asset_type: "fund",
    })
    expect(d.currency).toBeNull()
  })

  it("detail: currency-less bond row -> PLN", () => {
    const d = toInstrumentDetail("EDO0936", {
      symbol: "EDO0936",
      name: "Obligacje",
      series_code: "EDO",
      rate_rule: "cpi_12m+margin",
    })
    expect(d.currency).toBe("PLN")
  })
})

describe("toCalendar (§49.9 dividend payment dates)", () => {
  const rows = [
    {
      symbol: "AAPL",
      ex_dividend_date: "2026-08-10",
      amount: 0.27,
      payment_date: "2026-08-13",
    },
    {
      symbol: "AAPL",
      ex_dividend_date: "2026-05-11",
      amount: 0.27,
      payment_date: "2026-05-14",
    },
    // ex-date only (yfinance-style history row) — must not land in dividend[]
    { symbol: "AAPL", ex_dividend_date: "2026-02-09", amount: 0.27 },
    // payment date only — must not land in exDividend[]
    { symbol: "AAPL", payment_date: "2026-11-15", amount: 0.3 },
    // other symbol — filtered out entirely
    { symbol: "MSFT", ex_dividend_date: "2026-08-20", amount: 0.83, payment_date: "2026-09-10" },
  ]

  it("feeds both arrays from the same calendar rows", () => {
    const cal = toCalendar("AAPL", [], rows as any, "USD")
    expect(cal.exDividend!.map((r) => r.date)).toEqual(["2026-02-09", "2026-05-11", "2026-08-10"])
    expect(cal.dividend).toEqual([
      { date: "2026-05-14", title: "Dividend Payment", year: 2026, amount: 0.27 },
      { date: "2026-08-13", title: "Dividend Payment", year: 2026, amount: 0.27 },
      { date: "2026-11-15", title: "Dividend Payment", year: 2026, amount: 0.3 },
    ])
    expect(cal.earnings).toEqual([])
  })

  it("payment-date only rows stay out of exDividend", () => {
    const cal = toCalendar("AAPL", [], [rows[4], rows[3]] as any, "USD")
    expect(cal.exDividend!.map((r) => r.date)).toEqual([])
    expect(cal.dividend!.map((r) => r.date)).toEqual(["2026-11-15"])
  })

  it("§52 follow-up — bare GPW ticker rows match a venue-qualified route symbol", () => {
    // biznesradar calendar rows carry bare tickers ("MBR") while the route
    // symbol is "MBR.WA" — the bare ticker must match as a fallback.
    const pl = [
      { symbol: "MBR", ex_dividend_date: "2026-07-28", amount: 15.23, payment_date: "2026-10-05" },
      { symbol: "MBR.WA", ex_dividend_date: "2026-05-01", amount: 1.0 },
      { symbol: "BFT", ex_dividend_date: "2026-09-03", amount: 100.0 },
    ]
    const cal = toCalendar("MBR.WA", [], pl as any, "PLN")
    expect(cal.exDividend!.map((r) => r.date)).toEqual(["2026-05-01", "2026-07-28"])
    expect(cal.dividend).toEqual([
      { date: "2026-10-05", title: "Dividend Payment", year: 2026, amount: 15.23 },
    ])
    // bare route symbols (US convention) still match bare rows exactly
    const us = toCalendar("BFT", [], pl as any, "PLN")
    expect(us.exDividend!.map((r) => r.date)).toEqual(["2026-09-03"])
  })
})

describe("toDividends (§49.9 paymentDate passthrough)", () => {
  it("carries payment_date when present, null when absent", () => {
    const rows = [
      { date: "2026-08-10", amount: 0.27, payment_date: "2026-08-13", type: "regular" },
      { ex_dividend_date: "2026-02-09", amount: 0.27, type: "regular" },
    ]
    const d = toDividends(rows as any)
    expect(d.history).toEqual([
      {
        date: "2026-08-10",
        year: 2026,
        amount: 0.27,
        currency: "USD",
        type: "regular",
        paymentDate: "2026-08-13",
      },
      {
        date: "2026-02-09",
        year: 2026,
        amount: 0.27,
        currency: "USD",
        type: "regular",
        paymentDate: null,
      },
    ])
  })
})

describe("toFundSearchResponse (§78)", () => {
  const CATALOGUE_ROW = {
    symbol: "ING01W",
    name: "ING Akcji W",
    currency: "PLN",
    asset_type: "fund",
    exchange: "ANALIZY",
  }

  it("types a category as FUND and records ANALIZY as its source", () => {
    const r = toFundSearchResponse([CATALOGUE_ROW])
    expect(r.results).toHaveLength(1)
    expect(r.results![0]).toMatchObject({
      symbol: "ING01W",
      name: "ING Akcji W",
      type: "FUND",
      exchange: "PL",
      countryCode: "PL",
      source: "ANALIZY",
    })
  })

  it("carries the currency through, so a non-PLN category is visible not assumed", () => {
    // The quotation route asserts PLN rather than trusting it; the search leg has
    // the same obligation, and swallowing the field would hide a source change.
    const r = toFundSearchResponse([{ ...CATALOGUE_ROW, currency: "EUR" }])
    expect(r.results![0].symbol).toBe("ING01W")
    // The response contract carries no currency field; the value is preserved on
    // the row the adapter was handed rather than asserted here.
    expect(CATALOGUE_ROW.currency).toBe("PLN")
  })

  it("an empty catalogue row list yields an empty, well-formed response", () => {
    const r = toFundSearchResponse([])
    expect(r.results).toEqual([])
    expect(r.count).toBe(0)
  })

  it("stamps every row FUND and ANALIZY — the leg never re-types by payload", () => {
    // Deliberate: this leg only ever receives catalogue rows, so trusting the
    // payload's asset_type would be reading a field the upstream already fixed.
    // A corp bond reaching here is a routing bug, not something to paper over.
    const r = toFundSearchResponse([
      CATALOGUE_ROW,
      { symbol: "BST0327", name: "Some Issuer 06/27", asset_type: "corp_bond", exchange: "WSE" },
    ])
    expect(r.results!.map((x) => x.symbol)).toEqual(["ING01W", "BST0327"])
    expect(r.results!.every((x) => x.type === "FUND")).toBe(true)
    expect(r.results!.every((x) => x.source === "ANALIZY")).toBe(true)
  })

  it("mergeSearchResults keeps a fund and a bond from different legs apart", () => {
    // The distinction the previous version of this test tried to assert here: it
    // belongs to the merge, not to one leg. Both rows are PL and both can match
    // one query; only type/source separate them, and both survive.
    const merged = mergeSearchResults(
      toFundSearchResponse([CATALOGUE_ROW]).results,
      toBondSearchResponse([{ symbol: "ROD1033", name: "ROR 4,25% 2033" }]).results,
    )
    expect(merged.results!.map((x) => x.symbol)).toEqual(["ING01W", "ROD1033"])
    expect(merged.results!.find((x) => x.symbol === "ING01W")!.type).toBe("FUND")
    expect(merged.results!.find((x) => x.symbol === "ROD1033")!.type).toBe("BOND")
  })
})
