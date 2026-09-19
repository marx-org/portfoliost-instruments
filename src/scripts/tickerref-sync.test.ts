import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { like, or, sql } from "drizzle-orm"
import { createTestDb, migrationsFolder } from "../db/test-db.js"
import type { DB } from "../db/index.js"
import { tickerReference } from "../db/schema.js"
import { parseCsv, parseCsvLine, syncExchangeReference, syncTickerReference, applyAliasOverrides, ALIAS_OVERRIDES } from "../scripts/tickerref-sync.js"

const FIXTURE = `listing_key,ticker,exchange,name,asset_type,stock_sector,etf_category,country,country_code,isin,aliases
NASDAQ::AAPL,AAPL,NASDAQ,Apple Inc,Stock,Information Technology,,United States,US,US0378331005,apple
WSE::PKN,PKN,WSE,"Polski Koncern Naftowy ORLEN SA",Stock,Energy,,Poland,PL,PLPKN0000018,polski koncern naftowy orlen|orlen
NASDAQ::QQQ,QQQ,NASDAQ,Invesco QQQ Trust,ETF,,Large Blend,United States,US,US4642854031,qqq trust
LSE::DTLA,DTLA,LSE,iShares $ Treasury Bond 20+yr UCITS ETF USD (Acc),ETF,,Fixed Income,Ireland,IE,IE00BFM6TC58,`

describe("tickerref csv parsing", () => {
  it("parses quoted fields containing commas", () => {
    const row = parseCsvLine(
      'WSE::PKN,PKN,WSE,"Polski Koncern Naftowy ORLEN SA",Stock,Energy,,Poland,PL,PLPKN0000018,x|y',
    )
    expect(row[3]).toBe("Polski Koncern Naftowy ORLEN SA")
    expect(row).toHaveLength(11)
  })

  it("parses the fixture into 4 rows", () => {
    expect(parseCsv(FIXTURE)).toHaveLength(4)
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
    expect(rows).toHaveLength(4)
  })

  it("upserts on re-sync without duplicating", async () => {
    await syncTickerReference(FIXTURE, db)
    const rows = await db.select().from(tickerReference)
    expect(rows).toHaveLength(4)
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

describe("tickerref alias overrides (plan §24.9)", () => {
  let db: DB
  let close: () => void

  beforeAll(async () => {
    const t = await createTestDb()
    db = t.db
    close = () => t.client.close()
    await syncTickerReference(FIXTURE, db)
  })

  afterAll(() => close())

  it("updates only rows the upstream data provides", async () => {
    const applied = await applyAliasOverrides(db)
    expect(applied).toBe(1)
    const rows = await db.select().from(tickerReference)
    expect(rows).toHaveLength(4)
    const dtla = rows.find((r) => r.listingKey === "LSE::DTLA")!
    expect(dtla.aliases).toBe(ALIAS_OVERRIDES["LSE::DTLA"])
  })

  it("re-applies after an upstream re-sync resets aliases", async () => {
    await syncTickerReference(FIXTURE, db)
    let dtla = (await db.select().from(tickerReference)).find((r) => r.listingKey === "LSE::DTLA")!
    expect(dtla.aliases).toBeNull()
    await applyAliasOverrides(db)
    dtla = (await db.select().from(tickerReference)).find((r) => r.listingKey === "LSE::DTLA")!
    expect(dtla.aliases).toBe(ALIAS_OVERRIDES["LSE::DTLA"])
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

describe("tickerref curated listings (plan 34.5)", () => {
  it("upserts crypto pairs + TFI funds idempotently", async () => {
    const { syncCuratedListings, curatedListingRows } = await import("../scripts/tickerref-sync.js")
    const t = await createTestDb()
    try {
      const rows = curatedListingRows()
      expect(rows.find((r) => r.listing_key === "CRYPTO::BTC")).toMatchObject({
        ticker: "BTC",
        asset_type: "crypto",
        exchange: "CRYPTO",
      })
      // matic + pol both price via POL-USD but stay separate rows
      expect(rows.filter((r) => r.name === "POL-USD")).toHaveLength(2)
      expect(new Set(rows.map((r) => r.listing_key)).size).toBe(rows.length)
      expect(rows.find((r) => r.listing_key === "TFI::NNEP25")).toMatchObject({
        ticker: "NNEP25",
        asset_type: "fund",
        exchange: "GPW",
      })

      const first = await syncCuratedListings(t.db)
      expect(first).toBe(rows.length)
      const second = await syncCuratedListings(t.db)
      expect(second).toBe(rows.length)

      const { tickerReference } = await import("../db/schema.js")
      const all = await t.db.select().from(tickerReference)
      expect(all).toHaveLength(rows.length)
      const btc = all.find((r) => r.ticker === "BTC")
      expect(btc?.assetType).toBe("crypto")
      const fund = all.find((r) => r.ticker === "NNEP25")
      expect(fund?.assetType).toBe("fund")
    } finally {
      await t.client.close()
    }
  })

  it("does not clobber upstream rows sharing a ticker (upsert keyed on listing_key)", async () => {
    const { syncCuratedListings } = await import("../scripts/tickerref-sync.js")
    const t = await createTestDb()
    try {
      await syncTickerReference(FIXTURE, t.db)
      await syncCuratedListings(t.db)
      const all = await t.db.select().from(tickerReference)
      const aapl = all.filter((r) => r.ticker === "AAPL")
      expect(aapl).toHaveLength(1)
      expect(aapl[0].listingKey).toBe("NASDAQ::AAPL")
    } finally {
      await t.client.close()
    }
  })
})
