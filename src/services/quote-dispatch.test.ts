import { describe, expect, it, vi, beforeEach } from "vitest"

import { fetchQuoteByAssetClass } from "./quote-dispatch.js"
import {
  fetchQuote,
  fetchCryptoQuote,
  fetchFundCategoryHistory,
  UpstreamError,
} from "../adapters/cachest.js"
import { assetTypeForSymbol, priceTierForSymbol } from "../db/tickerref-queries.js"

/**
 * §78.1 — the fund *category* quote path.
 *
 * This case was missing while the history path existed, and the symptom was
 * silent rather than loud: a category code fell through to /equity/quote, which
 * 404s, so `positions.price_source` stayed at its `manual` default with a NULL
 * current_price and the holding dropped out of the portfolio value. PROD
 * 2026-10-01: ING01W unpriced while NNEP65.TFI was priced from the same rebuild.
 *
 * So the assertions here are about *which upstream* gets called, and about the
 * `manual`-default trap — not just about the numbers coming out.
 */

vi.mock("../adapters/cachest.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../adapters/cachest.js")>()),
  fetchQuote: vi.fn(),
  fetchCryptoQuote: vi.fn(),
  fetchFundCategoryHistory: vi.fn(),
}))

vi.mock("../db/tickerref-queries.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../db/tickerref-queries.js")>()),
  assetTypeForSymbol: vi.fn(),
  priceTierForSymbol: vi.fn(),
  searchTickerReference: vi.fn(async () => []),
}))

const mockQuote = vi.mocked(fetchQuote)
const mockCrypto = vi.mocked(fetchCryptoQuote)
const mockHistory = vi.mocked(fetchFundCategoryHistory)
const mockAssetType = vi.mocked(assetTypeForSymbol)
const mockTier = vi.mocked(priceTierForSymbol)

const db = {} as never

beforeEach(() => {
  vi.clearAllMocks()
  mockQuote.mockResolvedValue({ symbol: "X", last_price: 1 })
  mockCrypto.mockResolvedValue({ symbol: "X", price: 1 })
  mockHistory.mockResolvedValue([])
})

describe("§78.1 — a fund category is priced from its own valuations", () => {
  it("uses the fund-category history, never the equity quote", async () => {
    mockAssetType.mockResolvedValue("fund")
    mockTier.mockResolvedValue("fund_category")
    mockHistory.mockResolvedValue([
      { date: "2026-09-28", close: 933.0 },
      { date: "2026-09-29", close: 931.03 },
    ])

    const q = (await fetchQuoteByAssetClass(db, "ING01W")) as Record<string, unknown>

    expect(mockHistory).toHaveBeenCalledWith("ING01W", expect.any(String), expect.any(String))
    expect(mockQuote).not.toHaveBeenCalled()
    expect(q.last_price).toBe(931.03)
    expect(q.prev_close).toBe(933.0)
    expect(q.currency).toBe("PLN")
    expect(q.last_timestamp).toBe("2026-09-29")
  })

  it("shapes open/high/low as the close, matching what biznesradar reports for .TFI", async () => {
    // PROD NNEP65.TFI returns open=high=low=last=19.81 — a fund NAV has no
    // intraday range. Keeping the two fund tiers alike means the SPA needs no
    // special case for one of them.
    mockAssetType.mockResolvedValue("fund")
    mockTier.mockResolvedValue("fund_category")
    mockHistory.mockResolvedValue([{ date: "2026-09-29", close: 931.03 }])

    const q = (await fetchQuoteByAssetClass(db, "ING01W")) as Record<string, unknown>
    expect(q.open).toBe(931.03)
    expect(q.high).toBe(931.03)
    expect(q.low).toBe(931.03)
    expect(q.prev_close).toBe(931.03)
  })

  it("asks for a 14-day window, so a long weekend is not read as 'no price'", async () => {
    mockAssetType.mockResolvedValue("fund")
    mockTier.mockResolvedValue("fund_category")
    mockHistory.mockResolvedValue([{ date: "2026-09-29", close: 931.03 }])

    await fetchQuoteByAssetClass(db, "ING01W")

    const [, start, end] = mockHistory.mock.calls[0]
    const days = (new Date(end).getTime() - new Date(start).getTime()) / 864e5
    expect(days).toBeGreaterThanOrEqual(13.9)
    expect(days).toBeLessThanOrEqual(14.1)
  })

  it("throws rather than pricing a holding at zero when the category serves nothing", async () => {
    // An empty history is not a price of 0. Throwing keeps the caller from
    // writing a 0 into current_price, which is the exact corruption this route
    // is here to avoid.
    mockAssetType.mockResolvedValue("fund")
    mockTier.mockResolvedValue("fund_category")
    mockHistory.mockResolvedValue([])

    await expect(fetchQuoteByAssetClass(db, "ING01W")).rejects.toBeInstanceOf(UpstreamError)
    expect(mockQuote).not.toHaveBeenCalled()
  })

  it("still returns a usable quote from a single valuation, with no fake change", async () => {
    mockAssetType.mockResolvedValue("fund")
    mockTier.mockResolvedValue("fund_category")
    mockHistory.mockResolvedValue([{ date: "2026-09-29", close: 931.03 }])

    const q = (await fetchQuoteByAssetClass(db, "ING01W")) as Record<string, unknown>
    // prev_close falls back to the close itself, so change computes to 0 by
    // arithmetic rather than being asserted as 0.
    expect(q.prev_close).toBe(q.last_price)
  })
})

describe("§78.1 — a .TFI fund is NOT diverted", () => {
  it("keeps the equity quote, which biznesradar serves correctly", async () => {
    // NNEP65 priced fine from the same rebuild; diverting it would be a
    // regression on a working path.
    mockAssetType.mockResolvedValue("fund")
    mockTier.mockResolvedValue("standard")
    mockQuote.mockResolvedValue({ symbol: "NNEP65.TFI", last_price: 19.81 })

    const q = (await fetchQuoteByAssetClass(db, "NNEP65.TFI")) as Record<string, unknown>

    expect(mockQuote).toHaveBeenCalledWith("NNEP65.TFI")
    expect(mockHistory).not.toHaveBeenCalled()
    expect(q.last_price).toBe(19.81)
  })

  it("defaults to the equity quote when there is no db to resolve the tier", async () => {
    // fetchQuoteByAssetClass(db = null) is a real call shape. Degrading to the
    // existing behaviour beats throwing.
    mockQuote.mockResolvedValue({ symbol: "NNEP65.TFI", last_price: 19.81 })
    const q = (await fetchQuoteByAssetClass(null, "NNEP65.TFI")) as Record<string, unknown>
    expect(mockQuote).toHaveBeenCalledWith("NNEP65.TFI")
    expect(q.last_price).toBe(19.81)
  })
})

describe("§78.1 — non-fund classes are untouched", () => {
  it("crypto still goes to the crypto quote", async () => {
    mockAssetType.mockResolvedValue("crypto")
    mockCrypto.mockResolvedValue({ symbol: "BTC-USD", price: 50000 })

    await fetchQuoteByAssetClass(db, "BTC-USD")

    expect(mockCrypto).toHaveBeenCalledWith("BTC-USD")
    expect(mockHistory).not.toHaveBeenCalled()
  })

  it("a stock never consults the fund history", async () => {
    mockAssetType.mockResolvedValue("Stock")
    mockQuote.mockResolvedValue({ symbol: "AAPL", last_price: 200 })

    await fetchQuoteByAssetClass(db, "AAPL")

    expect(mockQuote).toHaveBeenCalled()
    expect(mockHistory).not.toHaveBeenCalled()
  })

  it("a corp bond never consults the fund history", async () => {
    // All 941 corp_bond rows are dotless (ABE0227) — the same shape as a fund
    // category. Only the venue column separates them, and it must not leak here.
    mockAssetType.mockResolvedValue("corp_bond")
    mockQuote.mockResolvedValue({ symbol: "ABE0227", last_price: 100 })

    await fetchQuoteByAssetClass(db, "ABE0227")

    expect(mockQuote).toHaveBeenCalledWith("ABE0227")
    expect(mockHistory).not.toHaveBeenCalled()
  })
})
