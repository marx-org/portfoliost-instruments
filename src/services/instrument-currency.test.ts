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
    // WSE → .WA suffix so venue-qualified lookups resolve their exchange.
    // country_code is what lets a .WA symbol with no WSE listing still resolve
    // (§71 branch 5) — the venue is a known fact even when the listing is not.
    await db
      .insert(exchangeReference)
      .values({
        exchangeCode: "WSE",
        canonicalName: "Warsaw Stock Exchange",
        yahooSuffix: "WA",
        countryCode: "PL",
      })
    // TSXV, for the §71 CRI.WA shape: a bare ticker that exists in Canada but
    // not on the Warsaw venue the symbol actually names.
    await db
      .insert(exchangeReference)
      .values({
        exchangeCode: "TSXV",
        canonicalName: "TSX Venture Exchange",
        yahooSuffix: "V",
        countryCode: "CA",
      })
    // CRI: PROD §71 — listed in Canada, on no Warsaw row. The old resolver
    // priced CRI.WA in CAD off this listing.
    await db
      .insert(tickerReference)
      .values({
        listingKey: "TSXV::CRI",
        ticker: "CRI",
        exchange: "TSXV",
        name: "Churchill Resources Inc",
        assetType: "Stock",
        country: "Canada",
        countryCode: "CA",
      })
    // A bare ticker that exists ONLY as a prefix of others — no exact listing.
    await db
      .insert(tickerReference)
      .values({
        listingKey: "NASDAQ::CRIMSON",
        ticker: "CRIMSON",
        exchange: "NASDAQ",
        name: "Crimson Metal Engineering Company Ltd",
        assetType: "Stock",
        country: "United States",
        countryCode: "US",
      })
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
    // §56 — AMD on four exchanges (the PROD §54.5 collision shape)
    const amd = [
      { exchange: "ASX", country: "Australia", countryCode: "AU" },
      { exchange: "NASDAQ", country: "United States", countryCode: "US" },
      { exchange: "NEO", country: "Brazil", countryCode: "BR" },
      { exchange: "TASE", country: "Israel", countryCode: "IL" },
    ]
    await db
      .insert(tickerReference)
      .values(amd.map((a) => ({
        listingKey: `${a.exchange}::AMD`,
        ticker: "AMD",
        exchange: a.exchange,
        name: a.exchange === "NASDAQ" ? "Advanced Micro Devices" : `AMD (${a.exchange})`,
        assetType: "Stock",
        country: a.country,
        countryCode: a.countryCode,
      })))
    // Single-listing ticker — resolution still works when there is one venue
    await db
      .insert(tickerReference)
      .values({
        listingKey: "LSE::BATS",
        ticker: "BATS",
        exchange: "LSE",
        name: "BATS plc",
        assetType: "Stock",
        country: "United Kingdom",
        countryCode: "GB",
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

  it("SNT (un-suffixed, two venues) is ambiguity → null (§56)", async () => {
    // Bare SNT matches WSE AND NASDAQ with no exchange hint: that is §47
    // uncertainty — silence, not a venue picked by heap luck.
    expect(await resolveInstrumentCurrency(db, "SNT")).toBeNull()
  })

  it("AMD-shaped 4-exchange collision → null (PROD §54.5 shape, plan §56)", async () => {
    expect(await resolveInstrumentCurrency(db, "AMD")).toBeNull()
  })

  it("single-listing ticker still resolves via country code (§56 regression guard)", async () => {
    expect(await resolveInstrumentCurrency(db, "BATS")).toBe("GBP")
  })

  it("venue-qualified SNT.WA resolves to the WSE row despite a cross-exchange SNT collision (§49.9 guard)", async () => {
    expect(await resolveInstrumentCurrency(db, "SNT.WA")).toBe("PLN")
  })

  // ── §71 — the currency is a multiplier, so these are the tests that matter ──

  it("CRI.WA: venue known but listing missing → the VENUE's currency, never another venue's (§71)", async () => {
    // PROD: CRI.WA (Creotech Instruments, Warsaw) has no WSE row in
    // ticker_reference, but bare CRI is listed on TSXV (Canada). The old code
    // fell through to an unfiltered `ILIKE 'CRI%'`, took rows[0] — TSXV/CA —
    // and skipped the candidates-agree guard BECAUSE a venue was resolved. The
    // position's 9,451 PLN was then multiplied by the CAD→PLN rate, overstating
    // the live headline by 16,190 PLN.
    expect(await resolveInstrumentCurrency(db, "CRI.WA")).toBe("PLN")
  })

  it("CRI.WA stays PLN even when the foreign listings are the only CRI rows (§71 regression)", async () => {
    // Guards the specific failure: the answer must not depend on how many
    // foreign listings happen to exist for the bare ticker.
    await db
      .insert(tickerReference)
      .values({
        listingKey: "NYSE::CRI",
        ticker: "CRI",
        exchange: "NYSE",
        name: "Carter's Inc",
        assetType: "Stock",
        country: "United States",
        countryCode: "US",
      })
    await db
      .insert(tickerReference)
      .values({
        listingKey: "ASX::CRI",
        ticker: "CRI",
        exchange: "ASX",
        name: "Critica Ltd",
        assetType: "Stock",
        country: "Australia",
        countryCode: "AU",
      })
    expect(await resolveInstrumentCurrency(db, "CRI.WA")).toBe("PLN")
  })

  it("a suffix naming an unknown exchange → null, not a guess (§71)", async () => {
    // No exchange_reference row carries yahoo_suffix 'QQ'. Previously the code
    // treated "no exchange" as licence to search everywhere.
    expect(await resolveInstrumentCurrency(db, "SNT.QQ")).toBeNull()
  })

  it("no exact listing → null, never a currency off a prefix/name match (§71)", async () => {
    // "CRI2" has no listing; the search will surface CRIMSON (US) on the
    // `ILIKE 'CRI%'` prefix branch. Reading USD off that would be a claim about
    // a different security.
    expect(await resolveInstrumentCurrency(db, "CRI2")).toBeNull()
  })

  it("the bare ticker is still ambiguous across venues (§71 keeps §56)", async () => {
    // CRI is now on TSXV/NYSE/ASX — three countries. With no venue hint that is
    // genuine uncertainty, not a majority vote.
    expect(await resolveInstrumentCurrency(db, "CRI")).toBeNull()
  })

  it("AMD collision + provider-declared USD → provider wins (no silent wrong local)", async () => {
    // Before §56 the resolver guessed AUD (ASX row won the tie); now the
    // provider's real declaration beats the silence.
    const r = await resolveCurrency(db, "AMD", "USD")
    expect(r).toEqual({ currency: "USD", currencySource: "provider" })
  })

  // §63.10.5 — the `exchanges.size > 1 → null` rule silenced the currency of
  // plain US large caps whenever a second listing existed anywhere, which made
  // `?currency=` return 400 and left the wallets backfill unable to value them
  // (PROD: MSFT matched NASDAQ + NEO, both US, and resolved to null).
  describe("multi-venue listings that agree on currency (§63.10.5)", () => {
    beforeAll(async () => {
      // MSFT: NASDAQ + NEO, both country US.
      for (const exchange of ["NASDAQ", "NEO"]) {
        await db
          .insert(tickerReference)
          .values({
            listingKey: `${exchange}::MSFT`,
            ticker: "MSFT",
            exchange,
            name: "Microsoft Corporation",
            assetType: "Stock",
            country: "United States",
            countryCode: "US",
          })
      }
      // META: NASDAQ (US) vs LSE (IE) vs STO (SE) — EUR vs USD, a real
      // disagreement that must stay silent.
      for (const [exchange, cc, country] of [
        ["NASDAQ", "US", "United States"],
        ["LSE", "IE", "Ireland"],
        ["STO", "SE", "Sweden"],
      ] as const) {
        await db
          .insert(tickerReference)
          .values({
            listingKey: `${exchange}::META`,
            ticker: "META",
            exchange,
            name: "Meta Platforms",
            assetType: exchange === "NASDAQ" ? "Stock" : "ETF",
            country,
            countryCode: cc,
          })
      }
    })

    it("resolves when every candidate listing maps to the same currency", async () => {
      expect(await resolveInstrumentCurrency(db, "MSFT")).toBe("USD")
    })

    it("still returns null when the candidate listings disagree", async () => {
      expect(await resolveInstrumentCurrency(db, "META")).toBeNull()
    })

    it("a venue-qualified symbol is unaffected", async () => {
      expect(await resolveInstrumentCurrency(db, "SNT.WA")).toBe("PLN")
    })
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

/**
 * §72.4 — the cross-listed-ticker defect.
 *
 * PROD, 2026-10-01. `GET /api/instruments/MFC` returned
 *
 *     exchange = NYQ   currency = CAD   bar@2022-11-21 = 17.29
 *
 * while the stored transaction is `price 17.50, currency USD` — what Manulife
 * actually traded at on the NYSE that day. **The exchange was right and the
 * currency was the issuer's home listing**, so every consumer trusting the
 * declared currency converted a correct number into a wrong one. The price-audit
 * flagged 21 cross-currency symbols on exactly this, and comparing those trades
 * WITHOUT conversion reconciles 18 of them to under 3%.
 *
 * The mechanism: a venue-free ticker on a cross-listed company makes the
 * candidates-must-agree guard return `null` — correct, with no venue named there
 * is no honest answer — and then `resolveCurrency`'s fallback took the
 * provider's declaration, which is the **primary** listing's currency. The guard
 * was working. The fallback was what lied.
 *
 * The fix is a hint: the caller usually knows which venue the bars came from, and
 * a venue is a fact rather than a guess. **Note what is deliberately NOT asserted
 * here** — that a hintless `MFC` resolves to USD. It cannot, and it must not: two
 * listings genuinely disagree, so a guess would be exactly the failure §47 forbids.
 */
describe("§72.4: a known venue must beat the provider's primary-listing currency", () => {
  let db: DB
  let client: Awaited<ReturnType<typeof createTestDb>>["client"]

  beforeAll(async () => {
    const t = await createTestDb()
    db = t.db
    client = t.client
    // NYQ/NMS are the venues PROD's bars actually came from; TSX is the home
    // listing the provider was declaring.
    for (const [code, cc, name] of [
      ["NYQ", "US", "New York Stock Exchange"],
      ["NMS", "US", "Nasdaq"],
      ["TSX", "CA", "Toronto Stock Exchange"],
    ] as const) {
      await db
        .insert(exchangeReference)
        .values({ exchangeCode: code, canonicalName: name, countryCode: cc })
        .onConflictDoNothing()
    }
    for (const [exchange, cc, country] of [
      ["NYQ", "US", "United States"],
      ["TSX", "CA", "Canada"],
    ] as const) {
      await db
        .insert(tickerReference)
        .values({
          listingKey: `${exchange}::MFC`,
          ticker: "MFC",
          exchange,
          name: "Manulife Financial Corporation",
          assetType: "Stock",
          country,
          countryCode: cc,
        })
        .onConflictDoNothing()
    }
  })

  afterAll(async () => {
    await client?.close()
  })

  it("without a venue, MFC stays silent — the guard is correct and must survive", async () => {
    expect(await resolveInstrumentCurrency(db, "MFC")).toBeNull()
  })

  it("without a venue the provider is still all we have", async () => {
    // This is the documented fallback, not a bug in itself. It is what PROD got,
    // and it is wrong only because the caller could have said more.
    const r = await resolveCurrency(db, "MFC", "CAD")
    expect(r.currency).toBe("CAD")
    expect(r.currencySource).toBe("provider")
  })

  it("a NYQ hint resolves MFC to USD, overriding the provider's CAD", async () => {
    // THE regression test. PROD served CAD for an NYQ instrument.
    const r = await resolveCurrency(db, "MFC", "CAD", "NYQ")
    expect(r.currency).toBe("USD")
  })

  it("a TSX hint resolves MFC to CAD — the hint is followed, not hardcoded to USD", async () => {
    // Guards against 'fixing' this by always preferring the US listing, which
    // would just move the lie to the other side of the same problem.
    expect((await resolveCurrency(db, "MFC", "CAD", "TSX")).currency).toBe("CAD")
  })

  it("a venue answer is local, so it is not labelled a provider declaration", async () => {
    // `currencySource: "provider"` tells a consumer the upstream said so. That is
    // the false confidence this defect rode in on.
    expect((await resolveCurrency(db, "MFC", "CAD", "NYQ")).currencySource).not.toBe("provider")
  })

  it("an unmappable venue falls through instead of inventing a currency", async () => {
    const r = await resolveCurrency(db, "MFC", "CAD", "ZZZZ")
    expect(r.currency).toBe("CAD")
    expect(r.currencySource).toBe("provider")
  })

  it("a hint does not override a crypto pair's quote leg", async () => {
    // BTC-USD is denominated by its quote leg whatever venue is claimed; the hint
    // is deliberately consulted after the pair test.
    expect(await resolveInstrumentCurrency(db, "BTC-USD", "NYQ")).toBe("USD")
  })
})
