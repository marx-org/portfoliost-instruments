import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { createTestDb } from "../db/test-db.js"
import type { DB } from "../db/index.js"
import { searchTickerReference } from "./tickerref-queries.js"
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
