import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { createTestDb } from "../db/test-db.js"
import type { DB } from "../db/index.js"
import {
  searchTickerReference,
  referenceTickerKeys,
  assetTypeForSymbol,
  normalizeAssetType,
  priceTierForSymbol,
} from "./tickerref-queries.js"
import { syncTickerReference } from "../scripts/tickerref-sync.js"

const FIXTURE = `listing_key,ticker,exchange,name,asset_type,stock_sector,etf_category,country,country_code,isin,aliases
NASDAQ::AAPL,AAPL,NASDAQ,Apple Inc,Stock,Information Technology,,United States,US,US0378331005,apple
WSE::PKN,PKN,WSE,"Polski Koncern Naftowy ORLEN SA",Stock,Energy,,Poland,PL,PLPKN0000018,polski koncern naftowy orlen|orlen
NASDAQ::QQQ,QQQ,NASDAQ,Invesco QQQ Trust,ETF,,Large Blend,United States,US,US4642854031,qqq trust`

describe("searchTickerReference", () => {
  let db: DB
  let close: () => void

  beforeAll(async () => {
    const t = await createTestDb()
    db = t.db
    close = () => t.client.close()
    await syncTickerReference(FIXTURE, db)
  })

  afterAll(() => close())

  it("ranks exact ticker match first", async () => {
    const rows = await searchTickerReference(db, "AAPL")
    expect(rows[0]).toMatchObject({ ticker: "AAPL", isin: "US0378331005" })
  })

  it("matches by name fragment and alias", async () => {
    expect((await searchTickerReference(db, "orlen"))[0]?.ticker).toBe("PKN")
    expect((await searchTickerReference(db, "apple"))[0]?.ticker).toBe("AAPL")
  })

  it("finds PKN when searching PKN.WA (venue suffix)", async () => {
    const rows = await searchTickerReference(db, "pkn.wa")
    expect(rows[0]?.ticker).toBe("PKN")
    expect(rows[0]?.exchange).toBe("WSE")
  })

  it("returns empty for no match", async () => {
    expect(await searchTickerReference(db, "zzzzz")).toHaveLength(0)
  })

  it("finds AAPL by ISIN exact match", async () => {
    const rows = await searchTickerReference(db, "US0378331005")
    expect(rows[0]).toMatchObject({ ticker: "AAPL", exchange: "NASDAQ" })
  })
})

describe("searchTickerReference — venue-qualified lookup", () => {
  const COLLISION = `listing_key,ticker,exchange,name,asset_type,stock_sector,etf_category,country,country_code,isin,aliases
WSE::SNT,SNT,WSE,"Synektik Spolka Akcyjna",Stock,Healthcare,,Poland,PL,PLSNT0000016,synektik
NYSE::SNT,SNT,NYSE,"Senstar Technologies Corp",Stock,Technology,,Canada,CA,CA81799A1093,senstar
NASDAQ::AAPL,AAPL,NASDAQ,Apple Inc,Stock,Information Technology,,United States,US,US0378331005,apple`

  it("returns only the exchange-matched listing when suffix exchange is given", async () => {
    const { createTestDb } = await import("./test-db.js")
    const t = await createTestDb()
    try {
      await syncTickerReference(COLLISION, t.db)
      const rows = await searchTickerReference(t.db, "SNT", 50, "WSE")
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({ ticker: "SNT", exchange: "WSE", name: "Synektik Spolka Akcyjna" })
    } finally {
      await t.client.close()
    }
  })

  it("returns both collision candidates without an exchange", async () => {
    const { createTestDb } = await import("./test-db.js")
    const t = await createTestDb()
    try {
      await syncTickerReference(COLLISION, t.db)
      const rows = await searchTickerReference(t.db, "SNT")
      expect(rows).toHaveLength(2)
    } finally {
      await t.client.close()
    }
  })

  it("falls back to unqualified search when no listing matches the exchange", async () => {
    const { createTestDb } = await import("./test-db.js")
    const t = await createTestDb()
    try {
      await syncTickerReference(COLLISION, t.db)
      // no LSE listing for SNT — unqualified results come back
      const rows = await searchTickerReference(t.db, "SNT", 50, "LSE")
      expect(rows).toHaveLength(2)
    } finally {
      await t.client.close()
    }
  })
})

describe("venue-qualified identity lookup", () => {
  it("matches the bare ticker when the query carries a venue suffix", async () => {
    const t = await createTestDb()
    try {
      await syncTickerReference(FIXTURE, t.db)
      const rows = await searchTickerReference(t.db, "PKN.WA", 1, "WSE")
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({ ticker: "PKN", exchange: "WSE", isin: "PLPKN0000018" })
    } finally {
      await t.client.close()
    }
  })
})

describe("referenceTickerKeys (plan 34 pair-aware lookup)", () => {
  it("strips venue suffixes only", () => {
    expect(referenceTickerKeys("SNT.WA")).toEqual(["SNT"])
    expect(referenceTickerKeys("AAPL.US")).toEqual(["AAPL"])
    expect(referenceTickerKeys("ROD1033")).toEqual(["ROD1033"])
  })

  it("adds the base coin for currency pairs", () => {
    expect(referenceTickerKeys("BTC-USD")).toEqual(["BTC-USD", "BTC"])
    expect(referenceTickerKeys("ETH-EUR")).toEqual(["ETH-EUR", "ETH"])
  })

  it("never strips non-currency hyphen suffixes (catalyst class codes)", () => {
    expect(referenceTickerKeys("BOS0735-K")).toEqual(["BOS0735-K"])
  })
})

describe("assetTypeForSymbol — savings bonds route to the bond tier (plan §37.1)", () => {
  it("classifies ROD/EDO emissions as bond even when absent from ticker_reference", async () => {
    const t = await createTestDb()
    try {
      await syncTickerReference(
        `listing_key,ticker,exchange,name,asset_type,stock_sector,etf_category,country,country_code,isin,aliases
NASDAQ::AAPL,AAPL,NASDAQ,Apple Inc,Stock,Information Technology,,United States,US,US0378331005,apple`,
        t.db,
      )
      // Not in ticker_reference, but the emission code must classify as bond —
      // never degrade to stock and pay the equity provider walk.
      expect(await assetTypeForSymbol(t.db, "ROD1035")).toBe("bond")
      expect(await assetTypeForSymbol(t.db, "EDO0232")).toBe("bond")
      expect(await assetTypeForSymbol(t.db, "ROD1035.WA")).toBe("bond")
      // Non-bond unknown symbols are unchanged (null → callers treat as stock).
      expect(await assetTypeForSymbol(t.db, "AAPL")).toBe("Stock")
      expect(await assetTypeForSymbol(t.db, "ZZZZZ")).toBeNull()
    } finally {
      await t.client.close()
    }
  })
})

describe("assetTypeForSymbol — class-collision priority (plan 34)", () => {
  it("lets the specific class beat colliding stock/etf listings", async () => {
    const t = await createTestDb()
    try {
      await syncTickerReference(
        `listing_key,ticker,exchange,name,asset_type,stock_sector,etf_category,country,country_code,isin,aliases
 ASX::BTC,BTC,ASX,Bitcoin Futures,Stock,,Financials,,AU,,
 Euronext::BTC,BTC,Euronext,Bitcoin ETF,ETF,,Cryptocurrency,,FR,,
 CRYPTO::BTC,BTC,CRYPTO,BTC-USD,crypto,,,,US,btc`,
        t.db,
      )
      expect(await assetTypeForSymbol(t.db, "BTC")).toBe("crypto")
      expect(await assetTypeForSymbol(t.db, "BTC-USD")).toBe("crypto")
      expect(await assetTypeForSymbol(t.db, "AAPL")).toBeNull()
    } finally {
      await t.client.close()
    }
  })
})

describe("assetTypeForSymbol — fund categories come from the reference table (§78)", () => {
  it("classifies a category code as fund only once its catalogue row exists", async () => {
    const t = await createTestDb()
    try {
      // Before the row exists the symbol is simply unknown, which callers treat as
      // stock. §72.39 step 5 papered over this with a hardcoded early return;
      // §78 removed it so the catalogue is the single source of truth.
      expect(await assetTypeForSymbol(t.db, "ING01W")).toBeNull()

      await syncTickerReference(
        `listing_key,ticker,exchange,name,asset_type,stock_sector,etf_category,country,country_code,isin,aliases
ANALIZY::ING01W,ING01W,ANALIZY,ING Akcji W,fund,,,Poland,PL,,ING01
ANALIZY::ING92,ING92,ANALIZY,ING Emerytura 2065,fund,,,Poland,PL,,ING81`,
        t.db,
      )
      expect(await assetTypeForSymbol(t.db, "ING01W")).toBe("fund")
      expect(await assetTypeForSymbol(t.db, "ING92")).toBe("fund")
      expect(normalizeAssetType(await assetTypeForSymbol(t.db, "ING01W"))).toBe("fund")
    } finally {
      await t.client.close()
    }
  })

  it("still classifies savings bonds as bond, ahead of the table", async () => {
    const t = await createTestDb()
    try {
      // ROD1033 fits the category-code shape exactly, and the bond recogniser
      // must keep winning — it is checked before any lookup.
      expect(await assetTypeForSymbol(t.db, "ROD1035")).toBe("bond")
      expect(await assetTypeForSymbol(t.db, "EDO0232")).toBe("bond")
    } finally {
      await t.client.close()
    }
  })
})

describe("priceTierForSymbol — the tier comes from the reference row's venue (§78)", () => {
  it("classifies an ANALIZY row as the fund-category tier", async () => {
    const t = await createTestDb()
    try {
      await syncTickerReference(
        `listing_key,ticker,exchange,name,asset_type,stock_sector,etf_category,country,country_code,isin,aliases
ANALIZY::ING01W,ING01W,ANALIZY,ING Akcji W,fund,,,Poland,PL,,ING01
ANALIZY::ING92,ING92,ANALIZY,ING Emerytura 2065,fund,,,Poland,PL,,ING81
WSE::ABE0227,ABE0227,WSE,Some Issuer 06/27,corp_bond,,,Poland,PL,PL0000000000,`,
        t.db,
      )
      // The catalogue row is what routes the price — no hardcoded code list.
      expect(await priceTierForSymbol(t.db, "ING01W")).toBe("fund_category")
      expect(await priceTierForSymbol(t.db, "ing01w")).toBe("fund_category")
      expect(await priceTierForSymbol(t.db, "ING01W.WA")).toBe("fund_category")
    } finally {
      await t.client.close()
    }
  })

  it("leaves a corp bond on the standard tier despite a dotless code", async () => {
    const t = await createTestDb()
    try {
      await syncTickerReference(
        `listing_key,ticker,exchange,name,asset_type,stock_sector,etf_category,country,country_code,isin,aliases
WSE::ABE0227,ABE0227,WSE,Some Issuer 06/27,corp_bond,,,Poland,PL,PL0000000000,`,
        t.db,
      )
      // ABE0227 has the exact shape of a fund category (3 letters + 4 digits).
      // Only the venue column separates them, which is why the tier reads it.
      expect(await priceTierForSymbol(t.db, "ABE0227")).toBe("standard")
    } finally {
      await t.client.close()
    }
  })

  it("an unknown symbol is standard, so behaviour is unchanged before a sync", async () => {
    const t = await createTestDb()
    try {
      expect(await priceTierForSymbol(t.db, "NNEP65.TFI")).toBe("standard")
      expect(await priceTierForSymbol(t.db, "AAPL")).toBe("standard")
    } finally {
      await t.client.close()
    }
  })

  it("classifies a synced category as fund, so the tier and asset class agree", async () => {
    const t = await createTestDb()
    try {
      await syncTickerReference(
        `listing_key,ticker,exchange,name,asset_type,stock_sector,etf_category,country,country_code,isin,aliases
ANALIZY::ING01W,ING01W,ANALIZY,ING Akcji W,fund,,,Poland,PL,,ING01`,
        t.db,
      )
      // Both now come from the same row. Before §78 the tier was a hardcoded set
      // and the asset class an early return in code — two sources for one fact.
      expect(await assetTypeForSymbol(t.db, "ING01W")).toBe("fund")
      expect(await priceTierForSymbol(t.db, "ING01W")).toBe("fund_category")
    } finally {
      await t.client.close()
    }
  })
})
