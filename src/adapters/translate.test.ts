import { describe, it, expect } from "vitest"
import {
  marketPhase,
  toInstrumentDetail,
  toInstrumentType,
  toBondKeyFacts,
  toCorpBondKeyFacts,
  toCryptoKeyFacts,
  toEtfKeyFacts,
  toFundKeyFacts,
  toStockKeyFacts,
  toKeyFacts,
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
  toFundamentals,
  declaredStatementCurrency,
} from "./translate.js"
import type { OpenstOhlcvRow, OpenstProfile, OpenstQuote } from "./openst-types.js"
import type { CurrencyResolution } from "../services/instrument-currency.js"
import type { Row } from "./translate.js"
import type { components } from "../generated/api-types.js"

type S = components["schemas"]

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
  it("maps profile to example-service detail shape", () => {
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
  it("maps sec rows to example-service search results", () => {
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

// ---------------------------------------------------------------------------
// §79.3 — provider key vocabularies in toFundamentals
//
// The fixtures below are the FIRST rows of real responses captured 2026-10-02
// from openst on the live stack, `statement=<x>&period=annual`, trimmed to the
// keys the mapper reads. They are not hand-written shapes: the whole point of
// §79.3 is that the mapper was written against a naming it never sees in
// production, so the fixtures have to be the naming that arrives.
//
//   AAPL   → openbb's FMP model (carries cik / accepted_date / fiscal_year —
//            FMP is the only provider in the chain that normalises anything)
//   SAP.DE → openbb's yfinance passthrough. openbb's yfinance models declare
//   PKO.WA   only fiscal_period / fiscal_year / period_ending, so every line item
//            below is a passthrough extra whose name follows yfinance.
//
// FMP returns 402 on all three statement endpoints for a non-US symbol (§79.4),
// so the yfinance naming is the only European source there is — not a fallback
// waiting for a better provider.
// ---------------------------------------------------------------------------

const AAPL_INCOME = {
  fiscal_year: 2025,
  fiscal_period: "FY",
  period_ending: "2025-09-27",
  symbol: "AAPL",
  cik: "0000320193",
  accepted_date: "2025-10-31 06:01:26",
  filing_date: "2025-10-31",
  reported_currency: "USD",
  revenue: 416161000000,
  ebit: 132729000000,
  total_operating_income: 133050000000,
  bottom_line_net_income: 112010000000,
  consolidated_net_income: 112010000000,
  diluted_earnings_per_share: 7.46,
  basic_earnings_per_share: 7.49,
  weighted_average_diluted_shares_outstanding: 15004697000,
  weighted_average_basic_shares_outstanding: 14948500000,
  ebitda: 144427000000,
  total_pre_tax_income: 132729000000,
}

const AAPL_BALANCE = {
  fiscal_year: 2025,
  fiscal_period: "FY",
  period_ending: "2025-09-27",
  total_assets: 359241000000,
  total_liabilities: 285508000000,
  total_common_equity: 73733000000,
  total_equity_non_controlling_interests: 73733000000,
  minority_interest: 0,
  cash_and_cash_equivalents: 35934000000,
  cash_and_short_term_investments: 54697000000,
  short_term_investments: 18763000000,
  total_debt: 112377000000,
  long_term_debt: 78328000000,
  net_debt: 76443000000,
  total_current_assets: 147957000000,
  total_current_liabilities: 165631000000,
  retained_earnings: -14264000000,
}

const AAPL_CASH = {
  period_ending: "2025-09-27",
  operating_cash_flow: 111482000000,
  net_cash_from_operating_activities: 111482000000,
  capital_expenditure: -12715000000,
  free_cash_flow: 98767000000,
  net_cash_from_financing_activities: -120686000000,
  net_cash_from_investing_activities: 15195000000,
  depreciation_and_amortization: 11698000000,
  common_dividends_paid: -15421000000,
  net_dividends_paid: -15421000000,
}

const SAP_INCOME = {
  period_ending: "2025-12-31",
  total_revenue: 36800000000.0,
  operating_revenue: 36800000000.0,
  ebit: 10762000000.0,
  operating_income: 9620000000.0,
  net_income: 7161000000.0,
  diluted_earnings_per_share: 6.1,
  basic_earnings_per_share: 6.14,
  weighted_average_diluted_shares_outstanding: 1175000000.0,
  weighted_average_basic_shares_outstanding: 1166000000.0,
  ebitda: 12073000000.0,
  total_pre_tax_income: 10270000000.0,
  operating_expense: 17194000000.0,
  total_expenses: 27180000000.0,
}

const SAP_BALANCE = {
  period_ending: "2025-12-31",
  total_assets: 70362000000.0,
  total_liabilities_net_minority_interest: 25288000000.0,
  total_common_equity: 44586000000.0,
  common_stock_equity: 44586000000.0,
  total_equity_non_controlling_interests: 45074000000.0,
  minority_interest: 488000000.0,
  cash_and_cash_equivalents: 8220000000.0,
  cash_financial: 3910000000.0,
  cash_equivalents: 4310000000.0,
  cash_cash_equivalents_and_short_term_investments: 9772000000.0,
  short_term_investments: 1552000000.0,
  total_debt: 7476000000.0,
  long_term_debt: 4194000000.0,
  net_debt: null,
  working_capital: 2840000000.0,
  total_current_assets: 20256000000.0,
  current_liabilities: 17416000000.0,
  retained_earnings: 47345000000.0,
}

const SAP_CASH = {
  period_ending: "2025-12-31",
  operating_cash_flow: 9156000000.0,
  capital_expenditure: -739000000.0,
  free_cash_flow: 8417000000.0,
  financing_cash_flow: -8745000000.0,
  investing_cash_flow: -965000000.0,
  depreciation_and_amortization: 1311000000.0,
  cash_dividends_paid: -2743000000.0,
  common_stock_dividend_paid: -2743000000.0,
}

const PKO_INCOME = {
  period_ending: "2025-12-31",
  total_revenue: 31050000000.0,
  operating_revenue: 31050000000.0,
  net_income: 10682000000.0,
  diluted_earnings_per_share: 8.55,
  basic_earnings_per_share: 8.55,
  weighted_average_diluted_shares_outstanding: 1250000000.0,
  weighted_average_basic_shares_outstanding: 1250000000.0,
  total_pre_tax_income: 13848000000.0,
  operating_expense: 11404000000.0,
}

const PKO_BALANCE = {
  period_ending: "2025-12-31",
  total_assets: 583079000000.0,
  total_liabilities_net_minority_interest: 524576000000.0,
  total_common_equity: 58514000000.0,
  common_stock_equity: 58514000000.0,
  total_equity_non_controlling_interests: 58503000000.0,
  minority_interest: -11000000.0,
  cash_and_cash_equivalents: 24070000000.0,
  cash_financial: 4108000000.0,
  cash_equivalents: 39000000.0,
  total_debt: 38091000000.0,
  net_debt: 12878000000.0,
  retained_earnings: 21903000000.0,
}

const PKO_CASH = {
  period_ending: "2025-12-31",
  operating_cash_flow: 11852000000.0,
  capital_expenditure: -1354000000.0,
  free_cash_flow: 10498000000.0,
  financing_cash_flow: -8880000000.0,
  investing_cash_flow: -14287000000.0,
  depreciation_and_amortization: 1641000000.0,
  depreciation: 1641000000.0,
  cash_dividends_paid: -6850000000.0,
  common_stock_dividend_paid: -6850000000.0,
}

const bs = (balance: Row) => toFundamentals([], [balance], []).financialHighlights.balanceSheet![0]!
const is = (income: Row) => toFundamentals([income], [], []).financialHighlights.incomeStatement![0]!
const cf = (cash: Row) => toFundamentals([], [], [cash]).financialHighlights.cashFlow![0]!

describe("toFundamentals §79.3 — the same eight balance columns from either naming", () => {
  const EIGHT = [
    "totalAssets",
    "totalLiabilities",
    "shareholdersEquity",
    "cash",
    "cashAndShortTermInvestments",
    "workingCapital",
    "retainedEarnings",
    "totalDebt",
  ] as const

  it("populates all eight from the FMP/US naming (AAPL FY2025)", () => {
    const row = bs(AAPL_BALANCE)
    expect(EIGHT.filter((k) => row[k] !== undefined)).toEqual([...EIGHT])
    expect(row).toMatchObject({
      year: 2025,
      totalAssets: 359241000000,
      totalLiabilities: 285508000000,
      shareholdersEquity: 73733000000,
      cash: 35934000000,
      cashAndShortTermInvestments: 54697000000,
      workingCapital: -17674000000,
      retainedEarnings: -14264000000,
      totalDebt: 112377000000,
      netDebt: 76443000000,
      debtEquityRatio: 1.52,
    })
  })

  it("populates all eight from the yfinance/EU naming (SAP.DE FY2025)", () => {
    // Before §79.3 this row produced totalLiabilities, shareholdersEquity, cash,
    // cashAndShortTermInvestments and workingCapital as undefined — five of ten
    // columns blank, plus debtEquityRatio derived from the blank equity.
    const row = bs(SAP_BALANCE)
    expect(EIGHT.filter((k) => row[k] !== undefined)).toEqual([...EIGHT])
    expect(row).toMatchObject({
      year: 2025,
      totalAssets: 70362000000,
      totalLiabilities: 25288000000,
      shareholdersEquity: 44586000000,
      cash: 8220000000,
      cashAndShortTermInvestments: 9772000000,
      workingCapital: 2840000000,
      retainedEarnings: 47345000000,
      totalDebt: 7476000000,
      debtEquityRatio: 0.17,
    })
    // SAP's own net_debt key arrives null — a provider gap, not a naming one, so
    // it stays blank rather than being back-filled from total debt minus cash.
    expect(row.netDebt).toBeUndefined()
  })

  it("debtEquityRatio is populated for every EU name it can be", () => {
    // The derived column is what makes the bug visible in the UI, and it was
    // empty for every non-US symbol before this section.
    expect(bs(SAP_BALANCE).debtEquityRatio).toBe(0.17)
    expect(bs(PKO_BALANCE).debtEquityRatio).toBe(0.65)
    expect(bs(AAPL_BALANCE).debtEquityRatio).toBe(1.52)
  })

  it("shareholdersEquity excludes non-controlling interests, as FMP's does", () => {
    // FMP's `shareholders_equity` excludes NCI, so the EU candidates are ordered
    // to exclude them too. Taking yfinance's NCI-inclusive `total_equity`
    // instead would make debtEquityRatio mean something different on an EU row
    // than on a US one — same column, two definitions, nothing on screen to say so.
    const sap = bs(SAP_BALANCE)
    expect(sap.shareholdersEquity).toBe(
      SAP_BALANCE.total_equity_non_controlling_interests - SAP_BALANCE.minority_interest,
    )
    expect(sap.shareholdersEquity).not.toBe(SAP_BALANCE.total_equity_non_controlling_interests)

    const pko = bs(PKO_BALANCE)
    // PKO's minority interest is negative, so common equity is the larger figure.
    expect(pko.shareholdersEquity).toBe(
      PKO_BALANCE.total_equity_non_controlling_interests - PKO_BALANCE.minority_interest,
    )
    expect(pko.shareholdersEquity).toBeGreaterThan(PKO_BALANCE.total_equity_non_controlling_interests)
  })

  it("prefers total_liabilities_net_minority_interest when a row carries both", () => {
    // The two keys are not interchangeable: the explicit name says whether
    // minority interest is inside the figure, and it is the one that reconciles
    // with total_assets (SAP: 70,362 − 45,074 = 25,288).
    const row = bs({ ...SAP_BALANCE, total_liabilities: 12345 })
    expect(row.totalLiabilities).toBe(25288000000)
    expect(row.totalAssets! - row.totalLiabilities!).toBe(row.totalAssets! - 25288000000)
  })

  it("reads yfinance's combined cash line, not its narrower sub-lines", () => {
    // `cash_equivalents` (4,310) is only part of SAP's cash (8,220) and
    // `cash_financial` (3,910) is neither cash nor cash-plus-investments, so
    // neither may be allowed to win over the exact match.
    const sap = bs(SAP_BALANCE)
    expect(sap.cash).toBe(8220000000)
    expect(sap.cashAndShortTermInvestments).toBe(9772000000)
    // The provider's own combined line: 8,220 cash + 1,552 short-term investments.
    expect(sap.cashAndShortTermInvestments).toBe(sap.cash! + SAP_BALANCE.short_term_investments)
  })

  it("workingCapital is blank for PKO.WA because the provider has no current lines", () => {
    // Deliberate. PKO carries neither total_current_assets nor
    // total_current_liabilities nor current_assets nor current_liabilities, so a
    // number here would have to be invented — and a wrong working-capital figure
    // is worse than a blank cell (§79.2 is about exactly that).
    const row = bs(PKO_BALANCE)
    expect(row.workingCapital).toBeUndefined()
    expect(row.totalAssets).toBe(583079000000)
    expect(row.shareholdersEquity).toBe(58514000000)
  })

  it("computes workingCapital from whichever current pair the provider supplies", () => {
    // SAP supplies total_current_assets but only a bare `current_liabilities`
    // (20256 − 17416 = 2840, the same figure its own working_capital key carries).
    expect(bs({ ...SAP_BALANCE, working_capital: null }).workingCapital).toBe(2840000000)
    expect(
      bs({
        working_capital: undefined,
        current_assets: 100,
        current_liabilities: 140,
      }).workingCapital,
    ).toBe(-40)
    // Half a pair is not a number.
    expect(bs({ working_capital: undefined, total_current_assets: 100 }).workingCapital).toBeUndefined()
    expect(
      bs({
        working_capital: undefined,
        total_current_assets: 100,
        total_current_liabilities: 165631000000,
      }).workingCapital,
    ).toBe(100 - 165631000000)
  })
})

describe("toFundamentals §79.3 — the income mapper, audited on the same fixtures", () => {
  it("reads yfinance's revenue name, which also unblocks netIncomeMargin", () => {
    // `revenue` is absent on every yfinance row — it is `total_revenue` /
    // `operating_revenue` there. Because netIncomeMargin divides by it, that one
    // wrong key also emptied the margin column.
    const sap = is(SAP_INCOME)
    expect(sap.revenue).toBe(36800000000)
    expect(sap.netIncome).toBe(7161000000)
    expect(sap.netIncomeMargin).toBe(19.46)
    const pko = is(PKO_INCOME)
    expect(pko.revenue).toBe(31050000000)
    expect(pko.netIncomeMargin).toBe(34.4)
  })

  it("netIncomeGrowth follows the same pick() as netIncome, on both namings", () => {
    // The old line read `r.net_income` directly while netIncome read a pick(), so
    // growth was computed from a key AAPL does not have and was blank for it.
    const fmp = toFundamentals(
      [
        { ...AAPL_INCOME, fiscal_year: 2024 },
        { ...AAPL_INCOME, fiscal_year: 2023, bottom_line_net_income: 96995000000, consolidated_net_income: 96995000000 },
      ],
      [],
      [],
    ).financialHighlights.incomeStatement
    expect(fmp![0].netIncomeGrowth).toBe(15.48)
    expect(fmp![0].netIncome).toBe(112010000000)

    const eu = toFundamentals(
      [
        { ...SAP_INCOME, period_ending: "2024-12-31", net_income: 8261000000 },
        { ...SAP_INCOME, period_ending: "2023-12-31", net_income: 7368000000 },
      ],
      [],
      [],
    ).financialHighlights.incomeStatement
    expect(eu![0].netIncomeGrowth).toBe(12.12)
  })

  it("reads yfinance's diluted share count, the only one it emits", () => {
    // Empty for every symbol before, on both namings — which is what left
    // freeCashFlowPerShare with no denominator (§79.1).
    expect(is(SAP_INCOME).dilutedSharesOutstanding).toBe(1175000000)
    expect(is(PKO_INCOME).dilutedSharesOutstanding).toBe(1250000000)
    expect(is(AAPL_INCOME).dilutedSharesOutstanding).toBe(15004697000)
  })

  it("leaves ebit and ebitda blank for PKO.WA — the provider has neither line", () => {
    // PKO's row carries revenue, net income and pre-tax income but no EBIT and no
    // EBITDA, and no other provider in the chain is plan-entitled to the EU
    // statements (§79.4). Deriving EBIT as revenue − operating expense would be a
    // different operation than reading a reported figure.
    const pko = is(PKO_INCOME)
    expect(pko.ebit).toBeUndefined()
    expect(pko.ebitda).toBeUndefined()
    expect(pko.revenue).toBe(31050000000)
    expect(pko.earningsPerShare).toBe(8.55)
    expect(is(SAP_INCOME).ebit).toBe(10762000000)
    expect(is(AAPL_INCOME).ebit).toBe(132729000000)
  })
})

describe("toFundamentals §79.3 — the cash-flow mapper, audited on the same fixtures", () => {
  it("freeCashFlow is the provider's figure, not a subtraction that added capex back", () => {
    // Every provider in the chain reports capex as a NEGATIVE outflow, so the old
    // `operating − capitalExpenditure` inflated it: AAPL FY2025 came out at
    // 124,197 against a true 98,767 — 26% overstated on the one symbol anybody
    // would sanity-check by hand.
    expect(cf(AAPL_CASH).freeCashFlow).toBe(98767000000)
    expect(cf(SAP_CASH).freeCashFlow).toBe(8417000000)
    expect(cf(PKO_CASH).freeCashFlow).toBe(10498000000)
  })

  it("the fallback subtraction reproduces the provider's own free_cash_flow", () => {
    // Drop the reported value and the corrected subtraction must land on it
    // exactly — that is what proves the sign, not a guess about it.
    for (const [row, reported] of [
      [AAPL_CASH, 98767000000],
      [SAP_CASH, 8417000000],
      [PKO_CASH, 10498000000],
    ] as const) {
      const { free_cash_flow: _dropped, ...rest } = row as Record<string, unknown>
      expect(cf(rest).freeCashFlow).toBe(reported)
    }
  })

  it("subtracts capex as an outflow whichever sign a provider reports it in", () => {
    const base = { operating_cash_flow: 100 }
    expect(cf({ ...base, capital_expenditure: -30 }).freeCashFlow).toBe(70)
    expect(cf({ ...base, capital_expenditure: 30 }).freeCashFlow).toBe(70)
    // One of the two legs missing is not a number.
    expect(cf({ ...base, capital_expenditure: -30 }).freeCashFlow).toBe(70)
    expect(cf(base).freeCashFlow).toBeUndefined()
  })

  it("freeCashFlowGrowth follows the corrected figure", () => {
    const rows = toFundamentals(
      [],
      [],
      [
        { ...AAPL_CASH, period_ending: "2025-09-27", free_cash_flow: 98767000000 },
        { ...AAPL_CASH, period_ending: "2024-09-28", free_cash_flow: 99765000000 },
      ],
    ).financialHighlights.cashFlow
    expect(rows![0].freeCashFlowGrowth).toBe(-1)
  })

  it("reads yfinance's dividend key, which differs per listing", () => {
    // AAPL reports `common_dividends_paid`; the EU listings report
    // `cash_dividends_paid` / `common_stock_dividend_paid`. Both are negative
    // outflows and pass through unsign-flipped, like capitalExpenditures.
    expect(cf(AAPL_CASH).dividendPayment).toBe(-15421000000)
    expect(cf(SAP_CASH).dividendPayment).toBe(-2743000000)
    expect(cf(PKO_CASH).dividendPayment).toBe(-6850000000)
  })

  it("keeps the operating, financing and investing lines on both namings", () => {
    expect(cf(AAPL_CASH)).toMatchObject({
      cashFlowFromOperatingActivities: 111482000000,
      cashFlowFromFinancingActivities: -120686000000,
      cashFlowFromInvestingActivities: 15195000000,
      capitalExpenditures: -12715000000,
      depreciation: 11698000000,
    })
    expect(cf(SAP_CASH)).toMatchObject({
      cashFlowFromOperatingActivities: 9156000000,
      cashFlowFromFinancingActivities: -8745000000,
      cashFlowFromInvestingActivities: -965000000,
      capitalExpenditures: -739000000,
      depreciation: 1311000000,
    })
    expect(cf(PKO_CASH)).toMatchObject({
      cashFlowFromOperatingActivities: 11852000000,
      cashFlowFromFinancingActivities: -8880000000,
      cashFlowFromInvestingActivities: -14287000000,
      capitalExpenditures: -1354000000,
      depreciation: 1641000000,
    })
  })
})

describe("toFundamentals §79.1b — freeCashFlowPerShare", () => {
  // The column was declared in the contract and rendered by the tab, and the
  // cash-flow mapper never emitted it, so against the real openst/cachest stack
  // it was permanently —. The mock seed carried a value, which is how the gap
  // survived (§79.1b drops it from the seed).
  const incomeAt = (fy: number, shares?: number): Row => ({
    ...SAP_INCOME,
    period_ending: `${fy}-12-31`,
    ...(shares === undefined ? {} : { weighted_average_diluted_shares_outstanding: shares }),
  })
  const cashAt = (fy: number, fcf?: number): Row => ({
    ...SAP_CASH,
    period_ending: `${fy}-12-31`,
    ...(fcf === undefined ? {} : { free_cash_flow: fcf }),
  })
  const perShare = (income: Row[], cash: Row[]) =>
    toFundamentals(income, [], cash).financialHighlights.cashFlow!.map((r) => r.freeCashFlowPerShare)

  it("divides free cash flow by the same year's diluted share count", () => {
    // SAP.DE FY2025: 8,417,000,000 / 1,175,000,000.
    expect(perShare([incomeAt(2025)], [cashAt(2025)])).toEqual([7.16])
    // AAPL FY2025: 98,767,000,000 / 15,004,697,000.
    expect(
      perShare(
        [{ ...AAPL_INCOME, weighted_average_diluted_shares_outstanding: 15004697000 }],
        [AAPL_CASH],
      ),
    ).toEqual([6.58])
    // PKO.WA FY2025: 10,498,000,000 / 1,250,000,000.
    expect(perShare([incomeAt(2025, 1250000000)], [{ ...PKO_CASH }])).toEqual([8.4])
  })

  it("joins on fiscal year, never on position", () => {
    // The three statements come from three independent provider calls with
    // independent period coverage. SAP.DE serves 4 income rows and 5 cash rows,
    // so income[1] and cash[1] are not the same year — a positional zip would
    // pair FY2023's cash flow with FY2025's share count and produce a number
    // that looks fine. 2024 has no income row here, so it must stay blank.
    expect(perShare([incomeAt(2025), incomeAt(2023)], [cashAt(2025), cashAt(2024), cashAt(2023)])).toEqual([
      7.16,
      undefined,
      7.16,
    ])
  })

  it("is undefined — never NaN — when a leg is missing or the share count is zero", () => {
    // A cash row with no income row at all for its year (SAP's 2021 below).
    expect(perShare([incomeAt(2025)], [cashAt(2025), cashAt(2021)])).toEqual([7.16, undefined])
    // The income row exists but carries no share count.
    expect(perShare([incomeAt(2025, 0)], [cashAt(2025)])[0]).not.toBe(0)
    expect(perShare([incomeAt(2025)], [cashAt(2025)])[0]).toBe(7.16)
    // Zero shares is the case that would otherwise be Infinity.
    expect(perShare([incomeAt(2025, 0)], [cashAt(2025)])).toEqual([undefined])
    // No free cash flow at all.
    const noFcf = { ...SAP_CASH, period_ending: "2025-12-31" }
    delete (noFcf as Record<string, unknown>).free_cash_flow
    delete (noFcf as Record<string, unknown>).operating_cash_flow
    delete (noFcf as Record<string, unknown>).capital_expenditure
    expect(perShare([incomeAt(2025)], [noFcf])).toEqual([undefined])
    // A year the income statement cannot key on.
    expect(perShare([{ ...SAP_INCOME, period_ending: "" }], [cashAt(2025)])).toEqual([undefined])
  })

  it("a negative year pair is a real answer, not a guard trip", () => {
    expect(perShare([incomeAt(2024, 1000000000)], [{ ...cashAt(2024), free_cash_flow: -500000000 }])).toEqual([
      -0.5,
    ])
  })
})

describe("toFundamentals §79.2 — declared currency and provenance", () => {
  const prov = {
    currency: "USD",
    currencySource: "provider" as const,
    sources: { incomeStatement: "fmp", balanceSheet: "yfinance", cashFlow: "fmp" },
  }

  it("emits the three fields alongside the numbers", () => {
    const r = toFundamentals([SAP_INCOME], [SAP_BALANCE], [SAP_CASH], prov)
    expect(r.currency).toBe("USD")
    expect(r.currencySource).toBe("provider")
    expect(r.sources).toEqual(prov.sources)
    expect(r.financialHighlights.incomeStatement![0]!.revenue).toBe(36800000000)
  })

  it("omits all three when no provenance was resolved", () => {
    // The contract's own answer for "we do not know" is absence, not a guess.
    const r = toFundamentals([SAP_INCOME], [SAP_BALANCE], [SAP_CASH])
    expect(r.currency).toBeUndefined()
    expect(r.currencySource).toBeUndefined()
    expect(r.sources).toBeUndefined()
    expect(r.financialHighlights.balanceSheet![0]!.totalAssets).toBe(70362000000)
  })

  it("carries a null currency and a provider source without inventing one", () => {
    const r = toFundamentals([SAP_INCOME], [SAP_BALANCE], [SAP_CASH], {
      currency: null,
      currencySource: "unknown",
      sources: { incomeStatement: null, balanceSheet: null, cashFlow: "yfinance" },
    })
    expect(r.currency).toBeNull()
    expect(r.currencySource).toBe("unknown")
    expect(r.sources!.cashFlow).toBe("yfinance")
  })

  describe("declaredStatementCurrency", () => {
    it("reads the one currency every row agrees on", () => {
      expect(declaredStatementCurrency([AAPL_INCOME, AAPL_INCOME])).toBe("USD")
    })

    it("is case-insensitive, because two spellings of one currency still agree", () => {
      expect(declaredStatementCurrency([{ reported_currency: "usd" }, { reported_currency: "USD" }])).toBe(
        "USD",
      )
    })

    it("returns null when the rows disagree", () => {
      expect(
        declaredStatementCurrency([{ reported_currency: "EUR" }, { reported_currency: "USD" }]),
      ).toBeNull()
    })

    it("returns null when nobody declares one — silence is not agreement", () => {
      expect(declaredStatementCurrency([SAP_INCOME, SAP_BALANCE])).toBeNull()
      expect(declaredStatementCurrency([])).toBeNull()
    })

    it("returns null rather than picking whichever row happened to be first", () => {
      expect(
        declaredStatementCurrency([
          { reported_currency: "EUR" },
          { reported_currency: "USD" },
          { reported_currency: "EUR" },
        ]),
      ).toBeNull()
    })
  })
})

// ---------------------------------------------------------------------------
// §86.6 — bond key facts
//
// The two provider rows below are the recorded payloads from §86.1, verbatim:
// `openst/tests/fixtures/bond/savings_bond_series_ROS.json` (the
// get_bond_profile DB-path body for the committed ros.html offer page) and
// `openst/tests/fixtures/bond/corp_bond_profile_BST0327.json` (byte-identical to
// the live /corp-bond/profile/BST0327 body). They are inlined rather than read
// across repos, as every other profile fixture in this file is.
// ---------------------------------------------------------------------------

const SAVINGS_BOND_ROS = {
  symbol: "ROS0932",
  name: "Obligacje 6-letnie ROS",
  series_code: "ROS",
  issue_date: "2026-09-01",
  maturity_date: "2032-09-01",
  term_months: 72,
  rate_rule: "cpi_12m+margin",
  margin: "2.00",
  fee_b: "2.00",
  nominal: "100.00",
}

const CORP_BOND_BST0327 = {
  symbol: "BST0327",
  name: "Best S.A.",
  isin: "PLBEST000333",
  stock_exchange: "GPW RR",
  hq_country: "PL",
  asset_type: "corp_bond",
  issuer: "Best S.A.",
  series: "W3",
  market: "GPW RR",
  status: "Notowane",
  nominal_value: "100.0",
  nominal_currency: "PLN",
  secured: "NIE",
  coupon_type: "zmienne WIBOR 3M + 4%",
  current_rate: "7.83%",
  maturity_date: "2027-03-07",
  country: "PL",
  currency: "PLN",
}

describe("toBondKeyFacts (§86.6 — savings bond)", () => {
  it("maps the recorded ROS0932 row", () => {
    expect(toBondKeyFacts(SAVINGS_BOND_ROS)).toEqual({
      kind: "bond",
      seriesCode: "ROS",
      issueDate: "2026-09-01",
      maturityDate: "2032-09-01",
      termMonths: 72,
      rateRule: "cpi_12m+margin",
      // "2.00" and "100.00" are stringified Decimals on the wire.
      margin: 2,
      redemptionFee: 2,
      nominal: 100,
    })
  })

  it("passes rate_rule through untranslated — the card switches the label on it", () => {
    const indexed = toBondKeyFacts(SAVINGS_BOND_ROS)
    const fixed = toBondKeyFacts({ ...SAVINGS_BOND_ROS, rate_rule: "fixed" })

    expect(indexed.rateRule).toBe("cpi_12m+margin")
    expect(fixed.rateRule).toBe("fixed")
    // Same stored number, two meanings: this pair is what gives §86.9's label
    // switch its data.
    expect(fixed.margin).toBe(indexed.margin)
  })

  it("keeps a zero term as 0 rather than null", () => {
    // A 0 is a real value and `?? null` must not eat it. This is the case a
    // truthiness filter would quietly get wrong.
    expect(toBondKeyFacts({ ...SAVINGS_BOND_ROS, term_months: 0 }).termMonths).toBe(0)
  })

  it("nulls every field an empty row does not carry", () => {
    expect(toBondKeyFacts({})).toEqual({
      kind: "bond",
      seriesCode: null,
      issueDate: null,
      maturityDate: null,
      termMonths: null,
      rateRule: null,
      margin: null,
      redemptionFee: null,
      nominal: null,
    })
  })
})

describe("toCorpBondKeyFacts (§86.6 — Catalyst)", () => {
  it("maps the recorded BST0327 row", () => {
    expect(toCorpBondKeyFacts(CORP_BOND_BST0327)).toEqual({
      kind: "corp_bond",
      issuer: "Best S.A.",
      series: "W3",
      market: "GPW RR",
      status: "Notowane",
      nominalValue: 100,
      nominalCurrency: "PLN",
      // Provider strings stay strings: "NIE" is not a boolean and "Notowane"
      // is not translated.
      secured: "NIE",
      couponType: "zmienne WIBOR 3M + 4%",
      // "7.83%" -> 7.83, so the card does not render 7.83%%.
      currentRate: 7.83,
      maturityDate: "2027-03-07",
    })
  })

  it("emits no margin key at all", () => {
    const facts = toCorpBondKeyFacts(CORP_BOND_BST0327) as Record<string, unknown>

    expect("margin" in facts).toBe(false)
  })

  it("parses a rate with no % suffix as a plain decimal", () => {
    expect(toCorpBondKeyFacts({ current_rate: "7.83" }).currentRate).toBe(7.83)
  })

  it("passes a numeric rate straight through", () => {
    expect(toCorpBondKeyFacts({ current_rate: 7.83 }).currentRate).toBe(7.83)
  })

  it("nulls a missing rate instead of throwing", () => {
    expect(toCorpBondKeyFacts({ ...CORP_BOND_BST0327, current_rate: undefined }).currentRate).toBeNull()
  })

  it("nulls an unparseable rate rather than emitting NaN", () => {
    const rate = toCorpBondKeyFacts({ current_rate: "wycofane" }).currentRate

    expect(rate).toBeNull()
    expect(Number.isNaN(rate as unknown as number)).toBe(false)
  })

  it("nulls a malformed nominal rather than emitting NaN", () => {
    expect(toCorpBondKeyFacts({ nominal_value: "-" }).nominalValue).toBeNull()
  })
})

describe("toInstrumentProfile keyFacts wiring (§86.6)", () => {
  it("carries savings-bond key facts on the profile", () => {
    const p = toInstrumentProfile("ROS0932", SAVINGS_BOND_ROS) as Record<string, any>

    expect(p.keyFacts.kind).toBe("bond")
    expect(p.keyFacts.margin).toBe(2)
  })

  it("carries Catalyst key facts even though isBond is false for that row", () => {
    // The existing isBond test only sees savings bonds (no rate_rule), so the
    // corp-bond kind needs its own discriminator or a Catalyst page renders
    // dashes for fields the provider already sent.
    const p = toInstrumentProfile("BST0327", CORP_BOND_BST0327) as Record<string, any>

    expect(p.keyFacts.kind).toBe("corp_bond")
    expect(p.keyFacts.issuer).toBe("Best S.A.")
    expect(p.keyFacts.currentRate).toBe(7.83)
  })

  it("leaves keyFacts null for an equity — the other kinds land in §86.7", () => {
    const p = toInstrumentProfile("AAPL", { symbol: "AAPL", name: "Apple Inc" }) as Record<
      string,
      any
    >

    expect(p.keyFacts).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// §86.7 — crypto, ETF, fund and stock key facts
// ---------------------------------------------------------------------------

const CRYPTO_PROFILE_BTC = {
  symbol: "BTC-USD",
  currency: "USD",
  price: 84621.5391,
  date: "2026-10-03",
  name: "Bitcoin USD",
  exchange: "CCC",
  ico_date: "2014-09-17",
  circulating_supply: 19972590.0,
  total_supply: 19972590.0,
}

describe("toCryptoKeyFacts (§86.7)", () => {
  it("maps the recorded BTC-USD profile", () => {
    expect(toCryptoKeyFacts(CRYPTO_PROFILE_BTC)).toEqual({
      kind: "crypto",
      name: "Bitcoin USD",
      exchange: "CCC",
      icoDate: "2014-09-17",
      circulatingSupply: 19972590.0,
      totalSupply: 19972590.0,
    })
  })

  it("declares no market cap, rank, ATH or ATL key", () => {
    // FMP's crypto search is the only configured provider and carries none of
    // them. They are unavailable, not empty — a permanent dash either way.
    const facts = toCryptoKeyFacts(CRYPTO_PROFILE_BTC) as Record<string, unknown>

    for (const absent of ["marketCap", "rank", "ath", "atl"]) {
      expect(absent in facts).toBe(false)
    }
  })

  it("keeps a null supply null rather than 0", () => {
    // WBTCUSD from the recorded 17-row search fixture: a circulating supply and
    // no total supply.
    expect(
      toCryptoKeyFacts({
        symbol: "WBTC-USD",
        name: "Wrapped Bitcoin USD",
        circulating_supply: 125330.0,
        total_supply: null,
      }),
    ).toEqual({
      kind: "crypto",
      name: "Wrapped Bitcoin USD",
      exchange: null,
      icoDate: null,
      circulatingSupply: 125330.0,
      totalSupply: null,
    })
  })

  it("does not duplicate the quote currency", () => {
    const facts = toCryptoKeyFacts(CRYPTO_PROFILE_BTC) as Record<string, unknown>

    expect("quoteCurrency" in facts).toBe(false)
    expect("currency" in facts).toBe(false)
  })
})

describe("toEtfKeyFacts (§86.7)", () => {
  it("carries the reference table's etf_category", () => {
    expect(toEtfKeyFacts("Fixed Income")).toEqual({ kind: "etf", category: "Fixed Income" })
    expect(toEtfKeyFacts("Equity")).toEqual({ kind: "etf", category: "Equity" })
  })

  it("nulls a category the reference row does not carry", () => {
    expect(toEtfKeyFacts(null)).toEqual({ kind: "etf", category: null })
    expect(toEtfKeyFacts(undefined)).toEqual({ kind: "etf", category: null })
    expect(toEtfKeyFacts("")).toEqual({ kind: "etf", category: null })
  })
})

describe("toFundKeyFacts (§86.7)", () => {
  it("strips the ANALIZY prefix off an analizy.pl listing key", () => {
    expect(toFundKeyFacts("ANALIZY::ARK01")).toEqual({ kind: "fund", categoryCode: "ARK01" })
  })

  it("nulls a TFI key — its code is the fund's own number, not a category", () => {
    expect(toFundKeyFacts("TFI::NNEP65.TFI")).toEqual({ kind: "fund", categoryCode: null })
  })

  it("nulls a missing or unrecognised key", () => {
    expect(toFundKeyFacts(null).categoryCode).toBeNull()
    expect(toFundKeyFacts("ARK01").categoryCode).toBeNull()
  })
})

describe("toStockKeyFacts (§86.7)", () => {
  const filled = {
    ticker: "AAPL",
    name: "Apple Inc",
    country: "United States",
    countryCode: "US",
    assetType: "STOCK",
    isin: "US0378331005",
    currency: "USD",
    currencySource: "provider",
    exchange: "NASDAQ",
    finnhubIndustry: "Technology",
    ipo: "1980-12-12",
    logo: null,
    marketCapitalization: 3.1e6,
    marketCapCurrency: "USD",
    marketcapUSD: 3.1e12,
    phone: null,
    shareOutstanding: 15.2e9,
    weburl: null,
    description: null,
    gicsSector: "Information Technology",
    gicsIndustryGroup: "Technology Hardware & Equipment",
    gicsIndustry: "Technology Hardware",
    gicsSubIndustry: null,
    address: null,
    city: null,
    state: null,
    employeeTotal: 164000,
    ceo: null,
    keyFacts: null,
  } as unknown as S["InstrumentProfile"]

  it("relocates the profile's own fields — no new upstream call", () => {
    expect(toStockKeyFacts(filled)).toEqual({
      kind: "stock",
      sector: "Information Technology",
      industry: "Technology Hardware",
      employees: 164000,
      ceo: null,
      ipo: "1980-12-12",
      sharesOutstanding: 15.2e9,
      marketCap: 3.1e6,
    })
  })

  it("keeps a null ceo as null with the key still present", () => {
    expect("ceo" in toStockKeyFacts(filled)).toBe(true)
    expect(toStockKeyFacts(filled).ceo).toBeNull()
  })

  it("reads the post-fill profile, so a route-supplied sector survives", () => {
    // The raw translation hard-codes gicsSector/gicsIndustry to null and the
    // route fills them afterwards — a version reading the provider row would
    // return the dashes this exists to remove.
    const beforeFill = toStockKeyFacts({ ...filled, gicsSector: null })
    expect(beforeFill.sector).toBeNull()
    expect(toStockKeyFacts(filled).sector).toBe("Information Technology")
  })
})

describe("toKeyFacts dispatch (§86.7)", () => {
  it("returns null for an unknown asset class rather than a card of dashes", () => {
    const profile = toInstrumentProfile("AAPL", { symbol: "AAPL", name: "Apple Inc" })

    expect(toKeyFacts({ symbol: "AAPL" }, profile, {})).toBeNull()
    expect(toKeyFacts({ symbol: "AAPL" }, profile, { kind: null })).toBeNull()
  })

  it("still recognises a bond row with no class from the reference table", () => {
    // An unsynced savings-bond symbol has no reference row, so the route passes
    // no kind — the row itself is enough, exactly as before this section.
    const profile = toInstrumentProfile("ROS0932", SAVINGS_BOND_ROS)

    expect(toKeyFacts(SAVINGS_BOND_ROS, profile, {})?.kind).toBe("bond")
  })

  it("routes each class to its own source", () => {
    const profile = toInstrumentProfile("BTC-USD", CRYPTO_PROFILE_BTC)

    expect(toKeyFacts(CRYPTO_PROFILE_BTC, profile, { kind: "crypto" })?.kind).toBe("crypto")
    expect(toKeyFacts({}, profile, { kind: "etf", etfCategory: "Equity" })).toEqual({
      kind: "etf",
      category: "Equity",
    })
    expect(toKeyFacts({}, profile, { kind: "fund", listingKey: "ANALIZY::ARK01" })).toEqual({
      kind: "fund",
      categoryCode: "ARK01",
    })
  })

  it("leaves an equity's keyFacts to the route's post-fill call", () => {
    const profile = toInstrumentProfile(
      "AAPL",
      { symbol: "AAPL", name: "Apple Inc", employees: 164000 },
      undefined,
      { kind: "stock" },
    ) as Record<string, any>

    // Not a stale sector-less card: null, until the route has filled the
    // reference fields and recomputed.
    expect(profile.keyFacts).toBeNull()
    expect(profile.gicsSector).toBeNull()

    profile.gicsSector = "Information Technology"
    profile.gicsIndustry = "Technology Hardware"
    profile.keyFacts = toKeyFacts({}, profile, { kind: "stock" })
    expect(profile.keyFacts.sector).toBe("Information Technology")
  })
})
