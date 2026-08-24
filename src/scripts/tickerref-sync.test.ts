import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { like, or, sql } from "drizzle-orm"
import { createTestDb, migrationsFolder } from "../db/test-db.js"
import type { DB } from "../db/index.js"
import { tickerReference } from "../db/schema.js"
import { parseCsv, parseCsvLine, syncExchangeReference, syncTickerReference } from "../scripts/tickerref-sync.js"

const FIXTURE = `listing_key,ticker,exchange,name,asset_type,stock_sector,etf_category,country,country_code,isin,aliases
NASDAQ::AAPL,AAPL,NASDAQ,Apple Inc,Stock,Information Technology,,United States,US,US0378331005,apple
WSE::PKN,PKN,WSE,"Polski Koncern Naftowy ORLEN SA",Stock,Energy,,Poland,PL,PLPKN0000018,polski koncern naftowy orlen|orlen
NASDAQ::QQQ,QQQ,NASDAQ,Invesco QQQ Trust,ETF,,Large Blend,United States,US,US4642854031,qqq trust`

describe("tickerref csv parsing", () => {
  it("parses quoted fields containing commas", () => {
    const row = parseCsvLine(
      'WSE::PKN,PKN,WSE,"Polski Koncern Naftowy ORLEN SA",Stock,Energy,,Poland,PL,PLPKN0000018,x|y',
    )
    expect(row[3]).toBe("Polski Koncern Naftowy ORLEN SA")
    expect(row).toHaveLength(11)
  })

  it("parses the fixture into 3 rows", () => {
    expect(parseCsv(FIXTURE)).toHaveLength(3)
  })
})

describe("tickerref sync + search against PGlite", () => {
  let db: DB
  let close: () => void

  beforeAll(async () => {
    const t = await createTestDb()
    db = t.db
    close = () => t.client.close()
    await syncTickerReference(FIXTURE, db)
  })

  afterAll(() => close())

  it("syncs all rows", async () => {
    const rows = await db.select().from(tickerReference)
    expect(rows).toHaveLength(3)
  })

  it("upserts on re-sync without duplicating", async () => {
    await syncTickerReference(FIXTURE, db)
    const rows = await db.select().from(tickerReference)
    expect(rows).toHaveLength(3)
  })

  it("finds PKN by ticker, name fragment and alias", async () => {
    const byTicker = await db
      .select()
      .from(tickerReference)
      .where(or(like(tickerReference.ticker, "PKN%"), like(tickerReference.aliases, "%pkn%")))
    expect(byTicker).toHaveLength(1)
    expect(byTicker[0].isin).toBe("PLPKN0000018")

    const byName = await db
      .select()
      .from(tickerReference)
      .where(sql`${tickerReference.name} ILIKE ${"%orlen%"}`)
    expect(byName).toHaveLength(1)
  })

  it("finds Apple by alias 'apple'", async () => {
    const rows = await db
      .select()
      .from(tickerReference)
      .where(sql`${tickerReference.aliases} ILIKE ${"%apple%"}`)
    expect(rows).toHaveLength(1)
    expect(rows[0].ticker).toBe("AAPL")
  })
})

const VENUES = `venue_id,exchange_code,operating_mic,segment_mic,canonical_name,country_code,status
v1,WSE,XWAR,,Warsaw Stock Exchange,PL,active
v2,XETRA,XETR,,Deutsche Boerse XETRA,DE,active
v3,UNKNOWN,,,Mystery Exchange,XX,active`

describe("syncExchangeReference", () => {
  it("joins MIC → Yahoo suffix onto venue rows", async () => {
    const { createTestDb } = await import("../db/test-db.js")
    const t = await createTestDb()
    try {
      const { total } = await syncExchangeReference(VENUES, "XWAR: ignored\n\"XWAR\": \"WA\"\n\"XETR\": \"DE\"", t.db)
      void total
      const { exchangeReference } = await import("../db/schema.js")
      const rows = await t.db.select().from(exchangeReference)
      expect(rows).toHaveLength(3)
      const wse = rows.find((r) => r.exchangeCode === "WSE")
      expect(wse).toMatchObject({ yahooSuffix: "WA", operatingMic: "XWAR", canonicalName: "Warsaw Stock Exchange" })
      const unknown = rows.find((r) => r.exchangeCode === "UNKNOWN")
      expect(unknown?.yahooSuffix).toBeNull()
    } finally {
      await t.client.close()
    }
  })

  it("accepts the bundled CSV format for the MIC map too", async () => {
    const { createTestDb } = await import("../db/test-db.js")
    const t = await createTestDb()
    try {
      await syncExchangeReference(VENUES, "operating_mic,yahoo_suffix\nXWAR,WA", t.db)
      const { exchangeReference } = await import("../db/schema.js")
      const rows = await t.db.select().from(exchangeReference)
      expect(rows.find((r) => r.exchangeCode === "WSE")?.yahooSuffix).toBe("WA")
    } finally {
      await t.client.close()
    }
  })
})
