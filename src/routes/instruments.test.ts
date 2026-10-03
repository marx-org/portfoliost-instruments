import { describe, it, expect, vi, beforeEach } from "vitest"
import { Hono } from "hono"
import { createInstrumentsRoutes } from "./instruments.js"
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
  fetchCorpBondProfile: vi.fn(),
  fetchCryptoProfile: vi.fn(),
  fetchBondOhlcv: vi.fn(),
  fetchDividendHistory: vi.fn(),
  fetchFilings: vi.fn(),
  fetchMda: vi.fn(),
  fetchInsiderTrading: vi.fn(),
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

/** §79.2 — the statement envelope openst now answers with. */
function statement(provider: string | null, rows: Array<Record<string, unknown>>) {
  return { provider, rows }
}

beforeEach(() => {
  mocked.fetchProfile.mockReset()
  mocked.fetchQuote.mockReset()
  mocked.fetchFixedincomeQuote.mockReset()
  mocked.fetchCryptoQuote.mockReset()
  mocked.fetchMetrics.mockReset()
  mocked.fetchProjections.mockReset()
  mocked.fetchOhlcv.mockReset()
  mocked.fetchSearch.mockReset()
  mocked.fetchCryptoSearch.mockReset()
  mocked.fetchBondSearch.mockReset()
  mocked.fetchBondProfile.mockReset()
  mocked.fetchCorpBondProfile.mockReset()
  mocked.fetchCryptoProfile.mockReset()
  mocked.fetchBondOhlcv.mockReset()
  mocked.fetchDividendHistory.mockReset()
  mocked.fetchFilings.mockReset()
  mocked.fetchMda.mockReset()
  mocked.fetchInsiderTrading.mockReset()
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

  it("merges crypto rows as CRYPTO type, leading ahead of equity", async () => {
    mocked.fetchSearch.mockResolvedValue([{ symbol: "BTCS", name: "BTCS Inc" }])
    mocked.fetchCryptoSearch.mockResolvedValue([{ symbol: "BTCUSD", name: "Bitcoin USD" }])
    const res = await req("/api/instruments/search?q=btc")
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.results[0]).toMatchObject({ symbol: "BTC-USD", type: "CRYPTO", source: "CRYPTO" })
    expect(body.results[1]).toMatchObject({ symbol: "BTCS", type: "STOCK" })
  })

  it("surfaces curated BTC-USD suggestion when crypto search degrades upstream", async () => {
    mocked.fetchSearch.mockResolvedValue([{ symbol: "BTCS", name: "BTCS Inc" }])
    mocked.fetchCryptoSearch.mockRejectedValue(new cachest.UpstreamError("crypto", 404))
    const res = await req("/api/instruments/search?q=btc")
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ symbol: "BTC-USD", type: "CRYPTO", source: "CRYPTO" }),
        expect.objectContaining({ symbol: "BTCS", type: "STOCK" }),
      ]),
    )
  })

  it("surfaces bond rows as BOND type, additive with equity", async () => {
    mocked.fetchSearch.mockResolvedValue([{ symbol: "ROD", name: "Rodny Company" }])
    mocked.fetchBondSearch.mockResolvedValue([
      { symbol: "ROD0938", name: "Obligacje Rodzinne 4-letnie ROD", maturity_date: "2030-09-01" },
    ])
    const res = await req("/api/instruments/search?q=rod")
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ symbol: "ROD0938", type: "BOND", source: "OBLIGACJE", exchange: "PL" }),
      ]),
    )
  })

  it("serves bond results instead of 404 when the equity tier has no match", async () => {
    mocked.fetchSearch.mockRejectedValue(new cachest.UpstreamError("equity", 404))
    mocked.fetchBondSearch.mockResolvedValue([{ symbol: "EDO0936", name: "Obligacje 10-letnie EDO" }])
    const res = await req("/api/instruments/search?q=edo")
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.results[0]).toMatchObject({ symbol: "EDO0936", type: "BOND", source: "OBLIGACJE" })
  })

  it("normalizes a venue suffix off bond queries (ROD1033.WA ≡ ROD1033)", async () => {
    mocked.fetchSearch.mockRejectedValue(new cachest.UpstreamError("equity", 404))
    mocked.fetchBondSearch.mockResolvedValue([{ symbol: "ROD1033", name: "Obligacje 12-letnie ROD" }])
    const res = await req("/api/instruments/search?q=rod1033.wa")
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ symbol: "ROD1033", type: "BOND", source: "OBLIGACJE" }),
      ]),
    )
    expect(mocked.fetchBondSearch).toHaveBeenCalledWith("rod1033")
  })

  it("passes bare bond queries through untouched", async () => {
    mocked.fetchBondSearch.mockResolvedValue([{ symbol: "ROD1033", name: "Obligacje 12-letnie ROD" }])
    const res = await req("/api/instruments/search?q=rod1033")
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.results[0]).toMatchObject({ symbol: "ROD1033", type: "BOND", source: "OBLIGACJE" })
    expect(mocked.fetchBondSearch).toHaveBeenCalledWith("rod1033")
  })
})

describe("GET /api/instruments/:symbol (detail)", () => {
  it("falls back to the bond profile when the equity profile 404s", async () => {
    mocked.fetchProfile.mockRejectedValue(new cachest.UpstreamError("equity", 404))
    mocked.fetchBondProfile.mockResolvedValue({
      symbol: "ROD0938",
      name: "Obligacje 12-letnie ROD",
      maturity_date: "2038-09-01",
    })
    const res = await req("/api/instruments/ROD0938")
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ symbol: "ROD0938", name: "Obligacje 12-letnie ROD" })
  })

  it("falls back to the bond profile when the equity profile times out (502/504)", async () => {
    mocked.fetchProfile.mockRejectedValue(new cachest.UpstreamError("equity", 502))
    mocked.fetchBondProfile.mockResolvedValue({
      symbol: "ROD0129",
      name: "Obligacje 12-letnie ROD",
      maturity_date: "2029-01-01",
    })
    const res = await req("/api/instruments/ROD0129")
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ symbol: "ROD0129", name: "Obligacje 12-letnie ROD" })
    expect(mocked.fetchBondProfile).toHaveBeenCalledWith("ROD0129")
  })

  it("returns 404 when neither equity nor bond profile resolves", async () => {
    mocked.fetchProfile.mockRejectedValue(new cachest.UpstreamError("equity", 404))
    mocked.fetchBondProfile.mockRejectedValue(new cachest.UpstreamError("bond", 404))
    const res = await req("/api/instruments/NOPE")
    expect(res.status).toBe(404)
    expect((await res.json()).error).toBe("NotFound")
  })
})

describe("GET /api/instruments/:symbol — savings-bond direct routes (plan §37.2)", () => {
  const BOND_PROFILE = { symbol: "ROD1035", name: "Obligacje 12-letnie ROD", maturity_date: "2035-10-01" }

  it("detail: straight to the bond profile, never the equity probe", async () => {
    mocked.fetchBondProfile.mockResolvedValue(BOND_PROFILE)
    const res = await req("/api/instruments/ROD1035")
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ symbol: "ROD1035", name: "Obligacje 12-letnie ROD" })
    expect(mocked.fetchProfile).not.toHaveBeenCalled()
    expect(mocked.fetchBondProfile).toHaveBeenCalledWith("ROD1035")
  })

  it("profile: straight to the bond profile, never the equity probe", async () => {
    mocked.fetchBondProfile.mockResolvedValue(BOND_PROFILE)
    const res = await req("/api/instruments/ROD1035/profile")
    expect(res.status).toBe(200)
    expect((await res.json()).name).toBe("Obligacje 12-letnie ROD")
    expect(mocked.fetchProfile).not.toHaveBeenCalled()
    expect(mocked.fetchBondProfile).toHaveBeenCalledWith("ROD1035")
  })

  it("profile: bond profile failure maps to the upstream error, no equity retry", async () => {
    mocked.fetchBondProfile.mockRejectedValue(new cachest.UpstreamError("bond", 404))
    const res = await req("/api/instruments/ROD1035/profile")
    expect(res.status).toBe(404)
    expect(mocked.fetchProfile).not.toHaveBeenCalled()
  })

  it("metrics: 404 without any upstream call", async () => {
    const res = await req("/api/instruments/ROD1035/metrics")
    expect(res.status).toBe(404)
    expect((await res.json()).error).toBe("NotFound")
    expect(mocked.fetchMetrics).not.toHaveBeenCalled()
    expect(mocked.fetchProjections).not.toHaveBeenCalled()
  })

  it("overview-metrics: 404 without any upstream call", async () => {
    const res = await req("/api/instruments/ROD1035/overview-metrics")
    expect(res.status).toBe(404)
    expect(mocked.fetchMetrics).not.toHaveBeenCalled()
    expect(mocked.fetchProfile).not.toHaveBeenCalled()
  })

  it("fundamentals: 404 without any upstream call", async () => {
    const res = await req("/api/instruments/ROD1035/fundamentals")
    expect(res.status).toBe(404)
    expect((await res.json()).error).toBe("NotFound")
    expect(mocked.fetchFundamentals).not.toHaveBeenCalled()
  })

  it("calendar: empty entries without probing the equity tier", async () => {
    const res = await req("/api/instruments/ROD1035/calendar")
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.earnings).toEqual([])
    expect(body.exDividend).toEqual([])
    expect(mocked.fetchCalendarEarnings).not.toHaveBeenCalled()
    expect(mocked.fetchCalendarDividends).not.toHaveBeenCalled()
    expect(mocked.fetchProfile).not.toHaveBeenCalled()
  })

  it("history: straight to the bond OHLCV, never the equity OHLCV", async () => {
    mocked.fetchBondOhlcv.mockResolvedValue([{
      index: "2026-09-18",
      close: 102.4,
      open: 102.4,
      high: 102.4,
      low: 102.4,
      volume: 0,
    }])
    const res = await req("/api/instruments/ROD1035/history")
    expect(res.status).toBe(200)
    expect(mocked.fetchOhlcv).not.toHaveBeenCalled()
    expect(mocked.fetchBondOhlcv).toHaveBeenCalled()
  })

  it("history: bond OHLCV failure surfaces as the upstream error, no equity retry", async () => {
    mocked.fetchBondOhlcv.mockRejectedValue(new cachest.UpstreamError("bond", 404))
    const res = await req("/api/instruments/ROD1035/history")
    expect(res.status).toBe(404)
    expect(mocked.fetchOhlcv).not.toHaveBeenCalled()
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

  it("falls back to the bond profile when the equity profile fails (404/502/504)", async () => {
    mocked.fetchProfile.mockRejectedValue(new cachest.UpstreamError("x", 404))
    mocked.fetchBondProfile.mockResolvedValue({
      symbol: "ROD0129",
      name: "Obligacje 12-letnie ROD",
      maturity_date: "2029-01-01",
    })
    const res = await req("/api/instruments/ROD0129/profile")
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ticker).toBe("ROD0129")
    expect(body.name).toBe("Obligacje 12-letnie ROD")
    expect(mocked.fetchBondProfile).toHaveBeenCalledWith("ROD0129")
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

describe("GET /api/instruments/:symbol/quote — asset-class dispatch (34)", () => {
  async function dbWithTickers(csv: string) {
    const { createTestDb } = await import("../db/test-db.js")
    const { syncTickerReference } = await import("../scripts/tickerref-sync.js")
    const t = await createTestDb()
    dbState.db = t.db
    await syncTickerReference(csv, t.db)
    return t
  }

  it("routes bond symbols to the fixedincome quote", async () => {
    const t = await dbWithTickers(
      `listing_key,ticker,exchange,name,asset_type,stock_sector,etf_category,country,country_code,isin,aliases
 WSE::ROD1033,ROD1033,WSE,ROD 1033,BOND,,,,PL,,`,
    )
    mocked.fetchFixedincomeQuote.mockResolvedValue({
      symbol: "ROD1033",
      last_price: 151.99,
      prev_close: 151.97,
      change: 0.02,
      change_percent: 0.0001,
      currency: "PLN",
    })
    try {
      const res = await req("/api/instruments/ROD1033/quote")
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.currentPrice).toBe(151.99)
      expect(body.currency).toBe("PLN")
      expect(mocked.fetchFixedincomeQuote).toHaveBeenCalledWith("ROD1033")
      expect(mocked.fetchQuote).not.toHaveBeenCalled()
      expect(mocked.fetchCryptoQuote).not.toHaveBeenCalled()
    } finally {
      await t.client.close()
      dbState.db = null
    }
  })

  it("routes crypto to the crypto quote, normalizing a bare ticker to the -USD pair", async () => {
    const t = await dbWithTickers(
      `listing_key,ticker,exchange,name,asset_type,stock_sector,etf_category,country,country_code,isin,aliases
 BINANCE::BTC,BTC,BINANCE,Bitcoin,CRYPTO,,,,US,,`,
    )
    mocked.fetchCryptoQuote.mockResolvedValue({
      symbol: "BTC-USD",
      price: 80986.82,
      open: 80877.27,
      high: 81886.15,
      low: 80837.04,
      volume: 20948,
      date: "2026-09-19",
      change: 85.36,
      change_percent: 0.0011,
    })
    try {
      const res = await req("/api/instruments/BTC/quote")
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(mocked.fetchCryptoQuote).toHaveBeenCalledWith("BTC-USD")
      expect(mocked.fetchQuote).not.toHaveBeenCalled()
      expect(mocked.fetchFixedincomeQuote).not.toHaveBeenCalled()
      expect(body.symbol).toBe("BTC-USD")
      expect(body.currentPrice).toBe(80986.82)
      expect(body.percentChange).toBeCloseTo(0.11, 4)
      expect(body.currency).toBe("USD")
    } finally {
      await t.client.close()
      dbState.db = null
    }
  })

  it("keeps pair-form crypto symbols as-is", async () => {
    const t = await dbWithTickers(
      `listing_key,ticker,exchange,name,asset_type,stock_sector,etf_category,country,country_code,isin,aliases
 BINANCE::BTC,BTC,BINANCE,Bitcoin,CRYPTO,,,,US,,`,
    )
    mocked.fetchCryptoQuote.mockResolvedValue({ symbol: "BTC-USD", price: 80000, date: "2026-09-19" })
    try {
      const res = await req("/api/instruments/BTC-USD/quote")
      expect(res.status).toBe(200)
      expect(mocked.fetchCryptoQuote).toHaveBeenCalledWith("BTC-USD")
      expect((await res.json()).currentPrice).toBe(80000)
    } finally {
      await t.client.close()
      dbState.db = null
    }
  })

  it("keeps corp_bond on the equity quote (34.1: biznesradar serves it)", async () => {
    const t = await dbWithTickers(
      `listing_key,ticker,exchange,name,asset_type,stock_sector,etf_category,country,country_code,isin,aliases
 WSE::BST0327,BST0327,WSE,Best S.A.,corp_bond,,,,PL,,`,
    )
    mocked.fetchQuote.mockResolvedValue({
      symbol: "BST0327",
      last_price: 100.52,
      open: 100.52,
      high: 100.52,
      low: 100.52,
      currency: "PLN",
    })
    try {
      const res = await req("/api/instruments/BST0327/quote")
      expect(res.status).toBe(200)
      expect(mocked.fetchQuote).toHaveBeenCalledWith("BST0327")
      expect(mocked.fetchFixedincomeQuote).not.toHaveBeenCalled()
      expect(mocked.fetchCryptoQuote).not.toHaveBeenCalled()
      expect((await res.json()).currentPrice).toBe(100.52)
    } finally {
      await t.client.close()
      dbState.db = null
    }
  })

  it("keeps funds on the equity quote with the venue-qualified symbol", async () => {
    const t = await dbWithTickers(
      `listing_key,ticker,exchange,name,asset_type,stock_sector,etf_category,country,country_code,isin,aliases
 GPW::NNEP25,NNEP25,GPW,ING Emerytura 2025,fund,,,,PL,,`,
    )
    mocked.fetchQuote.mockResolvedValue({
      symbol: "NNEP25.TFI",
      last_price: 14.7,
      prev_close: 14.61,
      change: 0.09,
      change_percent: 0.0062,
      currency: "PLN",
    })
    try {
      const res = await req("/api/instruments/NNEP25.TFI/quote")
      expect(res.status).toBe(200)
      expect(mocked.fetchQuote).toHaveBeenCalledWith("NNEP25.TFI")
      expect((await res.json()).currentPrice).toBe(14.7)
    } finally {
      await t.client.close()
      dbState.db = null
    }
  })

  it("falls back to the equity quote for unlisted symbols (regression)", async () => {
    const t = await dbWithTickers(
      `listing_key,ticker,exchange,name,asset_type,stock_sector,etf_category,country,country_code,isin,aliases
 WSE::ROD1033,ROD1033,WSE,ROD 1033,BOND,,,,PL,,`,
    )
    mocked.fetchQuote.mockResolvedValue({ symbol: "AAPL", last_price: 300, currency: "USD" })
    try {
      const res = await req("/api/instruments/AAPL/quote")
      expect(res.status).toBe(200)
      expect(mocked.fetchQuote).toHaveBeenCalledWith("AAPL")
      expect(mocked.fetchFixedincomeQuote).not.toHaveBeenCalled()
    } finally {
      await t.client.close()
      dbState.db = null
    }
  })

  it("serves the bond computed close on the /price route", async () => {
    const t = await dbWithTickers(
      `listing_key,ticker,exchange,name,asset_type,stock_sector,etf_category,country,country_code,isin,aliases
 WSE::ROD1033,ROD1033,WSE,ROD 1033,BOND,,,,PL,,`,
    )
    mocked.fetchFixedincomeQuote.mockResolvedValue({
      symbol: "ROD1033",
      last_price: 151.99,
      currency: "PLN",
    })
    try {
      const res = await req("/api/instruments/ROD1033/price")
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({
        symbol: "ROD1033",
        price: 151.99,
        currency: "PLN",
        baseCurrency: "PLN",
        fxFrom: null,
      })
      expect(mocked.fetchFixedincomeQuote).toHaveBeenCalledWith("ROD1033")
      expect(mocked.fetchQuote).not.toHaveBeenCalled()
    } finally {
      await t.client.close()
      dbState.db = null
    }
  })

  it("falls back to the fixedincome quote for unlisted savings bonds (prod has no bond rows)", async () => {
    const t = await dbWithTickers(
      `listing_key,ticker,exchange,name,asset_type,stock_sector,etf_category,country,country_code,isin,aliases
 NASDAQ::AAPL,AAPL,NASDAQ,Apple Inc,Stock,Information Technology,,United States,US,US0378331005,apple`,
    )
    mocked.fetchQuote.mockRejectedValue(
      new (await import("../adapters/cachest.js")).UpstreamError("http://cachest:8080/equity/quote/ROD1033", 404),
    )
    mocked.fetchFixedincomeQuote.mockResolvedValue({ symbol: "ROD1033", last_price: 151.99, currency: "PLN" })
    try {
      const res = await req("/api/instruments/ROD1033/quote")
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.currentPrice).toBe(151.99)
      expect(body.currency).toBe("PLN")
      expect(mocked.fetchFixedincomeQuote).toHaveBeenCalledWith("ROD1033")
    } finally {
      await t.client.close()
      dbState.db = null
    }
  })

  it("does not apply the savings-bond fallback to other 404 symbols", async () => {
    mocked.fetchQuote.mockRejectedValue(
      new (await import("../adapters/cachest.js")).UpstreamError("http://cachest:8080/equity/quote/NOPE", 404),
    )
    const res = await req("/api/instruments/NOPE/quote")
    expect(res.status).toBe(404)
    expect(mocked.fetchFixedincomeQuote).not.toHaveBeenCalled()
  })

  it("lets the curated crypto row win over colliding stock/ETF listings", async () => {
    const t = await dbWithTickers(
      `listing_key,ticker,exchange,name,asset_type,stock_sector,etf_category,country,country_code,isin,aliases
 ASX::BTC,BTC,ASX,Bitcoin Futures,Stock,,Financials,,AU,,
 Euronext::BTC,BTC,Euronext,Bitcoin ETF,ETF,,Cryptocurrency,,FR,,
 CRYPTO::BTC,BTC,CRYPTO,BTC-USD,crypto,,,,US,btc|btc-usd`,
    )
    mocked.fetchCryptoQuote.mockResolvedValue({ symbol: "BTC-USD", price: 80000, date: "2026-09-19" })
    try {
      const res = await req("/api/instruments/BTC/quote")
      expect(res.status).toBe(200)
      expect(mocked.fetchCryptoQuote).toHaveBeenCalledWith("BTC-USD")
      expect(mocked.fetchQuote).not.toHaveBeenCalled()
      expect((await res.json()).currentPrice).toBe(80000)
    } finally {
      await t.client.close()
      dbState.db = null
    }
  })

  it("keeps hyphenated corp-bond tickers on the equity quote (no pair mangling)", async () => {
    const t = await dbWithTickers(
      `listing_key,ticker,exchange,name,asset_type,stock_sector,etf_category,country,country_code,isin,aliases
 WSE::BOS0735-K,BOS0735-K,WSE,BOS0735-K,corp_bond,,,,PL,,`,
    )
    mocked.fetchQuote.mockResolvedValue({ symbol: "BOS0735-K", last_price: 99.1, currency: "PLN" })
    try {
      const res = await req("/api/instruments/BOS0735-K/quote")
      expect(res.status).toBe(200)
      expect(mocked.fetchQuote).toHaveBeenCalledWith("BOS0735-K")
      expect(mocked.fetchCryptoQuote).not.toHaveBeenCalled()
      expect(mocked.fetchFixedincomeQuote).not.toHaveBeenCalled()
    } finally {
      await t.client.close()
      dbState.db = null
    }
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

  it("falls back to bond OHLCV when the equity history leg fails (404/502/504)", async () => {
    mocked.fetchOhlcv.mockRejectedValue(new cachest.UpstreamError("x", 404))
    mocked.fetchBondOhlcv.mockResolvedValue([
      { date: "2026-08-18", open: 180.26, high: 180.3, low: 180.26, close: 180.3, volume: 0 },
      { date: "2026-08-19", open: 180.3, high: 180.33, low: 180.3, close: 180.33, volume: 0 },
    ])
    const res = await req("/api/instruments/ROD0129/history?resolution=daily")
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.symbol).toBe("ROD0129")
    expect(body.closePrices).toEqual([180.3, 180.33])
    expect(mocked.fetchBondOhlcv).toHaveBeenCalledWith("ROD0129", expect.any(String), expect.any(String))
  })

  it("surfaces upstream 404 when neither equity nor bond OHLCV leg has the symbol", async () => {
    mocked.fetchOhlcv.mockRejectedValue(new cachest.UpstreamError("x", 404))
    mocked.fetchBondOhlcv.mockRejectedValue(new cachest.UpstreamError("y", 404))
    const res = await req("/api/instruments/NOPE/history?resolution=daily")
    expect(res.status).toBe(404)
    expect((await res.json()).error).toBe("NotFound")
  })

  describe("local read-through fallback (plan §48.4a)", () => {
    const TICKERS_CSV = `listing_key,ticker,exchange,name,asset_type,stock_sector,etf_category,country,country_code,isin,aliases
 WSE::SNT.WA,SNT.WA,WSE,Synektik Sa,Stock,,Health Care,,PL,,
 US::SPY,SPY,US,SPDR S&P 500 ETF,ETF,Index Fund,,,US,,`

    /** PGlite with the local price_bars stand-ins + stooq bars seeded. */
    async function dbWithLocalBars(
      bars: Array<[string, string, string, number]>, // [table, ticker, date, close]
    ) {
      const { createTestDb } = await import("../db/test-db.js")
      const { syncTickerReference } = await import("../scripts/tickerref-sync.js")
      const { LOCAL_PRICE_BARS_SETUP_SQL } = await import("../db/price-bars.js")
      const { sql } = await import("drizzle-orm")
      const t = await createTestDb()
      dbState.db = t.db
      await syncTickerReference(TICKERS_CSV, t.db)
      for (const stmt of LOCAL_PRICE_BARS_SETUP_SQL) {
        await t.db.execute(sql.raw(stmt))
      }
      for (const [table, ticker, date, close] of bars) {
        await t.db.execute(
          sql.raw(`INSERT INTO instruments.${table} (ticker, period, date, close) VALUES ('${ticker}', 'd', '${date}', ${close});`),
        )
      }
      return t
    }

    function mockProviderBurst() {
      mocked.fetchOhlcv.mockRejectedValue(new cachest.UpstreamError("x", 502))
      mocked.fetchBondOhlcv.mockRejectedValue(new cachest.UpstreamError("y", 404))
    }

    it("serves local price_bars when the provider leg 502s", async () => {
      const t = await dbWithLocalBars([
        ["stooq_daily_pl", "SNT.WA", "2026-08-18", 98.5],
        ["stooq_daily_pl", "SNT.WA", "2026-08-19", 99.2],
      ])
      mockProviderBurst()
      try {
        const res = await req("/api/instruments/SNT.WA/history?resolution=daily")
        expect(res.status).toBe(200)
        const body = await res.json()
        expect(body.closePrices).toEqual([98.5, 99.2])
        expect(body.baseCurrency).toBe("PLN")
        expect(body.currency).toBe("PLN")
        expect(body.timestamps).toHaveLength(2)
      } finally {
        await t.client.close()
        dbState.db = null
      }
    })

    it("serves local price_bars when the provider leg returns an empty series", async () => {
      const t = await dbWithLocalBars([
        ["stooq_daily_pl", "SNT.WA", "2026-08-18", 98.5],
      ])
      mocked.fetchOhlcv.mockResolvedValue([])
      try {
        const res = await req("/api/instruments/SNT.WA/history?resolution=daily")
        expect(res.status).toBe(200)
        expect((await res.json()).closePrices).toEqual([98.5])
      } finally {
        await t.client.close()
        dbState.db = null
      }
    })

    it("keeps upstream errors when there is no local data either", async () => {
      const t = await dbWithLocalBars([])
      mockProviderBurst()
      try {
        const res = await req("/api/instruments/SNT.WA/history?resolution=daily")
        expect(res.status).toBe(502)
        expect((await res.json()).error).toBe("BadGateway")
      } finally {
        await t.client.close()
        dbState.db = null
      }
    })

    it("serves the benchmark overlay from local price_bars (no provider bench call)", async () => {
      const t = await dbWithLocalBars([
        ["stooq_daily_pl", "SNT.WA", "2026-08-18", 98.5],
        ["stooq_daily_pl", "SNT.WA", "2026-08-19", 99.2],
        ["stooq_daily_us", "SPY.US", "2026-08-18", 601.2],
        ["stooq_daily_us", "SPY.US", "2026-08-19", 604.8],
      ])
      mockProviderBurst()
      try {
        const res = await req("/api/instruments/SNT.WA/history?resolution=daily&compare=spy")
        expect(res.status).toBe(200)
        const body = await res.json()
        expect(body.compare.name).toBe("S&P 500 (SPY)")
        expect(body.compare.closePrices).toEqual([601.2, 604.8])
        expect(body.compare.currency).toBe("USD")
        // exactly one provider call: the (failed) main leg — never the benchmark
        expect(mocked.fetchOhlcv).toHaveBeenCalledTimes(1)
      } finally {
        await t.client.close()
        dbState.db = null
      }
    })
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
  mocked.fetchFixedincomeQuote.mockReset()
  mocked.fetchCryptoQuote.mockReset()
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
        .mockResolvedValueOnce(statement("fmp", [
          { fiscal_year: 2024, period_ending: "2024-09-28 00:00:00", revenue: 100, net_income: 20, diluted_earnings_per_share: 1.2, ebit: 30, ebitda: 35, reported_currency: "USD" },
          { fiscal_year: 2023, period_ending: "2023-09-30 00:00:00", revenue: 90, net_income: 10, diluted_earnings_per_share: 1.0, reported_currency: "USD" },
        ]))
        .mockResolvedValueOnce(statement("fmp", [
          { fiscal_year: 2024, total_assets: 500, total_liabilities: 300, shareholders_equity: 200, total_debt: 100, total_current_assets: 150, total_current_liabilities: 100, reported_currency: "USD" },
        ]))
        .mockResolvedValueOnce(statement("yfinance", [
          { fiscal_year: 2024, operating_cash_flow: 80, capital_expenditure: 20, depreciation_and_amortization: 10, reported_currency: "USD" },
        ]))

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

    // --- §79.2 provenance ------------------------------------------------
    //
    // The three statements are three independent provider walks. Before this,
    // a table could answer with income from one provider and a balance sheet
    // from another, in different currencies, with no record of either — and the
    // tab rendered every value with no currency symbol, so a GPW name in PLN and
    // a US name in USD looked identical.
    const threeStatements = (
      providers: [string | null, string | null, string | null],
      currencies: Array<string | null> = ["USD", "USD", "USD"],
    ) => {
      const rows = (i: number) =>
        [{ period_ending: "2024-12-31", reported_currency: currencies[i] }]
      mocked.fetchFundamentals
        .mockResolvedValueOnce(statement(providers[0], rows(0)))
        .mockResolvedValueOnce(statement(providers[1], rows(1)))
        .mockResolvedValueOnce(statement(providers[2], rows(2)))
    }

    it("records the provider that answered each statement", async () => {
      threeStatements(["fmp", "yfinance", "fmp"])
      const body = await (await req("/api/instruments/AAPL/fundamentals")).json()
      expect(body.sources).toEqual({
        incomeStatement: "fmp",
        balanceSheet: "yfinance",
        cashFlow: "fmp",
      })
    })

    it("reports the provider currency only when all three statements agree", async () => {
      threeStatements(["fmp", "fmp", "fmp"], ["USD", "USD", "USD"])
      const body = await (await req("/api/instruments/AAPL/fundamentals")).json()
      // AAPL resolves locally to USD too, but the declaration is what put it
      // there, so the source is the provider.
      expect(body.currency).toBe("USD")
      expect(body.currencySource).toBe("provider")
    })

    it("a currency disagreement is never reported as provider-sourced", async () => {
      // Income in EUR, balance sheet in USD: there is no single currency for
      // this table, and claiming one would be the defect this fixes. With no DB
      // in this harness the local resolver has nothing to answer with, so the
      // result is `unknown` — the point is that it is NOT `provider`.
      threeStatements(["fmp", "yfinance", "fmp"], ["EUR", "USD", "EUR"])
      const body = await (await req("/api/instruments/AAPL/fundamentals")).json()
      expect(body.currencySource).not.toBe("provider")
      expect(body.currencySource).toBe("unknown")
      expect(body.currency).toBeNull()
    })

    it("an undeclared currency is not read as a disagreement", async () => {
      // The yfinance passthrough carries no `reported_currency` at all — true of
      // every EU listing measured. Silence is not disagreement, so the
      // declaration is simply absent and the local resolver gets to answer; with
      // no DB here it answers `unknown` rather than inventing one.
      threeStatements(["yfinance", "yfinance", "yfinance"], [null, null, null])
      const body = await (await req("/api/instruments/AAPL/fundamentals")).json()
      expect(body.currencySource).toBe("unknown")
      expect(body.currency).toBeNull()
      // The provenance still stands on its own — a missing currency must not
      // cost the record of which provider answered.
      expect(body.sources).toEqual({
        incomeStatement: "yfinance",
        balanceSheet: "yfinance",
        cashFlow: "yfinance",
      })
    })

    it("a body cached before the envelope reports no provider rather than failing", async () => {
      // openst caches 24h in Redis and cachest for another 24h, so for up to a
      // day after the openst deploy the statements can still arrive with a null
      // provider. The numbers must survive that; only the attribution is lost.
      threeStatements([null, null, null], ["USD", "USD", "USD"])
      const res = await req("/api/instruments/AAPL/fundamentals")
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.sources).toEqual({
        incomeStatement: null,
        balanceSheet: null,
        cashFlow: null,
      })
      expect(body.currency).toBe("USD")
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

    it("requests a window reaching into the future, keeping the past ≤ 30d (fmp free-tier lookback, upcoming entries)", async () => {
      mocked.fetchCalendarEarnings.mockResolvedValue([])
      mocked.fetchCalendarDividends.mockResolvedValue([])
      await req("/api/instruments/AAPL/calendar")
      const [start, end] = mocked.fetchCalendarDividends.mock.calls[0] as [string, string]
      // The window is produced by `todayRange`, which formats with
      // `toISOString().slice(0, 10)` — i.e. UTC dates. This test used to compare
      // them against `setHours(0,0,0,0)`, which is LOCAL midnight: 22 h apart in
      // Warsaw, so the assertion could only ever pass in UTC or west of it.
      // Compare on the same basis the product uses.
      const todayUtc = new Date().toISOString().slice(0, 10)
      expect(end >= todayUtc).toBe(true)
      expect(start >= new Date(Date.now() - 30 * 86400_000).toISOString().slice(0, 10)).toBe(true)
    })

    it("resolves the calendar currency via the §49.6 single resolver, not the profile (§47 parity)", async () => {
      const { createTestDb } = await import("../db/test-db.js")
      const { syncTickerReference } = await import("../scripts/tickerref-sync.js")
      const t = await createTestDb()
      dbState.db = t.db
      await syncTickerReference(
        `listing_key,ticker,exchange,name,asset_type,stock_sector,etf_category,country,country_code,isin,aliases
 WSE::SNT,SNT,WSE,Synektik Sa,Stock,,,,PL,,`,
        t.db,
      )
      await t.db.execute((await import("drizzle-orm")).sql`INSERT INTO instruments.exchange_reference (exchange_code, canonical_name, yahoo_suffix) VALUES ('WSE', 'Warsaw Stock Exchange', 'WA') ON CONFLICT DO NOTHING`)
      try {
        // The provider profile (had the route used it) would say USD — the
        // resolver must win: SNT.WA → PLN via the WSE/country mapping.
        mocked.fetchProfile.mockResolvedValue({ currency: "USD" })
        mocked.fetchCalendarEarnings.mockResolvedValue([])
        mocked.fetchCalendarDividends.mockResolvedValue([
          { symbol: "SNT.WA", ex_dividend_date: "2026-09-01", amount: 0.26 },
        ])
        const res = await req("/api/instruments/SNT.WA/calendar")
        expect(res.status).toBe(200)
        const body = await res.json()
        expect(body.currency).toBe("PLN")
        expect(mocked.fetchProfile).not.toHaveBeenCalled()
      } finally {
        await t.client.close()
        dbState.db = null
      }
    })
  })

  describe("GET /:symbol/dividends", () => {
    it("maps openst dividend rows into stoxly history shape with currency + currencySource", async () => {
      mocked.fetchDividendHistory.mockResolvedValue([
        { date: "2026-05-12", amount: "0.2600", currency: "USD", payment_date: "2026-05-15" },
        { date: "2026-02-09", amount: "0.2500", currency: "USD" },
      ])
      const res = await req("/api/instruments/AAPL/dividends")
      expect(res.status).toBe(200)
      const body = await res.json()
      // §49.9 — paymentDate rides through when the provider carries it
      expect(body.history[0]).toEqual({ date: "2026-05-12", year: 2026, amount: 0.26, currency: "USD", type: "regular", paymentDate: "2026-05-15" })
      expect(body.history[1].paymentDate).toBeNull()
      // §49.6 — provider-declared → provider; currency always set
      expect(body.currency).toBe("USD")
      expect(body.currencySource).toBe("provider")
    })

    it("resolves the instrument trading currency for rows without one (§36)", async () => {
      const { createTestDb } = await import("../db/test-db.js")
      const { syncTickerReference } = await import("../scripts/tickerref-sync.js")
      const t = await createTestDb()
      dbState.db = t.db
      await syncTickerReference(
        `listing_key,ticker,exchange,name,asset_type,stock_sector,etf_category,country,country_code,isin,aliases
 WSE::SNT,SNT,WSE,Synektik Sa,Stock,,,,PL,,`,
        t.db,
      )
      // Suffix→exchange mapping so SNT.WA scopes to WSE
      await t.db.execute((await import("drizzle-orm")).sql`INSERT INTO instruments.exchange_reference (exchange_code, canonical_name, yahoo_suffix) VALUES ('WSE', 'Warsaw Stock Exchange', 'WA') ON CONFLICT DO NOTHING`)
      try {
        mocked.fetchDividendHistory.mockResolvedValue([
          { date: "2026-04-15", amount: "1.20" },
          { date: "2025-12-15", amount: "1.10", currency: "PLN" },
        ])
        const res = await req("/api/instruments/SNT.WA/dividends")
        expect(res.status).toBe(200)
        const body = await res.json()
        // row without currency → instrument currency (PL via tickerref)
        expect(body.history[0]).toMatchObject({ date: "2026-04-15", amount: 1.2, currency: "PLN" })
        // row with its own currency keeps it
        expect(body.history[1]).toMatchObject({ date: "2025-12-15", currency: "PLN" })
        // §49.6 — provider-declared (row) against a matching local resolution → provider
        expect(body.currency).toBe("PLN")
        expect(body.currencySource).toBe("provider")
      } finally {
        await t.client.close()
        dbState.db = null
      }
    })

    it("marks a locally resolved currency 'estimated' when the provider is silent", async () => {
      const { createTestDb } = await import("../db/test-db.js")
      const { syncTickerReference } = await import("../scripts/tickerref-sync.js")
      const t = await createTestDb()
      dbState.db = t.db
      await syncTickerReference(
        `listing_key,ticker,exchange,name,asset_type,stock_sector,etf_category,country,country_code,isin,aliases
 WSE::PKN,PKN,WSE,Orlen,Stock,,,,PL,,`,
        t.db,
      )
      await t.db.execute((await import("drizzle-orm")).sql`INSERT INTO instruments.exchange_reference (exchange_code, canonical_name, yahoo_suffix) VALUES ('WSE', 'Warsaw Stock Exchange', 'WA') ON CONFLICT DO NOTHING`)
      try {
        mocked.fetchDividendHistory.mockResolvedValue([
          { date: "2026-04-15", amount: "1.20" },
        ])
        const res = await req("/api/instruments/PKN.WA/dividends")
        expect(res.status).toBe(200)
        const body = await res.json()
        expect(body.history[0]).toMatchObject({ currency: "PLN" })
        expect(body.currency).toBe("PLN")
        expect(body.currencySource).toBe("estimated")
      } finally {
        await t.client.close()
        dbState.db = null
      }
    })

    it("falls back to USD with 'unknown' source when nothing declares or resolves (§49.6, currency never null)", async () => {
      mocked.fetchDividendHistory.mockResolvedValue([
        { date: "2026-04-15", amount: "1.20" },
      ])
      const res = await req("/api/instruments/UNKNOWNXYZ/dividends")
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.history[0]).toMatchObject({ currency: "USD" })
      expect(body.currency).toBe("USD")
      expect(body.currencySource).toBe("unknown")
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
      mocked.fetchMetrics.mockResolvedValue({ market_cap: 4514709504000, pe_ratio: 35.47, dividend_yield: 0.44, fcf_margin: 28.54, shares_outstanding: 2515201893 })
      const res = await req("/api/instruments/AAPL/compare")
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.symbol).toBe("AAPL")
      expect(body.price).toBe(309.35)
      expect(body.peRatio).toBe(35.47)
      expect(body.marketCap).toBe(4514709504000)
      expect(body.fcfMargin).toBe(28.54)
      expect(body.sharesOutstanding).toBe(2515201893)
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

describe("pt2b routes", () => {
  describe("GET /:symbol/seasonality", () => {
    const monthRow = (date: string, close: number) => ({ date, open: 1, high: 1, low: 1, close, volume: 1 })

    it("computes average monthly returns from monthly last closes", async () => {
      mocked.fetchOhlcv.mockResolvedValue([
        monthRow("2025-01-31", 100),
        monthRow("2025-02-28", 110), // Feb +10%
        monthRow("2026-01-30", 100),
        monthRow("2026-02-27", 90), // Feb -10%
      ])
      const res = await req("/api/instruments/AAPL/seasonality?years=5")
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.symbol).toBe("AAPL")
      expect(body.years).toBe(5)
      const feb = body.monthly_returns.find((m: any) => m.month === "Feb")
      expect(feb.return_pct).toBe(0) // avg(+10, -10)
      const jan = body.monthly_returns.find((m: any) => m.month === "Jan")
      expect(jan.return_pct).toBeCloseTo(-9.09, 1) // Feb'25 110 → Jan'26 100
    })

    it("supports median/min/max metrics and defaults years to 5", async () => {
      mocked.fetchOhlcv.mockResolvedValue([
        monthRow("2025-01-31", 100),
        monthRow("2025-02-10", 80),
        monthRow("2025-02-28", 120),
        monthRow("2026-01-30", 100),
        monthRow("2026-02-10", 60),
        monthRow("2026-02-28", 140),
      ])
      const med = await req("/api/instruments/AAPL/seasonality?metric=median")
      const febMed = (await med.json()).monthly_returns.find((m: any) => m.month === "Feb")
      // monthly closes are last-of-month: Feb'25 120 (+20%), Feb'26 140 (+40%) → median 30
      expect(febMed.return_pct).toBeCloseTo(30, 1)
      const mx = await req("/api/instruments/AAPL/seasonality?metric=max")
      const febMax = (await mx.json()).monthly_returns.find((m: any) => m.month === "Feb")
      expect(febMax.return_pct).toBeCloseTo(40, 1)
    })
  })

  describe("GET /:symbol/eps-surprises", () => {
    it("derives rows with YoY-baseline estimates", async () => {
      mocked.fetchFundamentals.mockResolvedValue(statement("fmp", [
        { period_ending: "2024-03-31 00:00:00", diluted_earnings_per_share: 1.0, revenue: 900 },
        { period_ending: "2025-03-31 00:00:00", diluted_earnings_per_share: 1.2, revenue: 1000 },
        { period_ending: "2025-06-30 00:00:00", diluted_earnings_per_share: 1.3, revenue: 1050 },
      ]))
      const res = await req("/api/instruments/AAPL/eps-surprises")
      expect(res.status).toBe(200)
      const body = await res.json()
      const q1 = body.quarterly.find((r: any) => r.date === "2025-03-31")
      expect(q1.eps).toBe(1.2)
      expect(q1.epsEstimate).toBe(1.0)
      expect(q1.surprisePercent).toBeCloseTo(20)
      expect(q1.revenueDifference).toBeCloseTo(11.11, 1)
      expect(body.quarterly.length).toBeLessThanOrEqual(8)
    })

    it("honors the quarters parameter", async () => {
      mocked.fetchFundamentals.mockResolvedValue(
        statement("fmp", Array.from({ length: 12 }, (_, i) => ({
          period_ending: `20${25 + Math.floor(i / 4)}-0${(i % 4) * 3 + 1}-15 00:00:00`,
          diluted_earnings_per_share: 1,
          revenue: 100,
        }))),
      )
      const res = await req("/api/instruments/AAPL/eps-surprises?quarters=12")
      expect((await res.json()).quarterly).toHaveLength(12)
    })
  })

  describe("GET /:symbol/investor-relations", () => {
    it("lists earnings-call events per reported quarter", async () => {
      mocked.fetchFundamentals.mockResolvedValue(statement("fmp", [
        { period_ending: "2026-03-31 00:00:00" },
        { period_ending: "2025-12-31 00:00:00" },
      ]))
      mocked.fetchFilings.mockResolvedValue([])
      const res = await req("/api/instruments/AAPL/investor-relations")
      expect(res.status).toBe(200)
      const events = await res.json()
      expect(events[0]).toMatchObject({
        type: "transcript",
        symbol: "AAPL",
        id: "AAPL_2026-03-31",
        year: 2026,
        quarter: 1,
        audioUrl: null,
      })
    })

    it("blends SEC filing events with earnings-call events", async () => {
      mocked.fetchFundamentals.mockResolvedValue(statement("fmp", [{ period_ending: "2026-06-30 00:00:00" }]))
      mocked.fetchFilings.mockResolvedValue([
        {
          symbol: "AAPL",
          form_type: "10-K",
          filing_date: "2025-11-03",
          report_url: "https://www.sec.gov/Archives/edgar/data/320193/000032019325000132/aapl-20250928.htm",
          accession_number: "0000320193-25-000132",
        },
        {
          symbol: "AAPL",
          form_type: "8-K",
          filing_date: "2026-07-30",
          report_url: "https://www.sec.gov/Archives/edgar/data/320193/000032019326000045/aapl-20260730.htm",
          accession_number: "0000320193-26-000045",
        },
        {
          symbol: "AAPL",
          form_type: "4",
          filing_date: "2026-09-03",
          report_url: "https://www.sec.gov/Archives/edgar/data/320193/000114036126035636/form4.xml",
          accession_number: "0001140361-26-035636",
        },
      ])
      const res = await req("/api/instruments/AAPL/investor-relations")
      expect(res.status).toBe(200)
      const events = await res.json()
      const secEvents = events.filter((e: any) => e.type === "press-release")
      expect(secEvents).toHaveLength(2)
      expect(secEvents.every((e: any) => e.formType !== "4")).toBe(true)
      expect(secEvents[0]).toMatchObject({
        type: "press-release",
        symbol: "AAPL",
        formType: "8-K",
        year: 2026,
        reportUrl: expect.stringContaining("aapl-20260730.htm"),
      })
      expect(secEvents[1]).toMatchObject({ formType: "10-K", year: 2025 })
    })

    it("falls back to quarters-only when filings are missing", async () => {
      mocked.fetchFundamentals.mockResolvedValue(
        statement("fmp", [{ period_ending: "2026-03-31 00:00:00" }]),
      )
      mocked.fetchFilings.mockRejectedValue(new Error("404"))
      const res = await req("/api/instruments/AAPL/investor-relations")
      expect(res.status).toBe(200)
      const events = await res.json()
      expect(events).toHaveLength(1)
      expect(events[0].type).toBe("transcript")
    })

    it("returns MD&A text body for a transcript event", async () => {
      mocked.fetchMda.mockResolvedValue({
        symbol: "AAPL",
        calendar_year: 2025,
        calendar_period: 4,
        period_ending: "2025-09-27",
        content: "This is the management discussion and analysis narrative for Apple.",
        url: "https://www.sec.gov/Archives/edgar/data/320193/000032019325000132/aapl-20250928.htm",
      })
      const res = await req("/api/instruments/AAPL/investor-relations/AAPL_10-K_0000320193-25-000132/transcript")
      expect(res.status).toBe(200)
      const t = await res.json()
      expect(t).toMatchObject({
        id: "AAPL_10-K_0000320193-25-000132",
        symbol: "AAPL",
        year: 2025,
        quarter: 4,
        body: "This is the management discussion and analysis narrative for Apple.",
      })
    })

    it("returns a structured empty transcript when MD&A is unavailable", async () => {
      mocked.fetchMda.mockRejectedValue(new Error("404"))
      const res = await req("/api/instruments/AAPL/investor-relations/AAPL_2026-03-31/transcript")
      expect(res.status).toBe(200)
      expect(await res.json()).toMatchObject({
        id: "AAPL_2026-03-31",
        symbol: "AAPL",
        year: 2026,
        quarter: 1,
        participant: [],
        transcript: [],
        body: null,
      })
    })
  })

  describe("GET /:symbol/peers", () => {
    it("composes compare rows for same-sector candidates", async () => {
      mocked.fetchProfile.mockImplementation(async (s: string) =>
        s.startsWith("AAPL") || ["MSFT", "GOOGL"].includes(s)
          ? { symbol: s, name: `${s} Inc.`, sector: "Technology" }
          : { symbol: s, name: `${s} Corp.`, sector: "Financials" },
      )
      mocked.fetchQuote.mockResolvedValue({ last_price: 100 })
      mocked.fetchMetrics.mockResolvedValue({ market_cap: 1e9, pe_ratio: 10 })
      const res = await req("/api/instruments/AAPL/peers")
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.symbol).toBe("AAPL")
      expect(body.items[0].symbol).toBe("AAPL")
      const peerSymbols = body.items.slice(1).map((r: any) => r.symbol)
      expect(peerSymbols).toEqual(expect.arrayContaining(["MSFT", "GOOGL"]))
      expect(peerSymbols).toHaveLength(2)
    })

    it("still returns self row when no same-sector candidate exists", async () => {
      mocked.fetchProfile.mockImplementation(async (s: string) => {
        if (s === "ZZZ") return { symbol: "ZZZ", name: "Oddity", sector: "Space" }
        throw new cachest.UpstreamError("p", 404)
      })
      mocked.fetchQuote.mockRejectedValue(new cachest.UpstreamError("q", 404))
      mocked.fetchMetrics.mockRejectedValue(new cachest.UpstreamError("m", 404))
      const res = await req("/api/instruments/ZZZ/peers")
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.items).toHaveLength(1)
      expect(body.items[0].symbol).toBe("ZZZ")
    })
  })
})

describe("GET /:symbol/ownership", () => {
  it("translates SEC Form 4 insider rows into insiderTransactions", async () => {
    mocked.fetchInsiderTrading.mockResolvedValue([
      {
        symbol: "AAPL",
        company_cik: "0000320193",
        filing_date: "2026-09-03",
        transaction_date: "2026-09-01",
        owner_name: "Newstead Jennifer",
        owner_title: "SVP, GC and Government Affairs",
        acquisition_or_disposition: "Disposition",
        transaction_type: "Open market or private sale",
        security_type: "Common Stock",
        securities_transacted: 1439.0,
        transaction_price: 317.01,
      },
    ])
    const res = await req("/api/instruments/AAPL/ownership")
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.symbol).toBe("AAPL")
    expect(body.insiderTransactions).toHaveLength(1)
    expect(body.insiderTransactions[0]).toMatchObject({
      title: "Newstead Jennifer",
      transactionDate: "2026-09-01",
      transactionText: "Open market or private sale",
      transactionAmount: 1439,
      transactionValue: 456177.39,
      filingDate: "2026-09-03",
    })
    expect(body.institutional).toEqual([])
    expect(body.mutualFund).toEqual([])
    expect(body.insider).toEqual([])
  })

  it("sorts transactions newest-first and drops rows without a date", async () => {
    mocked.fetchInsiderTrading.mockResolvedValue([
      {
        symbol: "AAPL",
        filing_date: "2026-08-01",
        transaction_date: "2026-08-01",
        owner_name: "Older Insider",
        securities_transacted: 100,
        transaction_price: 300,
      },
      {
        symbol: "AAPL",
        filing_date: "2026-09-10",
        transaction_date: "2026-09-10",
        owner_name: "Newer Insider",
        securities_transacted: 200,
        transaction_price: 310,
      },
      { symbol: "AAPL", owner_name: "No Date" },
    ])
    const res = await req("/api/instruments/AAPL/ownership")
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.insiderTransactions.map((t: any) => t.transactionDate)).toEqual(["2026-09-10", "2026-08-01"])
    expect(mocked.fetchInsiderTrading).toHaveBeenCalledWith("AAPL")
  })

  it("returns empty ownership content when upstream has no data", async () => {
    mocked.fetchInsiderTrading.mockResolvedValue([])
    const res = await req("/api/instruments/AAPL/ownership")
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      symbol: "AAPL",
      institutional: [],
      mutualFund: [],
      insider: [],
      insiderTransactions: [],
    })
  })

  it("propagates an upstream failure", async () => {
    mocked.fetchInsiderTrading.mockRejectedValue(new cachest.UpstreamError("o", 502))
    const res = await req("/api/instruments/AAPL/ownership")
    expect(res.status).toBe(502)
  })
})

describe("GET /:symbol/history compare", () => {
  it("returns benchmark series aligned to the symbol's timestamps", async () => {
    const day = (date: string, close: number) => ({ date, open: 1, high: 1, low: 1, close, volume: 1 })
    const symbolTs = [1755475200, 1755561600] // 2025-08-18, 2025-08-19 (UTC)
    const dateOf = (ts: number) => new Date(ts * 1000).toISOString().slice(0, 10)
    mocked.fetchOhlcv.mockImplementation(async (sym: string) => {
      if (sym === "SPY") {
        return [day(dateOf(symbolTs[0]), 640), day("2025-08-17", 638), day(dateOf(symbolTs[1]), 645)]
      }
      return [day(dateOf(symbolTs[0]), 100), day(dateOf(symbolTs[1]), 102)]
    })
    const res = await req("/api/instruments/AAPL/history?resolution=daily&compare=spy")
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.compare.name).toBe("S&P 500 (SPY)")
    expect(body.compare.timestamps).toEqual(symbolTs)
    expect(body.compare.closePrices).toEqual([640, 645])
  })

  it("omits compare for unknown benchmark keys", async () => {
    mocked.fetchOhlcv.mockResolvedValue([])
    const res = await req("/api/instruments/AAPL/history?resolution=daily&compare=nope")
    const body = await res.json()
    expect(body.compare).toBeUndefined()
  })
})

describe("GET /search result cap", () => {
  it("caps broad queries to a bounded result set", async () => {
    mocked.fetchSearch.mockResolvedValue(
      Array.from({ length: 6004 }, (_, i) => ({ symbol: `S${i}`, name: `Stock ${i}` })),
    )
    const res = await req("/api/instruments/search?q=p")
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.results).toHaveLength(50)
    expect(body.count).toBe(50)
  })
})

describe("GET /search — ticker reference (DB-first)", () => {
  it("serves results from the reference table when populated", async () => {
    const { createTestDb } = await import("../db/test-db.js")
    const { syncExchangeReference, syncTickerReference } = await import("../scripts/tickerref-sync.js")
    const t = await createTestDb()
    dbState.db = t.db
    await syncTickerReference(
      `listing_key,ticker,exchange,name,asset_type,stock_sector,etf_category,country,country_code,isin,aliases
WSE::PKN,PKN,WSE,"Polski Koncern Naftowy ORLEN SA",Stock,Energy,,Poland,PL,PLPKN0000018,polski koncern naftowy orlen|orlen
NASDAQ::AAPL,AAPL,NASDAQ,Apple Inc,Stock,Information Technology,,United States,US,US0378331005,apple`,
      t.db,
    )
    await syncExchangeReference(
      `venue_id,exchange_code,operating_mic,segment_mic,canonical_name,country_code,status
v1,WSE,XWAR,,Warsaw Stock Exchange,PL,active
v2,NASDAQ,XNAS,,Nasdaq,US,active`,
      '"XWAR": "WA"',
      t.db,
    )
    try {
      const res = await req("/api/instruments/search?q=pkn")
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.count).toBe(1)
      expect(body.results[0]).toMatchObject({ symbol: "PKN.WA", exchange: "WSE", type: "STOCK", countryCode: "PL" })

      // alias search hits ORLEN too
      const alias = await req("/api/instruments/search?q=orlen")
      expect(((await alias.json()).results ?? [])).toHaveLength(1)

      // US listing stays bare, carries country code
      const us = await req("/api/instruments/search?q=aapl")
      const usBody = await us.json()
      expect(usBody.results[0]).toMatchObject({ symbol: "AAPL", exchange: "NASDAQ", countryCode: "US" })
    } finally {
      await t.client.close()
      dbState.db = null
    }
  })

  it("falls back to the provider tier when the table is empty", async () => {
    mocked.fetchSearch.mockResolvedValue([{ symbol: "AAPL", name: "Apple Inc", cik: "320193" }])
    const res = await req("/api/instruments/search?q=apple")
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.results[0].symbol).toBe("AAPL")
    expect(mocked.fetchSearch).toHaveBeenCalledWith("apple")
  })
})

describe("GET /:symbol/profile — reference enrichment", () => {
  it("fills ISIN/sector/country from the reference table when provider omits them", async () => {
    const { createTestDb } = await import("../db/test-db.js")
    const { syncExchangeReference, syncTickerReference } = await import("../scripts/tickerref-sync.js")
    const t = await createTestDb()
    dbState.db = t.db
    await syncTickerReference(
      `listing_key,ticker,exchange,name,asset_type,stock_sector,etf_category,country,country_code,isin,aliases
WSE::PKN,PKN,WSE,"Polski Koncern Naftowy ORLEN SA",Stock,Energy,,Poland,PL,PLPKN0000018,orlen`,
      t.db,
    )
    mocked.fetchProfile.mockResolvedValue({ symbol: "PKN", name: "PKN Orlen" })
    try {
      const res = await req("/api/instruments/PKN/profile")
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.isin).toBe("PLPKN0000018")
      expect(body.country).toBe("Poland")
      expect(body.gicsSector).toBe("Energy")
      // provider-supplied fields win when present
      expect(body.name).toBe("PKN Orlen")
    } finally {
      await t.client.close()
      dbState.db = null
    }
  })
})

describe("GET /:symbol/profile — venue collision (SNT)", () => {
  it("enriches the venue-matched listing for suffixed route symbols", async () => {
    const { createTestDb } = await import("../db/test-db.js")
    const { syncExchangeReference, syncTickerReference } = await import("../scripts/tickerref-sync.js")
    const t = await createTestDb()
    dbState.db = t.db
    await syncTickerReference(
      `listing_key,ticker,exchange,name,asset_type,stock_sector,etf_category,country,country_code,isin,aliases
WSE::SNT,SNT,WSE,"Synektik Spolka Akcyjna",Stock,Healthcare,,Poland,PL,PLSNT0000016,synektik
NYSE::SNT,SNT,NYSE,"Senstar Technologies Corp",Stock,Technology,,Canada,CA,CA81728N1006,senstar`,
      t.db,
    )
    await syncExchangeReference(
      `venue_id,exchange_code,operating_mic,segment_mic,canonical_name,country_code,status
v1,WSE,XWAR,,Warsaw Stock Exchange,PL,active`,
      '"XWAR": "WA"',
      t.db,
    )
    // provider (Yahoo) returns the correct WSE company for SNT.WA but lacks
    // identity fields — those must come from the WSE reference row.
    mocked.fetchProfile.mockResolvedValue({ symbol: "SNT.WA", name: "Synektik Spolka Akcyjna", stock_exchange: "WSE" })
    try {
      const res = await req("/api/instruments/SNT.WA/profile")
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.isin).toBe("PLSNT0000016")
      expect(body.country).toBe("Poland")
      expect(body.countryCode).toBe("PL")
      expect(body.exchange).toBe("WSE")
      expect(body.gicsSector).toBe("Healthcare")
    } finally {
      await t.client.close()
      dbState.db = null
    }
  })
})

describe("GET /:symbol/price-bars — ?currency= (plan §48.2)", () => {
  async function dbWithFx() {
    const { sql } = await import("drizzle-orm")
    const { createTestDb } = await import("../db/test-db.js")
    const { syncTickerReference } = await import("../scripts/tickerref-sync.js")
    const { LOCAL_PRICE_BARS_SETUP_SQL } = await import("../db/price-bars.js")
    const t = await createTestDb()
    dbState.db = t.db
    for (const stmt of LOCAL_PRICE_BARS_SETUP_SQL) {
      await t.db.execute(sql.raw(stmt))
    }
    await syncTickerReference(
      `listing_key,ticker,exchange,name,asset_type,stock_sector,etf_category,country,country_code,isin,aliases
 WSE::PKN,PKN,WSE,PKN Orlen,Stock,Energy,,Poland,PL,PLPKNO0000070294,`,
      t.db,
    )
    await t.db.execute(sql.raw(`
      INSERT INTO instruments.price_bars (symbol, date, close, source) VALUES
        ('PKN', '2026-09-16', 100.00000000, 'openst'),
        ('PKN', '2026-09-17', 102.00000000, 'openst'),
        ('PKN', '2026-09-18', 101.00000000, 'openst'),
        ('PKN', '2026-09-19', 105.00000000, 'openst'),
        ('PKN', '2026-09-10', 98.00000000, 'openst');
    `))
    await t.db.execute(sql.raw(`
      INSERT INTO instruments.fx_rates (rate_date, currency, rate, source) VALUES
        ('2026-09-16', 'PLN', 4.0000000000, 'ecb'),
        ('2026-09-16', 'USD', 4.3000000000, 'ecb'),
        ('2026-09-17', 'PLN', 4.1000000000, 'ecb'),
        ('2026-09-17', 'USD', 4.2000000000, 'ecb'),
        ('2026-09-18', 'PLN', 4.2000000000, 'ecb'),
        ('2026-09-18', 'USD', 4.0000000000, 'ecb'),
        ('2026-09-19', 'PLN', 4.3000000000, 'ecb'),
        ('2026-09-19', 'USD', 4.4000000000, 'ecb');
    `))
    return t
  }

  it("same-currency request short-circuits to the plain base series", async () => {
    const t = await dbWithFx()
    try {
      const res = await req("/api/instruments/PKN/price-bars?from=2026-09-16&to=2026-09-19&currency=PLN")
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.closes).toEqual([100, 102, 101, 105])
      expect(body.currency).toBe("PLN")
      expect(body.baseCurrency).toBe("PLN")
      expect(body.fxFrom).toBeNull()
    } finally {
      await t.client.close()
      dbState.db = null
    }
  })

  it("converts closes to the target currency server-side", async () => {
    const t = await dbWithFx()
    try {
      const res = await req("/api/instruments/PKN/price-bars?from=2026-09-16&to=2026-09-19&currency=usd")
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.closes[0]).toBeCloseTo(107.5, 8)
      expect(body.closes[1]).toBeCloseTo((102 * 4.2) / 4.1, 8)
      expect(body.closes[2]).toBeCloseTo((101 * 4.0) / 4.2, 8)
      expect(body.closes[3]).toBeCloseTo((105 * 4.4) / 4.3, 8)
      expect(body.currency).toBe("USD")
      expect(body.baseCurrency).toBe("PLN")
      expect(body.fxFrom).toBe("2026-09-16")
    } finally {
      await t.client.close()
      dbState.db = null
    }
  })

  it("§72.17: omits the bar before the fx floor instead of serving it unconverted", async () => {
    // This asserted the opposite and is kept as the record of the change: the
    // response used to begin at 2026-09-10 with a raw close of 98, under a
    // declared currency of USD. The wallets valuation grid multiplied those into
    // a portfolio total, so a base-currency price reached a foreign-currency
    // total. In PROD (BTC-USD → PLN, 2022-07) that read 85 PLN on two days and
    // ~400 either side.
    const t = await dbWithFx()
    try {
      const res = await req("/api/instruments/PKN/price-bars?from=2026-09-09&to=2026-09-19&currency=USD")
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.dates).not.toContain("2026-09-10")
      expect(body.currency).toBe("USD")
      expect(body.fxFrom).toBe("2026-09-16")
      // every surviving close is a converted one, never a raw base-currency price
      expect(body.closes).not.toContain(98)
    } finally {
      await t.client.close()
      dbState.db = null
    }
  })

  /**
   * §72.10 — say what was dropped instead of making the caller infer it.
   *
   * `fxFrom` cannot carry this on its own: §72.17's holes are **scattered** as
   * well as prefixed, so the first converted date says nothing about the rest. The
   * fixture already has the prefixed case (2026-09-10, no fx_rates rows), which is
   * the one `fxFrom` happens to express — so the scattered assertion below is the
   * one that actually tests the field.
   */
  it("§72.10: reports the dates it dropped, and is absent when no conversion was asked for", async () => {
    const t = await dbWithFx()
    try {
      // A prefix hole: 2026-09-10 has a bar but no fx_rates rows.
      const res = await req("/api/instruments/PKN/price-bars?from=2026-09-09&to=2026-09-19&currency=USD")
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.unconvertedDates).toEqual(["2026-09-10"])
      // and it agrees with what was actually dropped, not just with fxFrom
      expect(body.dates).not.toContain("2026-09-10")

      // A conversion that dropped nothing: present and EMPTY, which is a
      // different fact from "no conversion applied" and must not collapse into it.
      const clean = await req("/api/instruments/PKN/price-bars?from=2026-09-16&to=2026-09-19&currency=USD")
      const cleanBody = await clean.json()
      expect(cleanBody.unconvertedDates).toEqual([])

      // No ?currency= at all: ABSENT, so a caller can tell "did not convert" from
      // "converted and lost nothing". `toBeUndefined`, not `toEqual([])`.
      const plain = await req("/api/instruments/PKN/price-bars?from=2026-09-09&to=2026-09-19")
      expect((await plain.json()).unconvertedDates).toBeUndefined()

      // Same-currency: also absent — nothing was dropped because nothing converted.
      const same = await req("/api/instruments/PKN/price-bars?from=2026-09-09&to=2026-09-19&currency=PLN")
      expect((await same.json()).unconvertedDates).toBeUndefined()
    } finally {
      await t.client.close()
      dbState.db = null
    }
  })

  it("§72.10: a SCATTERED hole is reported, which fxFrom alone cannot express", async () => {
    // The case the field exists for. fxFrom is the first converted date, so a hole
    // in the middle of the series is invisible to it — a caller would read a short
    // series as a sparse one and carry the last value forward across a gap that was
    // never priced.
    const t = await dbWithFx()
    try {
      const { sql } = await import("drizzle-orm")
      // A bar on 2026-09-17b's day with both fx legs removed for 2026-09-19 only.
      await t.db.execute(sql.raw(`
        DELETE FROM instruments.fx_rates WHERE rate_date = '2026-09-19';
      `))
      const res = await req("/api/instruments/PKN/price-bars?from=2026-09-16&to=2026-09-19&currency=USD")
      const body = await res.json()
      expect(body.unconvertedDates).toEqual(["2026-09-19"])
      // fxFrom is still the FIRST converted date, unchanged — the two fields are
      // genuinely different questions and neither subsumes the other.
      expect(body.fxFrom).toBe("2026-09-16")
      expect(body.dates).not.toContain("2026-09-19")
      expect(body.dates).toContain("2026-09-18")
    } finally {
      await t.client.close()
      dbState.db = null
    }
  })

  it("§72.17: a same-currency price-bars request is not filtered", async () => {    const t = await dbWithFx()
    try {
      const res = await req("/api/instruments/PKN/price-bars?from=2026-09-09&to=2026-09-19")
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.dates).toContain("2026-09-10")
      expect(body.closes).toContain(98)
    } finally {
      await t.client.close()
      dbState.db = null
    }
  })

  it("rejects unsupported currencies with 400", async () => {
    const t = await dbWithFx()
    try {
      const res = await req("/api/instruments/PKN/price-bars?from=2026-09-16&to=2026-09-19&currency=XXX")
      expect(res.status).toBe(400)
    } finally {
      await t.client.close()
      dbState.db = null
    }
  })

  it("rejects conversion when the base currency is unresolvable", async () => {
    const t = await dbWithFx()
    try {
      const res = await req("/api/instruments/NOPE/price-bars?from=2026-09-16&to=2026-09-19&currency=USD")
      expect(res.status).toBe(400)
      expect((await res.json()).message).toMatch(/base currency unknown/)
    } finally {
      await t.client.close()
      dbState.db = null
    }
  })
})

describe("GET /:symbol/history — ?currency= (plan §48.2)", () => {
  it("converts the provider series + keeps baseCurrency/fxFrom", async () => {
    const { sql } = await import("drizzle-orm")
    const { createTestDb } = await import("../db/test-db.js")
    const { syncTickerReference } = await import("../scripts/tickerref-sync.js")
    const t = await createTestDb()
    dbState.db = t.db
    await syncTickerReference(
      `listing_key,ticker,exchange,name,asset_type,stock_sector,etf_category,country,country_code,isin,aliases
 WSE::PKN,PKN,WSE,PKN Orlen,Stock,Energy,,Poland,PL,PLPKNO0000070294,`,
      t.db,
    )
    await t.db.execute(sql.raw(`
      INSERT INTO instruments.fx_rates (rate_date, currency, rate, source) VALUES
        ('2026-09-16', 'PLN', 4.0000000000, 'ecb'),
        ('2026-09-16', 'USD', 4.3000000000, 'ecb'),
        ('2026-09-17', 'PLN', 4.1000000000, 'ecb'),
        ('2026-09-17', 'USD', 4.2000000000, 'ecb');
    `))
    mocked.fetchOhlcv.mockResolvedValue([
      { date: "2026-09-16", open: 99, high: 101, low: 98, close: 100, volume: 10 },
      { date: "2026-09-17", open: 101, high: 103, low: 100, close: 102, volume: 12 },
    ])
    try {
      const res = await req("/api/instruments/PKN/history?resolution=daily&currency=USD")
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.closePrices[0]).toBeCloseTo((100 * 4.3) / 4.0, 8)
      expect(body.closePrices[1]).toBeCloseTo((102 * 4.2) / 4.1, 8)
      expect(body.highPrices[0]).toBeCloseTo((101 * 4.3) / 4.0, 8)
      expect(body.currency).toBe("USD")
      expect(body.baseCurrency).toBe("PLN")
      expect(body.fxFrom).toBe("2026-09-16")
    } finally {
      await t.client.close()
      dbState.db = null
    }
  })

  it("leaves the series unconverted without ?currency=", async () => {
    const { sql } = await import("drizzle-orm")
    const { createTestDb } = await import("../db/test-db.js")
    const { syncTickerReference } = await import("../scripts/tickerref-sync.js")
    const t = await createTestDb()
    dbState.db = t.db
    await syncTickerReference(
      `listing_key,ticker,exchange,name,asset_type,stock_sector,etf_category,country,country_code,isin,aliases
WSE::PKN,PKN,WSE,PKN Orlen,Stock,Energy,,Poland,PL,PLPKNO0000070294,`,
      t.db,
    )
    mocked.fetchOhlcv.mockResolvedValue([
      { date: "2026-09-16", open: 99, high: 101, low: 98, close: 100, volume: 10 },
    ])
    try {
      const res = await req("/api/instruments/PKN/history?resolution=daily")
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.closePrices).toEqual([100])
      expect(body.currency).toBe("PLN")
      expect(body.baseCurrency).toBe("PLN")
      expect(body.fxFrom).toBeNull()
      // §72.10 — no conversion applied, so the field is ABSENT rather than [].
      // Collapsing the two would make a caller unable to tell "never converted"
      // from "converted and lost nothing".
      expect(body.unconvertedDates).toBeUndefined()
    } finally {
      await t.client.close()
      dbState.db = null
    }
  })

  /**
   * §72.10 on /history — the same declaration as /price-bars, asserted on the route
   * that has `convertedMask` directly in hand rather than re-querying for it.
   */
  it("§72.10: /history reports the dates it dropped, and empty when it dropped none", async () => {
    const { sql } = await import("drizzle-orm")
    const { createTestDb } = await import("../db/test-db.js")
    const { syncTickerReference } = await import("../scripts/tickerref-sync.js")
    const { LOCAL_PRICE_BARS_SETUP_SQL } = await import("../db/price-bars.js")
    const t = await createTestDb()
    dbState.db = t.db
    for (const stmt of LOCAL_PRICE_BARS_SETUP_SQL) await t.db.execute(sql.raw(stmt))
    await syncTickerReference(
      `listing_key,ticker,exchange,name,asset_type,stock_sector,etf_category,country,country_code,isin,aliases
WSE::PKN,PKN,WSE,PKN Orlen,Stock,Energy,,Poland,PL,PLPKNO0000070294,`,
      t.db,
    )
    // Rates for the 16th and 18th only, so the 17th is a SCATTERED hole in the
    // middle of the series — the shape fxFrom cannot express.
    await t.db.execute(sql.raw(`
      INSERT INTO instruments.fx_rates (rate_date, currency, rate, source) VALUES
        ('2026-09-16', 'PLN', 4.0000000000, 'ecb'),
        ('2026-09-16', 'USD', 4.3000000000, 'ecb'),
        ('2026-09-18', 'PLN', 4.2000000000, 'ecb'),
        ('2026-09-18', 'USD', 4.0000000000, 'ecb');
    `))
    mocked.fetchOhlcv.mockResolvedValue([
      { date: "2026-09-16", open: 99, high: 101, low: 98, close: 100, volume: 10 },
      { date: "2026-09-17", open: 101, high: 103, low: 100, close: 102, volume: 11 },
      { date: "2026-09-18", open: 100, high: 102, low: 99, close: 101, volume: 12 },
    ])
    try {
      const res = await req("/api/instruments/PKN/history?resolution=daily&currency=USD")
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.unconvertedDates).toEqual(["2026-09-17"])
      // fxFrom is the FIRST converted date and is unaffected by a later hole
      expect(body.fxFrom).toBe("2026-09-16")
      // and the dropped bar really is gone from the returned series
      expect(body.closePrices).toHaveLength(2)
      expect(body.closePrices).not.toContain(102)
    } finally {
      await t.client.close()
      dbState.db = null
    }
  })

  it("rejects conversion when the base currency is unresolvable (plan §56.3)", async () => {
    const { createTestDb } = await import("../db/test-db.js")
    const { syncTickerReference } = await import("../scripts/tickerref-sync.js")
    const t = await createTestDb()
    dbState.db = t.db
    // AMD on four exchanges (the PROD §54.5 collision shape): the resolver
    // stays silent for the un-suffixed ticker (plan §56.1) — a conversion
    // request must 400, never return a silently unconverted series.
    await syncTickerReference(
      `listing_key,ticker,exchange,name,asset_type,stock_sector,etf_category,country,country_code,isin,aliases
 ASX::AMD,AMD,ASX,Arrow Minerals Ltd,Stock,,,Australia,AU,,
 NASDAQ::AMD,AMD,NASDAQ,Advanced Micro Devices,Stock,,,United States,US,,
 NEO::AMD,AMD,NEO,CDR AMD,Stock,,,Brazil,BR,,
 TASE::AMD,AMD,TASE,Amiad Water Systems,Stock,,,Israel,IL,,`,
      t.db,
    )
    mocked.fetchOhlcv.mockResolvedValue([
      { date: "2026-09-16", open: 99, high: 101, low: 98, close: 100, volume: 10 },
    ])
    try {
      const res = await req("/api/instruments/AMD/history?resolution=daily&currency=PLN")
      expect(res.status).toBe(400)
      expect((await res.json()).message).toMatch(/base currency unknown/)
      expect(mocked.fetchOhlcv).not.toHaveBeenCalled()
      // No ?currency= → the native series still loads (default chart path).
      const plain = await req("/api/instruments/AMD/history?resolution=daily")
      expect(plain.status).toBe(200)
      const body = await plain.json()
      expect(body.closePrices).toEqual([100])
      expect(body.currency).toBeNull()
      expect(body.baseCurrency).toBeNull()
    } finally {
      await t.client.close()
      dbState.db = null
    }
  })
})

describe("GET /:symbol/price — ?currency= (plan §48.2)", () => {
  async function dbWithFx() {
    const { sql } = await import("drizzle-orm")
    const { createTestDb } = await import("../db/test-db.js")
    const { syncTickerReference } = await import("../scripts/tickerref-sync.js")
    const t = await createTestDb()
    dbState.db = t.db
    await syncTickerReference(
      `listing_key,ticker,exchange,name,asset_type,stock_sector,etf_category,country,country_code,isin,aliases
 WSE::PKN,PKN,WSE,PKN Orlen,Stock,Energy,,Poland,PL,PLPKNO0000070294,`,
      t.db,
    )
    await t.db.execute(sql.raw(`
      INSERT INTO instruments.fx_rates (rate_date, currency, rate, source) VALUES
        ('2026-09-16', 'PLN', 4.0000000000, 'ecb'),
        ('2026-09-16', 'USD', 4.3000000000, 'ecb'),
        ('2026-09-17', 'PLN', 4.1000000000, 'ecb'),
        ('2026-09-17', 'USD', 4.2000000000, 'ecb'),
        ('2026-09-19', 'PLN', 4.3000000000, 'ecb'),
        ('2026-09-19', 'USD', 4.4000000000, 'ecb');
    `))
    return t
  }

  it("converts a dated price against the newest rate on/before that date", async () => {
    const t = await dbWithFx()
    mocked.fetchOhlcv.mockResolvedValue([
      { date: "2026-09-16", open: 99, high: 101, low: 98, close: 100, volume: 10 },
      { date: "2026-09-17", open: 101, high: 103, low: 100, close: 102, volume: 12 },
    ])
    try {
      const res = await req("/api/instruments/PKN/price?date=2026-09-17&currency=USD")
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.price).toBeCloseTo((102 * 4.2) / 4.1, 8)
      expect(body.currency).toBe("USD")
      expect(body.baseCurrency).toBe("PLN")
      expect(body.fxFrom).toBe("2026-09-17")
    } finally {
      await t.client.close()
      dbState.db = null
    }
  })

  it("converts the live quote against the newest rate table", async () => {
    const t = await dbWithFx()
    mocked.fetchQuote.mockResolvedValue({
      last_price: 102,
      prev_close: 101,
      change: 1,
      change_percent: 0.0099,
      currency: "PLN",
      last_timestamp: "2026-09-19 17:00:01",
    })
    try {
      const res = await req("/api/instruments/PKN/price?currency=USD")
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.price).toBeCloseTo((102 * 4.4) / 4.3, 8)
      expect(body.currency).toBe("USD")
      expect(body.baseCurrency).toBe("PLN")
      expect(body.fxFrom).toBe("2026-09-19")
    } finally {
      await t.client.close()
      dbState.db = null
    }
  })

  it("serves the native price when no ?currency=", async () => {
    const t = await dbWithFx()
    mocked.fetchQuote.mockResolvedValue({
      last_price: 102,
      prev_close: 101,
      change: 1,
      change_percent: 0.0099,
      currency: "PLN",
      last_timestamp: "2026-09-19 17:00:01",
    })
    try {
      const res = await req("/api/instruments/PKN/price")
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.price).toBe(102)
      expect(body.currency).toBe("PLN")
      expect(body.baseCurrency).toBe("PLN")
      expect(body.fxFrom).toBeNull()
    } finally {
      await t.client.close()
      dbState.db = null
    }
  })
})


// ---------------------------------------------------------------------------
// §86.8 — the profile route dispatches by asset class
//
// These run against a real test db and real `ticker_reference` rows rather than
// a mocked query module: the dispatch reads the same column the rest of the
// service reads, and a mock of `assetTypeForSymbol` would test the switch rather
// than the wiring.
// ---------------------------------------------------------------------------

/** The recorded Catalyst and crypto profile rows (§86.1). */
const CORP_BOND_ROW = {
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

const CRYPTO_ROW = {
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

/** Seed `ticker_reference` and run one profile request against it. */
async function profileWithReference(csv: string, path: string) {
  const { createTestDb } = await import("../db/test-db.js")
  const { syncTickerReference } = await import("../scripts/tickerref-sync.js")
  const t = await createTestDb()
  dbState.db = t.db
  await syncTickerReference(csv, t.db)
  try {
    return await req(path)
  } finally {
    await t.client.close()
    dbState.db = null
  }
}

const REF_HEADER =
  "listing_key,ticker,exchange,name,asset_type,stock_sector,etf_category,country,country_code,isin,aliases"

describe("GET /:symbol/profile — asset-class dispatch (§86.8)", () => {
  it("serves a Catalyst bond through fetchCorpBondProfile and never probes equity", async () => {
    mocked.fetchCorpBondProfile.mockResolvedValue(CORP_BOND_ROW)
    const res = await profileWithReference(
      `${REF_HEADER}\nGPW::BST0327,BST0327,GPW,"Best S.A.",corp_bond,,,,PL,PLBEST000333,`,
      "/api/instruments/BST0327/profile",
    )

    expect(res.status).toBe(200)
    expect(mocked.fetchCorpBondProfile).toHaveBeenCalledWith("BST0327")
    expect(mocked.fetchProfile).not.toHaveBeenCalled()
    const body = await res.json()
    expect(body.keyFacts.kind).toBe("corp_bond")
    expect(body.keyFacts.issuer).toBe("Best S.A.")
    expect(body.keyFacts.nominalValue).toBe(100)
    expect(body.keyFacts.currentRate).toBe(7.83)
    expect(body.keyFacts.secured).toBe("NIE")
  })

  it("serves a crypto pair through fetchCryptoProfile, keyed as a -USD pair", async () => {
    mocked.fetchCryptoProfile.mockResolvedValue(CRYPTO_ROW)
    const res = await profileWithReference(
      `${REF_HEADER}\nCCC::BTC,BTC,CCC,"Bitcoin USD",crypto,,,,,,`,
      "/api/instruments/BTC/profile",
    )

    expect(res.status).toBe(200)
    // A bare stored ticker has to become the pair the tier keys on.
    expect(mocked.fetchCryptoProfile).toHaveBeenCalledWith("BTC-USD")
    expect(mocked.fetchProfile).not.toHaveBeenCalled()
    const body = await res.json()
    expect(body.keyFacts.kind).toBe("crypto")
    expect(body.keyFacts.name).toBe("Bitcoin USD")
    expect(body.keyFacts.icoDate).toBe("2014-09-17")
    expect(body.keyFacts.circulatingSupply).toBe(19972590.0)
  })

  it("serves a Catalyst bond even when the equity tier would have answered", async () => {
    // The regression this step exists for. obligacje.pl carries no BST0327, so
    // the old order probed equity, failed, probed the savings-bond tier, failed
    // again, and returned 502 — for a page whose data was always one call away.
    mocked.fetchProfile.mockResolvedValue({ name: "Best S.A.", sector: "Retail" })
    mocked.fetchCorpBondProfile.mockResolvedValue(CORP_BOND_ROW)

    const res = await profileWithReference(
      `${REF_HEADER}\nGPW::BST0327,BST0327,GPW,"Best S.A.",corp_bond,,,,PL,PLBEST000333,`,
      "/api/instruments/BST0327/profile",
    )

    expect(res.status).toBe(200)
    expect(mocked.fetchProfile).not.toHaveBeenCalled()
    expect((await res.json()).keyFacts.kind).toBe("corp_bond")
  })

  it("maps a Catalyst 404 to NotFound instead of falling through to equity", async () => {
    mocked.fetchCorpBondProfile.mockRejectedValue(new cachest.UpstreamError("x", 404))

    const res = await profileWithReference(
      `${REF_HEADER}\nGPW::NOPE99,NOPE99,GPW,"Niepowiadamująca",corp_bond,,,,PL,,`,
      "/api/instruments/NOPE99/profile",
    )

    expect(res.status).toBe(404)
    expect((await res.json()).error).toBe("NotFound")
    expect(mocked.fetchProfile).not.toHaveBeenCalled()
  })

  it("still routes a savings bond to the bond tier and gives it bond key facts", async () => {
    mocked.fetchBondProfile.mockResolvedValue({
      symbol: "ROD0129",
      name: "Obligacje 12-letnie ROD",
      series_code: "ROD",
      rate_rule: "fixed",
      margin: "5.75",
      fee_b: "2.00",
      term_months: 144,
      nominal: "100.00",
    })
    const res = await profileWithReference(
      `${REF_HEADER}\nGPW::ZZZ,ZZZ,GPW,"Unrelated",Stock,,,Poland,PL,,`,
      "/api/instruments/ROD0129/profile",
    )

    expect(res.status).toBe(200)
    expect(mocked.fetchBondProfile).toHaveBeenCalledWith("ROD0129")
    const body = await res.json()
    expect(body.keyFacts.kind).toBe("bond")
    expect(body.keyFacts.margin).toBe(5.75)
    expect(body.keyFacts.rateRule).toBe("fixed")
    expect(body.keyFacts.termMonths).toBe(144)
  })

  it("keeps today's probe order for a symbol the reference does not know", async () => {
    // No reference row at all means no sync has run, which is not evidence that
    // the symbol is an equity — so the old equity-then-bond cascade stands.
    mocked.fetchProfile.mockResolvedValue({ name: "Apple Inc." })

    const res = await req("/api/instruments/ZZZZ/profile")

    expect(res.status).toBe(200)
    expect(mocked.fetchProfile).toHaveBeenCalledWith("ZZZZ")
    expect((await res.json()).keyFacts).toBeNull()
  })

  it("falls back to the bond tier for an unknown symbol whose equity profile 404s", async () => {
    mocked.fetchProfile.mockRejectedValue(new cachest.UpstreamError("x", 404))
    mocked.fetchBondProfile.mockResolvedValue({
      symbol: "ZZZZ",
      name: "Obligacje",
      series_code: "ZZZ",
      rate_rule: "nbp_ref+margin",
      margin: "1.25",
    })

    const res = await req("/api/instruments/ZZZZ/profile")

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(mocked.fetchBondProfile).toHaveBeenCalledWith("ZZZZ")
    expect(body.keyFacts.kind).toBe("bond")
    expect(body.keyFacts.rateRule).toBe("nbp_ref+margin")
  })

  it("fills an equity's key facts after the reference fill, not before", async () => {
    // gicsSector is null in the raw translation and filled from stock_sector by
    // the reference pass — so the card has to be computed after that, or it
    // renders a dash directly under a profile that says Energy.
    mocked.fetchProfile.mockResolvedValue({ symbol: "PKN", name: "PKN Orlen" })

    const res = await profileWithReference(
      `${REF_HEADER}\nWSE::PKN,PKN,WSE,"Polski Koncern Naftowy ORLEN SA",Stock,Energy,,Poland,PL,PLPKN0000018,orlen`,
      "/api/instruments/PKN/profile",
    )

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.gicsSector).toBe("Energy")
    expect(body.keyFacts.kind).toBe("stock")
    expect(body.keyFacts.sector).toBe("Energy")
  })

  it("gives an ETF the category the reference table already fills", async () => {
    mocked.fetchProfile.mockResolvedValue({ symbol: "SPY", name: "SPDR S&P 500 ETF" })

    const res = await profileWithReference(
      `${REF_HEADER}\nGPW::SPY,SPY,GPW,"SPDR S&P 500 ETF Trust",ETF,,Equity,US,US78462F1030,spy`,
      "/api/instruments/SPY/profile",
    )

    expect(res.status).toBe(200)
    expect((await res.json()).keyFacts).toEqual({ kind: "etf", category: "Equity" })
  })

  it("gives an ANALIZY fund its category code and a TFI fund none", async () => {
    mocked.fetchProfile.mockResolvedValue({ name: "Erste Akcji Polskich" })
    const analizy = await profileWithReference(
      `${REF_HEADER}\nANALIZY::ARK01,ARK01,GPW,"Erste Akcji Polskich",fund,,,,PL,,`,
      "/api/instruments/ARK01/profile",
    )

    expect(analizy.status).toBe(200)
    expect((await analizy.json()).keyFacts).toEqual({ kind: "fund", categoryCode: "ARK01" })

    mocked.fetchProfile.mockResolvedValue({ name: "NNEP65" })
    const tfi = await profileWithReference(
      `${REF_HEADER}\nTFI::NNEP65.TFI,NNEP65.TFI,TFI,"NNEP65",tfi,,,,PL,,`,
      "/api/instruments/NNEP65.TFI/profile",
    )

    expect(tfi.status).toBe(200)
    expect((await tfi.json()).keyFacts).toEqual({ kind: "fund", categoryCode: null })
  })
})
