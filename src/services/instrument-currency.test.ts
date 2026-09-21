import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { sql } from "drizzle-orm"
import { createTestDb } from "../db/test-db.js"
import type { DB } from "../db/index.js"
import { exchangeReference, tickerReference } from "../db/schema.js"
import { cryptoPairCurrency, resolveCurrency, resolveInstrumentCurrency } from "./instrument-currency.js"

vi.mock("../adapters/cachest.js", () => ({
  fetchOhlcv: vi.fn(),
  fetchBondOhlcv: vi.fn(),
  fetchCryptoOhlcv: vi.fn(),
}))

describe("instrument currency (§36)", () => {
  let db: DB
  let client: Awaited<ReturnType<typeof createTestDb>>["client"]

  beforeAll(async () => {
    const t = await createTestDb()
    db = t.db
    client = t.client
    // WSE → .WA suffix so venue-qualified lookups resolve their exchange
    await db
      .insert(exchangeReference)
      .values({ exchangeCode: "WSE", canonicalName: "Warsaw Stock Exchange", yahooSuffix: "WA" })
    // SNT on WSE — Synektik, a Polish (PLN) stock
    await db
      .insert(tickerReference)
      .values({
        listingKey: "WSE::SNT",
        ticker: "SNT",
        exchange: "WSE",
        name: "Synektik Sa",
        assetType: "Stock",
        country: "Poland",
        countryCode: "PL",
      })
    // Same ticker on another venue — must not bleed into the WSE resolution
    await db
      .insert(tickerReference)
      .values({
        listingKey: "NASDAQ::SNT",
        ticker: "SNT",
        exchange: "NASDAQ",
        name: "Senstar Technologies",
        assetType: "Stock",
        country: "Canada",
        countryCode: "CA",
      })
  })

  afterAll(async () => {
    await client.close()
  })

  it("crypto pairs resolve to the quote currency", () => {
    expect(cryptoPairCurrency("BTC-USD")).toBe("USD")
    expect(cryptoPairCurrency("BTC-EUR")).toBe("EUR")
    expect(cryptoPairCurrency("BTC")).toBeNull()
    expect(cryptoPairCurrency("BTC-XYZ")).toBeNull()
  })

  it("SNT.WA resolves to PLN (venue-scoped tickerref country)", async () => {
    expect(await resolveInstrumentCurrency(db, "SNT.WA")).toBe("PLN")
  })

  it("SNT (unlisted venue) resolves to one of the listed countries' currencies", async () => {
    // Bare SNT matches both venues (no exchange scoping without a suffix);
    // either listing yields a real currency — never the USD fallback.
    const ccy = await resolveInstrumentCurrency(db, "SNT")
    expect(["PLN", "CAD"]).toContain(ccy)
  })

  it("corp_bond/fund/bond resolve to PLN without a tickerref row", async () => {
    await db
      .insert(tickerReference)
      .values({
        listingKey: "CATALYST::BST0327",
        ticker: "BST0327",
        exchange: "CATALYST",
        name: "Bond",
        assetType: "corp_bond",
      })
    await db
      .insert(tickerReference)
      .values({
        listingKey: "TFI::NNEP25",
        ticker: "NNEP25",
        exchange: "TFI",
        name: "Fund",
        assetType: "fund",
      })
    expect(await resolveInstrumentCurrency(db, "BST0327.WA")).toBe("PLN")
    expect(await resolveInstrumentCurrency(db, "NNEP25.TFI")).toBe("PLN")
  })

  it("never guesses USD for unknown symbols or a null db (§47)", async () => {
    expect(await resolveInstrumentCurrency(db, "UNKNOWNXYZ")).toBeNull()
    expect(await resolveInstrumentCurrency(null, "AAPL")).toBeNull()
    // pair currency resolves even without a db
    expect(await resolveInstrumentCurrency(null, "BTC-USD")).toBe("USD")
    expect(await resolveInstrumentCurrency(null, "BTC-EUR")).toBe("EUR")
  })

  describe("resolveCurrency — provider vs local comparison (§47.4)", () => {
    it("provider declared + matches local → provider", async () => {
      const r = await resolveCurrency(db, "SNT.WA", "PLN")
      expect(r).toEqual({ currency: "PLN", currencySource: "provider" })
    })

    it("provider declared but local differs → estimated, local wins", async () => {
      // SNT.WA is PLN locally; a provider claiming USD must not win.
      const r = await resolveCurrency(db, "SNT.WA", "USD")
      expect(r).toEqual({ currency: "PLN", currencySource: "estimated" })
    })

    it("provider declared, local silent → provider (real declaration wins)", async () => {
      const r = await resolveCurrency(db, "UNKNOWNXYZ", "USD")
      expect(r).toEqual({ currency: "USD", currencySource: "provider" })
    })

    it("provider pence label normalized to GBP for comparison (plan §39)", async () => {
      const r = await resolveCurrency(null, "CSN.L", "uSD")
      expect(r).toEqual({ currency: "USD", currencySource: "provider" })
      const gbp = await resolveCurrency(null, "CSN.L", "GBp")
      expect(gbp).toEqual({ currency: "GBP", currencySource: "provider" })
    })

    it("provider silent + local resolved → estimated", async () => {
      const r = await resolveCurrency(db, "SNT.WA", null)
      expect(r).toEqual({ currency: "PLN", currencySource: "estimated" })
    })

    it("both silent → unknown with null currency", async () => {
      const r = await resolveCurrency(db, "UNKNOWNXYZ", null)
      expect(r).toEqual({ currency: null, currencySource: "unknown" })
    })
  })
})
