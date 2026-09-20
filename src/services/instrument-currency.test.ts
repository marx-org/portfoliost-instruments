import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { sql } from "drizzle-orm"
import { createTestDb } from "../db/test-db.js"
import type { DB } from "../db/index.js"
import { exchangeReference, tickerReference } from "../db/schema.js"
import { cryptoPairCurrency, resolveInstrumentCurrency } from "./instrument-currency.js"

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

  it("falls back to USD for unknown symbols and a null db", async () => {
    expect(await resolveInstrumentCurrency(db, "UNKNOWNXYZ")).toBe("USD")
    expect(await resolveInstrumentCurrency(null, "AAPL")).toBe("USD")
    // pair currency resolves even without a db
    expect(await resolveInstrumentCurrency(null, "BTC-USD")).toBe("USD")
    expect(await resolveInstrumentCurrency(null, "BTC-EUR")).toBe("EUR")
  })
})
