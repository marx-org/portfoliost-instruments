import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { like, or, sql } from "drizzle-orm"
import { createTestDb, migrationsFolder } from "../db/test-db.js"
import type { DB } from "../db/index.js"
import { curatedListingOverrides, tickerReference } from "../db/schema.js"
import { parseCsv, parseCsvLine, syncExchangeReference, syncTickerReference } from "../scripts/tickerref-sync.js"

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

describe("tickerref sync purity (plan §40.2)", () => {
  let db: DB
  let close: () => void

  beforeAll(async () => {
    const t = await createTestDb()
    db = t.db
    close = () => t.client.close()
    await syncTickerReference(FIXTURE, db)
  })

  afterAll(() => close())

  it("keeps the upstream adanos aliases untouched for every row (no sheet-compat patch)", async () => {
    // parseCsv + the sync upsert are the only writers — the alias column must
    // equal the fixture value for every listing_key (empty fixture → null).
    const fixture = new Map(parseCsv(FIXTURE).map((r) => [r.listing_key, r.aliases || null]))
    const rows = await db.select().from(tickerReference)
    expect(rows).toHaveLength(fixture.size)
    for (const row of rows) {
      expect(row.aliases).toBe(fixture.get(row.listingKey))
    }
    // the DTLA row ships with no upstream alias — it stays null (the old
    // §24.9 override used to inject "ishares treasury bond 20 yr ucits etf usd a")
    const dtla = rows.find((r) => r.listingKey === "LSE::DTLA")!
    expect(dtla.aliases).toBeNull()
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
  it("upserts crypto pairs idempotently", async () => {
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
      // TFI funds were removed from curated listings (plan §38: resolved via
      // NAME_VENUE_OVERRIDES at the import step, not reference data)
      expect(rows.some((r) => r.listing_key.startsWith("TFI::"))).toBe(false)

      const first = await syncCuratedListings(t.db)
      expect(first).toBe(rows.length)
      const second = await syncCuratedListings(t.db)
      expect(second).toBe(rows.length)

      const { tickerReference } = await import("../db/schema.js")
      const all = await t.db.select().from(tickerReference)
      expect(all).toHaveLength(rows.length)
      const btc = all.find((r) => r.ticker === "BTC")
      expect(btc?.assetType).toBe("crypto")
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

describe("tickerref curated listing overrides", () => {
  it("keeps venue-specific overrides separate from upstream rows", async () => {
    const { syncCuratedListingOverrides } = await import("../scripts/tickerref-sync.js")
    const t = await createTestDb()
    try {
      await syncTickerReference(`${FIXTURE}\nNYSE::MFC,MFC,NYSE,Manulife Financial Corporation,Stock,Financials,,United States,US,,`, t.db)
      const rows = [{
        listingKey: "NYSE::MFC",
        ticker: "MFC",
        exchange: "NYSE",
        quoteCurrency: "USD",
        assetType: "Stock",
        status: "active" as const,
        rationale: "NYSE is USD quoted.",
        provenance: "test",
      }]

      expect(await syncCuratedListingOverrides(t.db, rows)).toBe(1)
      expect(await syncCuratedListingOverrides(t.db, rows)).toBe(1)

      const upstream = await t.db.select().from(tickerReference).where(sql`${tickerReference.listingKey} = 'NYSE::MFC'`)
      const overrides = await t.db.select().from(curatedListingOverrides)
      expect(upstream).toHaveLength(1)
      expect(overrides).toMatchObject([{ listingKey: "NYSE::MFC", quoteCurrency: "USD", provenance: "test" }])
    } finally {
      await t.client.close()
    }
  })
})
