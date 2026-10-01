import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { createTestDb } from "../db/test-db.js"
import type { DB } from "../db/index.js"
import { searchTickerReference, referenceTickerKeys, assetTypeForSymbol } from "./tickerref-queries.js"
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

describe("assetTypeForSymbol — fund categories route to the fund tier (plan §72.39)", () => {
  it("classifies a category code as fund even when absent from ticker_reference", async () => {
    const t = await createTestDb()
    try {
      await syncTickerReference(
        `listing_key,ticker,exchange,name,asset_type,stock_sector,etf_category,country,country_code,isin,aliases
NASDAQ::AAPL,AAPL,NASDAQ,Apple Inc,Stock,Information Technology,,United States,US,US0378331005,apple`,
        t.db,
      )
      // The provider's own category keys are in no reference table, but they must
      // classify as fund — never degrade to stock and pay the equity walk, which
      // returns `200 / bars=0` for them and looks like a live-but-empty series.
      expect(await assetTypeForSymbol(t.db, "ING01W")).toBe("fund")
      expect(await assetTypeForSymbol(t.db, "ing01w")).toBe("fund")
      expect(await assetTypeForSymbol(t.db, "ING92")).toBe("fund")
      // Bonds still classify as bonds — the two recognisers are ordered.
      expect(await assetTypeForSymbol(t.db, "ROD1035")).toBe("bond")
      // And a real reference row is untouched.
      expect(await assetTypeForSymbol(t.db, "AAPL")).toBe("Stock")
    } finally {
      await t.client.close()
    }
  })

  it("leaves an unverified category-shaped code unresolved, so it 404s loudly", async () => {
    const t = await createTestDb()
    try {
      // ING01A is a plausible guess and is 404 upstream. Not admitting it keeps
      // the list honest: an entry is added only after the source resolves it.
      for (const code of ["ING01A", "ING01K", "ING01S"]) {
        expect(await assetTypeForSymbol(t.db, code), code).toBeNull()
      }
    } finally {
      await t.client.close()
    }
  })
})
