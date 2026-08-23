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
