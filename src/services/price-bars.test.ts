import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest"
import { eq, sql } from "drizzle-orm"
import { createTestDb } from "../db/test-db.js"
import type { DB } from "../db/index.js"
import { priceBarMetadata, tickerReference } from "../db/schema.js"
import { LOCAL_PRICE_BARS_SETUP_SQL } from "../db/price-bars.js"
import {
  backgroundUpsertBars,
  checkSplitBoundary,
  cooldownFor,
  describeFailure,
  getPriceBarSeries,
  hasGap,
  isTransientFailure,
  matchSplitFactor,
  normalizeAssetType,
  ohlcvToClose,
  lookupAssetType,
  queryView,
  recentlyFailed,
  stooqTickerFor,
  upstreamFor,
  COOLDOWN_MS,
  TRANSIENT_COOLDOWN_MS,
} from "./price-bars.js"

vi.mock("../adapters/cachest.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../adapters/cachest.js")>()),
  fetchOhlcv: vi.fn(),
  fetchBondOhlcv: vi.fn(),
  fetchCryptoOhlcv: vi.fn(),
}))

import { fetchOhlcv, fetchBondOhlcv, fetchCryptoOhlcv, UpstreamError } from "../adapters/cachest.js"

const mockFetchOhlcv = vi.mocked(fetchOhlcv)
const mockFetchBondOhlcv = vi.mocked(fetchBondOhlcv)
const mockFetchCryptoOhlcv = vi.mocked(fetchCryptoOhlcv)

async function seedStooq(db: DB, symbol: string, rows: Array<[string, string]>) {
  for (const [date, close] of rows) {
    await db.execute(sql.raw(`
      INSERT INTO instruments.stooq_daily_us (ticker, period, date, close)
      VALUES ('${symbol}.US', 'd', '${date}', ${close});
    `))
  }
}

describe("price-bars (H3) service", () => {
  let db: DB
  let client: Awaited<ReturnType<typeof createTestDb>>["client"]

  beforeAll(async () => {
    const t = await createTestDb()
    db = t.db
    client = t.client
    for (const stmt of LOCAL_PRICE_BARS_SETUP_SQL) {
      await db.execute(sql.raw(stmt))
    }
  })

  afterAll(async () => {
    await client.close()
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it("queryView orders stooq ahead of openst for an overlapping date (deterministic)", async () => {
    await seedStooq(db, "AAPL", [["2026-07-29", "230.50000000000000"]])
    await db.execute(sql.raw(`
      INSERT INTO instruments.price_bars (symbol, date, close, source)
      VALUES ('AAPL', '2026-07-29', 338.19000000, 'openst');
    `))
    const rows = await queryView(db, "AAPL", "2026-07-29", "2026-07-29")
    expect(rows.map((r) => [r.date, Number(r.close), r.source])).toEqual([
      ["2026-07-29", 230.5, "stooq"],
      ["2026-07-29", 338.19, "openst"],
    ])
  })

  it("queryView unifies stooq and overflow rows into an ordered series", async () => {
    await seedStooq(db, "AAPL", [["2026-01-02", "200.00000000"], ["2026-01-05", "205.00000000"]])
    await db.execute(sql.raw(`
      INSERT INTO instruments.price_bars (symbol, date, close, source)
      VALUES ('AAPL', '2026-01-06', 210.00000000, 'openst');
    `))
    const rows = await queryView(db, "AAPL", "2026-01-01", "2026-01-31")
    expect(rows.map((r) => [r.date, Number(r.close)])).toEqual([
      ["2026-01-02", 200],
      ["2026-01-05", 205],
      ["2026-01-06", 210],
    ])
  })

  it("hasGap flakes only beyond the tolerance", () => {
    const now = new Date("2026-07-10T00:00:00Z")
    expect(hasGap("2026-07-09", now)).toBe(false) // 1 day
    expect(hasGap("2026-07-07", now)).toBe(false) // 3 days (weekend-tolerant floor)
    expect(hasGap("2026-07-06", now)).toBe(true) // 4 days
  })

  it("recentlyFailed honors the one-hour cooldown", () => {
    const now = new Date("2026-07-10T12:00:00Z")
    const freshFail = { lastFetchedAt: new Date("2026-07-10T11:30:00Z"), fetchStatus: "failed" }
    const oldFail = { lastFetchedAt: new Date("2026-07-10T10:00:00Z"), fetchStatus: "failed" }
    const ok = { lastFetchedAt: new Date("2026-07-10T11:30:00Z"), fetchStatus: "ok" }
    expect(recentlyFailed(freshFail, now)).toBe(true)
    expect(recentlyFailed(oldFail, now)).toBe(false)
    expect(recentlyFailed(ok, now)).toBe(false)
    expect(recentlyFailed(undefined, now)).toBe(false)
  })

  it("getPriceBarSeries returns fresh series with stale=false when last date is recent", async () => {
    // stooq data ending yesterday → not stale
    await seedStooq(db, "MSFT", [["2026-07-09", "410.00000000"]])
    mockFetchOhlcv.mockResolvedValue([])
    const now = new Date("2026-07-10T00:00:00Z")
    const res = await getPriceBarSeries(db, "MSFT", "2026-07-01", "2026-07-10", now)
    expect(res.stale).toBe(false)
    expect(res.dates).toEqual(["2026-07-09"])
    expect(mockFetchOhlcv).not.toHaveBeenCalled()
  })

  it("getPriceBarSeries fetches missing days and writes them to overflow", async () => {
    await seedStooq(db, "GOOG", [["2026-06-01", "150.00000000"]])
    mockFetchOhlcv.mockResolvedValue([
      { date: "2026-07-08", close: 175.0 },
      { date: "2026-07-09", close: 176.5 },
    ])
    const now = new Date("2026-07-10T00:00:00Z")
    const res = await getPriceBarSeries(db, "GOOG", "2026-06-01", "2026-07-10", now)
    expect(res.stale).toBe(false)
    expect(res.closes).toEqual([150, 175, 176.5])
    // persisted to overflow
    const persisted = await db.execute(sql`
      select date from instruments.price_bars where symbol = 'GOOG' order by date
    `)
    expect((persisted.rows as Array<{ date: string }>).map((r) => r.date)).toEqual([
      "2026-07-08",
      "2026-07-09",
    ])
    // metadata marked ok
    const meta = await db.select().from(priceBarMetadata).where(sql`symbol = 'GOOG'`)
    expect(meta[0].fetchStatus).toBe("ok")
    // fetchOhlcv called with provider symbol (bare "GOOG"), not stooq ticker ("GOOG.US")
    expect(mockFetchOhlcv).toHaveBeenCalledWith("GOOG", expect.any(String), expect.any(String))
  })

  it("cold savings bonds gap-fill through the bond tier, never the equity walk (plan §37.1)", async () => {
    // ROD1035 is not in ticker_reference and has no price_bars row (fresh
    // after the openst bond import) — the gap fill must go straight to
    // fetchBondOhlcv, not degrade to stock and probe the equity providers.
    mockFetchBondOhlcv.mockResolvedValue([
      { date: "2026-07-08", close: 102.4 },
      { date: "2026-07-09", close: 102.42 },
    ])
    const now = new Date("2026-07-10T00:00:00Z")
    const res = await getPriceBarSeries(db, "ROD1035", "2026-07-01", "2026-07-10", now)
    expect(res.stale).toBe(false)
    expect(res.closes).toEqual([102.4, 102.42])
    // persisted to overflow with fetchStatus ok
    const persisted = await db.execute(sql`
      select date from instruments.price_bars where symbol = 'ROD1035' order by date
    `)
    expect((persisted.rows as Array<{ date: string }>).map((r) => r.date)).toEqual([
      "2026-07-08",
      "2026-07-09",
    ])
    const meta = await db.select().from(priceBarMetadata).where(sql`symbol = 'ROD1035'`)
    expect(meta[0].fetchStatus).toBe("ok")
    // bond tier only — the equity tier must never be probed for an emission
    expect(mockFetchBondOhlcv).toHaveBeenCalledWith("ROD1035", expect.any(String), expect.any(String))
    expect(mockFetchOhlcv).not.toHaveBeenCalled()
    expect(mockFetchCryptoOhlcv).not.toHaveBeenCalled()
  })

  it("serves stale data without fetching when a fetch failed within the hour", async () => {    await seedStooq(db, "NFLX", [["2026-06-01", "600.00000000"]])
    mockFetchOhlcv.mockRejectedValue(new UpstreamError("http://cachest/ohlcv/NFLX", 404))
    const t1 = new Date("2026-07-10T12:00:00Z")
    await getPriceBarSeries(db, "NFLX", "2026-06-01", "2026-07-10", t1) // triggers failing fetch
    const t2 = new Date("2026-07-10T12:30:00Z")
    const res = await getPriceBarSeries(db, "NFLX", "2026-06-01", "2026-07-10", t2)
    expect(res.stale).toBe(true)
    expect(res.closes).toEqual([600])
    // still only one upstream attempt
    expect(mockFetchOhlcv).toHaveBeenCalledTimes(1)
  })

  // --- §63.9.2: a transient failure must not park the symbol for an hour ----

  it("records the upstream status in last_error", async () => {
    await seedStooq(db, "AMZN", [["2026-06-01", "180.00000000"]])
    mockFetchOhlcv.mockRejectedValue(new UpstreamError("http://cachest/ohlcv/AMZN", 503))
    await getPriceBarSeries(db, "AMZN", "2026-06-01", "2026-07-10", new Date("2026-07-10T12:00:00Z"))
    const [meta] = await db.select().from(priceBarMetadata).where(eq(priceBarMetadata.symbol, "AMZN"))
    expect(meta.fetchStatus).toBe("failed")
    // cachest's rate limiter answers 503 without ever calling the provider, so the
    // status is the only thing that distinguishes "we lost a race" from "no data"
    expect(meta.lastError).toContain("HTTP 503")
  })

  it("retries a transient 503 after minutes, not an hour", async () => {
    await seedStooq(db, "NVDA", [["2026-06-01", "120.00000000"]])
    mockFetchOhlcv
      .mockRejectedValueOnce(new UpstreamError("http://cachest/ohlcv/NVDA", 503))
      .mockResolvedValue([{ date: "2026-07-09", close: 125.0 }])
    const t1 = new Date("2026-07-10T12:00:00Z")
    await getPriceBarSeries(db, "NVDA", "2026-06-01", "2026-07-10", t1)
    // 6 minutes later: past the transient cooldown, far short of the hourly one
    const t2 = new Date("2026-07-10T12:06:00Z")
    const res = await getPriceBarSeries(db, "NVDA", "2026-06-01", "2026-07-10", t2)
    expect(mockFetchOhlcv).toHaveBeenCalledTimes(2)
    expect(res.stale).toBe(false)
    expect(res.closes).toContain(125)
    const [meta] = await db.select().from(priceBarMetadata).where(eq(priceBarMetadata.symbol, "NVDA"))
    expect(meta.fetchStatus).toBe("ok")
    expect(meta.lastError).toBeNull()
  })

  it("keeps the hour-long breaker for a 404 (no such history upstream)", async () => {
    await seedStooq(db, "TSLA", [["2026-06-01", "300.00000000"]])
    mockFetchOhlcv.mockRejectedValue(new UpstreamError("http://cachest/ohlcv/TSLA", 404))
    const t1 = new Date("2026-07-10T12:00:00Z")
    await getPriceBarSeries(db, "TSLA", "2026-06-01", "2026-07-10", t1)
    const t2 = new Date("2026-07-10T12:30:00Z")
    await getPriceBarSeries(db, "TSLA", "2026-06-01", "2026-07-10", t2)
    expect(mockFetchOhlcv).toHaveBeenCalledTimes(1)
  })

  it("classifies failures: only an upstream 404 earns the hourly breaker", () => {
    expect(isTransientFailure(new UpstreamError("u", 503))).toBe(true)
    expect(isTransientFailure(new UpstreamError("u", 429))).toBe(true)
    expect(isTransientFailure(new UpstreamError("u", 502))).toBe(true)
    expect(isTransientFailure(new UpstreamError("u", 504))).toBe(true)
    expect(isTransientFailure(new Error("fetch failed"))).toBe(true)
    expect(isTransientFailure(new SyntaxError("Unexpected token"))).toBe(true)
    expect(isTransientFailure(new UpstreamError("u", 404))).toBe(false)
    expect(cooldownFor("HTTP 404 upstream 404 for u")).toBe(COOLDOWN_MS)
    expect(cooldownFor("HTTP 503 upstream 503 for u")).toBe(TRANSIENT_COOLDOWN_MS)
    expect(cooldownFor(null)).toBe(TRANSIENT_COOLDOWN_MS)
  })

  it("bounds and formats last_error", () => {
    expect(describeFailure(new UpstreamError("http://x/y", 503))).toContain("HTTP 503")
    const long = describeFailure(new Error("x".repeat(5000)))
    expect(long.length).toBeLessThanOrEqual(300)
  })

  it("detects a reverse split at the boundary and records a candidate", async () => {
    await seedStooq(db, "RHM", [["2026-01-02", "100.00000000"]]) // last stooq
    // overflow first write shows a 2:1 split price (half)
    await db.execute(sql.raw(`
      INSERT INTO instruments.price_bars (symbol, date, close, source)
      VALUES ('RHM', '2026-01-03', 50.00000000, 'openst');
    `))
    await checkSplitBoundary(db, "RHM", "RHM.US")
    const candidates = await db.execute(sql`
      select suggested_factor, suggested_ratio from instruments.split_candidates where symbol = 'RHM'
    `)
    expect(Number(candidates.rows[0]?.suggested_factor)).toBeCloseTo(0.5, 4)
  })

  it("does not record a candidate when the boundary is continuous", async () => {
    await seedStooq(db, "ORCL", [["2026-01-02", "100.00000000"]])
    await db.execute(sql.raw(`
      INSERT INTO instruments.price_bars (symbol, date, close, source)
      VALUES ('ORCL', '2026-01-03', 101.00000000, 'openst');
    `))
    await checkSplitBoundary(db, "ORCL", "ORCL.US")
    const rows = await db.execute(sql`
      select count(*)::int as n from instruments.split_candidates where symbol = 'ORCL'
    `)
    expect(rows.rows[0].n).toBe(0)
  })
})

describe("backgroundUpsertBars (H4)", () => {
  let db: DB
  let client: Awaited<ReturnType<typeof createTestDb>>["client"]

  beforeAll(async () => {
    const t = await createTestDb()
    db = t.db
    client = t.client
    for (const stmt of LOCAL_PRICE_BARS_SETUP_SQL) {
      await db.execute(sql.raw(stmt))
    }
  })

  afterAll(async () => {
    await client.close()
  })

  it("persists daily close bars into price_bars from an OHLCV response", async () => {
    backgroundUpsertBars(db, "TSLA", [
      { date: "2026-08-01", close: 210.5 },
      { date: "2026-08-04", close: 215.0 },
    ])
    // give the async write a tick to complete
    await new Promise((r) => setTimeout(r, 50))
    const result = await db.execute(sql`
      select date, close from instruments.price_bars
      where symbol = 'TSLA' order by date
    `)
    const rows = (result.rows ?? result) as Array<{ date: string; close: string }>
    expect(rows.map((r) => [r.date, Number(r.close)])).toEqual([
      ["2026-08-01", 210.5],
      ["2026-08-04", 215.0],
    ])
  })

  it("is idempotent — duplicate rows update close in place", async () => {
    backgroundUpsertBars(db, "TSLA", [{ date: "2026-08-01", close: 211.0 }])
    await new Promise((r) => setTimeout(r, 50))
    const result = await db.execute(sql`
      select close from instruments.price_bars
      where symbol = 'TSLA' and date = '2026-08-01'
    `)
    const rows = (result.rows ?? result) as Array<{ close: string }>
    expect(Number(rows[0]?.close)).toBe(211.0)
  })

  it("silently skips rows with invalid dates or closes", async () => {
    // should not throw
    backgroundUpsertBars(db, "TSLA", [
      { date: "bad-date", close: 100 },
      { date: "2026-08-05", close: NaN },
    ])
    await new Promise((r) => setTimeout(r, 50))
    const result = await db.execute(sql`
      select count(*)::int as n from instruments.price_bars where symbol = 'TSLA'
    `)
    const rows = (result.rows ?? result) as Array<{ n: number }>
    // still only the 2 rows from first test (+ idempotent update), no new rows
    expect(rows[0]?.n).toBe(2)
  })
})

describe("stooqTickerFor (H9)", () => {
  it("appends .US to a bare US symbol", () => {
    expect(stooqTickerFor("AAPL")).toBe("AAPL.US")
  })
  it("strips existing suffix and re-appends .US", () => {
    // non-US symbols routed through stooq US table still get .US for overflow fetch
    expect(stooqTickerFor("AAPL.US")).toBe("AAPL.US")
  })
  it("lowercases input before formatting", () => {
    expect(stooqTickerFor("msft")).toBe("MSFT.US")
  })
})

describe("ohlcvToClose (H9)", () => {
  it("converts a valid OHLCV row to a close bar", () => {
    expect(ohlcvToClose({ date: "2026-07-10", close: 123.456 })).toEqual({
      date: "2026-07-10",
      close: "123.45600000",
    })
  })
  it("uses index field as date fallback", () => {
    const result = ohlcvToClose({ index: "2026-07-10T00:00:00Z", close: 50 })
    expect(result?.date).toBe("2026-07-10")
  })
  it("returns null for a bad date", () => {
    expect(ohlcvToClose({ date: "not-a-date", close: 100 })).toBeNull()
  })
  it("returns null for NaN close", () => {
    expect(ohlcvToClose({ date: "2026-07-10", close: "abc" })).toBeNull()
  })
})

describe("matchSplitFactor (H9)", () => {
  it("recognises clean 2:1 split (price halved, ratio=0.5)", () => {
    expect(matchSplitFactor(0.5)).toBeCloseTo(0.5, 4)
  })
  it("recognises clean 4:1 split (ratio=0.25)", () => {
    expect(matchSplitFactor(0.25)).toBeCloseTo(0.25, 4)
  })
  it("recognises reverse 1:2 split (ratio=2)", () => {
    expect(matchSplitFactor(2)).toBeCloseTo(2, 4)
  })
  it("returns null for an ambiguous ratio", () => {
    expect(matchSplitFactor(0.6)).toBeNull()
  })
  it("returns null for a continuous price (ratio near 1)", () => {
    expect(matchSplitFactor(1.02)).toBeNull()
  })
})

describe("checkSplitBoundary — ambiguous ratio (H9)", () => {
  let db: DB
  let client: Awaited<ReturnType<typeof createTestDb>>["client"]

  beforeAll(async () => {
    const t = await createTestDb()
    db = t.db
    client = t.client
    for (const stmt of LOCAL_PRICE_BARS_SETUP_SQL) {
      await db.execute(sql.raw(stmt))
    }
  })
  afterAll(async () => { await client.close() })

  it("records a candidate with suggested_factor=NULL for an ambiguous ratio", async () => {
    // ratio = 55 / 100 = 0.55 — outside 0.85–1.15, doesn't match a clean split factor
    await db.execute(sql.raw(`
      INSERT INTO instruments.stooq_daily_us (ticker, period, date, close)
      VALUES ('AMB.US', 'd', '2026-01-10', 100.00000000);
    `))
    await db.execute(sql.raw(`
      INSERT INTO instruments.price_bars (symbol, date, close, source)
      VALUES ('AMB', '2026-01-11', 55.00000000, 'openst');
    `))
    await checkSplitBoundary(db, "AMB", "AMB.US")
    const rows = await db.execute(sql`
      SELECT suggested_factor, suggested_ratio
      FROM instruments.split_candidates WHERE symbol = 'AMB'
    `)
    const r = (rows.rows ?? rows) as Array<{ suggested_factor: string | null; suggested_ratio: string }>
    expect(r).toHaveLength(1)
    expect(r[0].suggested_factor).toBeNull()
    expect(Number(r[0].suggested_ratio)).toBeCloseTo(0.55, 3)
  })

  it("does not record a candidate when ratio is within 0.85–1.15", async () => {
    await db.execute(sql.raw(`
      INSERT INTO instruments.stooq_daily_us (ticker, period, date, close)
      VALUES ('CONT.US', 'd', '2026-01-10', 100.00000000);
    `))
    await db.execute(sql.raw(`
      INSERT INTO instruments.price_bars (symbol, date, close, source)
      VALUES ('CONT', '2026-01-11', 103.00000000, 'openst');
    `))
    await checkSplitBoundary(db, "CONT", "CONT.US")
    const rows = await db.execute(sql`
      SELECT count(*)::int AS n FROM instruments.split_candidates WHERE symbol = 'CONT'
    `)
    const r = (rows.rows ?? rows) as Array<{ n: number }>
    expect(r[0].n).toBe(0)
  })
})

describe("getPriceBarSeries — carry-forward (H9)", () => {
  let db: DB
  let client: Awaited<ReturnType<typeof createTestDb>>["client"]

  beforeAll(async () => {
    const t = await createTestDb()
    db = t.db
    client = t.client
    for (const stmt of LOCAL_PRICE_BARS_SETUP_SQL) {
      await db.execute(sql.raw(stmt))
    }
    // Seed CARRY: stooq has Mon + Thu; Tue/Wed are gaps
    await db.execute(sql.raw(`
      INSERT INTO instruments.stooq_daily_us (ticker, period, date, close) VALUES
        ('CARRY.US', 'd', '2026-07-06', 100.00000000),
        ('CARRY.US', 'd', '2026-07-09', 105.00000000);
    `))
  })
  afterAll(async () => { await client.close() })

  it("returns only trading days (no carry-forward in the view — gaps are real gaps)", async () => {
    // The view returns only rows that exist — carry-forward is the consumer's job.
    // This test verifies the view doesn't invent rows for missing dates.
    const rows = await queryView(db, "CARRY", "2026-07-06", "2026-07-09")
    expect(rows.map((r) => r.date)).toEqual(["2026-07-06", "2026-07-09"])
    // No invented rows for Jul 7/8
    expect(rows).toHaveLength(2)
  })
})

describe("D81 — asset-class routing in price-bars", () => {
  let db: DB
  let client: Awaited<ReturnType<typeof createTestDb>>["client"]

  const ref = (ticker: string, assetType: string, exchange = "WSE") =>
    db.insert(tickerReference).values({
      listingKey: `${exchange}::${ticker}`,
      ticker,
      exchange,
      name: ticker,
      assetType,
    })

  beforeAll(async () => {
    const t = await createTestDb()
    db = t.db
    client = t.client
    for (const stmt of LOCAL_PRICE_BARS_SETUP_SQL) {
      await db.execute(sql.raw(stmt))
    }
  })
  afterAll(async () => {
    await client.close()
  })
  afterEach(() => {
    vi.clearAllMocks()
  })

  it("normalizeAssetType maps stored asset types to the routing set", () => {
    expect(normalizeAssetType("Stock")).toBe("stock")
    expect(normalizeAssetType("ETF")).toBe("etf")
    expect(normalizeAssetType("CRYPTO")).toBe("crypto")
    expect(normalizeAssetType("BOND")).toBe("bond")
    expect(normalizeAssetType("corp_bond")).toBe("corp_bond")
    expect(normalizeAssetType("corporate bond")).toBe("corp_bond")
    expect(normalizeAssetType(null)).toBe("stock")
    expect(normalizeAssetType("")).toBe("stock")
    expect(normalizeAssetType("something-else")).toBe("stock")
  })

  it("upstreamFor routes crypto to the crypto OHLCV pair", async () => {
    mockFetchCryptoOhlcv.mockResolvedValue([])
    await upstreamFor("crypto", "BTC-USD", "2026-01-01", "2026-01-31")
    expect(mockFetchCryptoOhlcv).toHaveBeenCalledWith("BTC-USD", "2026-01-01", "2026-01-31")
    expect(mockFetchOhlcv).not.toHaveBeenCalled()
    expect(mockFetchBondOhlcv).not.toHaveBeenCalled()
  })

  it("upstreamFor routes bond to the fixedincome OHLCV (venue-free symbol)", async () => {
    mockFetchBondOhlcv.mockResolvedValue([])
    await upstreamFor("bond", "ROD1033.WA", "2026-01-01", "2026-01-31")
    expect(mockFetchBondOhlcv).toHaveBeenCalledWith("ROD1033", "2026-01-01", "2026-01-31")
    expect(mockFetchOhlcv).not.toHaveBeenCalled()
  })

  it("upstreamFor routes corp_bond and fund through the equity OHLCV path", async () => {
    mockFetchOhlcv.mockResolvedValue([])
    await upstreamFor("corp_bond", "BST0327.WA", "2026-01-01", "2026-01-31")
    expect(mockFetchOhlcv).toHaveBeenCalledWith("BST0327.WA", "2026-01-01", "2026-01-31")
    vi.clearAllMocks()
    await upstreamFor("fund", "NNEP25.TFI", "2026-01-01", "2026-01-31")
    expect(mockFetchOhlcv).toHaveBeenCalledWith("NNEP25.TFI", "2026-01-01", "2026-01-31")
  })

  it("upstreamFor routes stock/etf through the equity OHLCV path (.US stripped)", async () => {
    mockFetchOhlcv.mockResolvedValue([])
    await upstreamFor("stock", "AAPL", "2026-01-01", "2026-01-31")
    expect(mockFetchOhlcv).toHaveBeenCalledWith("AAPL", "2026-01-01", "2026-01-31")
    vi.clearAllMocks()
    await upstreamFor("etf", "AAPL.US", "2026-01-01", "2026-01-31")
    expect(mockFetchOhlcv).toHaveBeenCalledWith("AAPL", "2026-01-01", "2026-01-31")
  })

  it("lookupAssetType resolves the bare ticker (venue-qualified input) from the reference table", async () => {
    await ref("LBST001", "corp_bond")
    expect(await lookupAssetType(db, "LBST001")).toBe("corp_bond")
    expect(await lookupAssetType(db, "lbst001.wa")).toBe("corp_bond")
    expect(await lookupAssetType(db, "ZZZ9999")).toBeNull()
  })

  it("getPriceBarSeries fetches a crypto series via crypto/ohlcv (stooq skipped, no split check)", async () => {
    await ref("BTC-USD", "CRYPTO", "CCC")
    mockFetchCryptoOhlcv.mockResolvedValue([
      { date: "2026-07-08", close: 60000 },
      { date: "2026-07-09", close: 61500 },
    ])
    const now = new Date("2026-07-10T00:00:00Z")
    const res = await getPriceBarSeries(db, "BTC-USD", "2026-07-01", "2026-07-10", now)
    expect(res.stale).toBe(false)
    expect(res.closes).toEqual([60000, 61500])
    // §36 — crypto pair currency resolved from the pair form
    expect(res.currency).toBe("USD")
    expect(mockFetchCryptoOhlcv).toHaveBeenCalledTimes(1)
    expect(mockFetchOhlcv).not.toHaveBeenCalled()
    // crypto bars persisted to overflow under the system symbol
    const persisted = await db.execute(sql`
      select date, close from instruments.price_bars where symbol = 'BTC-USD' order by date
    `)
    expect((persisted.rows as Array<{ date: string }>).map((r) => r.date)).toEqual([
      "2026-07-08",
      "2026-07-09",
    ])
  })

  it("getPriceBarSeries fetches a bond series via fixedincome/ohlcv (venue-free)", async () => {
    await ref("ROD1033", "BOND")
    mockFetchBondOhlcv.mockResolvedValue([{ date: "2026-07-09", close: 104.2 }])
    const now = new Date("2026-07-10T00:00:00Z")
    const res = await getPriceBarSeries(db, "ROD1033", "2026-07-01", "2026-07-10", now)
    expect(res.stale).toBe(false)
    expect(res.closes).toEqual([104.2])
    // §36 — savings bonds are priced in PLN
    expect(res.currency).toBe("PLN")
    expect(mockFetchBondOhlcv).toHaveBeenCalledWith("ROD1033", expect.any(String), expect.any(String))
    expect(mockFetchOhlcv).not.toHaveBeenCalled()
  })

  it("getPriceBarSeries fetches a corp_bond series via the equity ohlcv path (no stooq split check)", async () => {
    await ref("LBST201", "corp_bond")
    mockFetchOhlcv.mockResolvedValue([{ date: "2026-07-09", close: 101.5 }])
    const now = new Date("2026-07-10T00:00:00Z")
    const res = await getPriceBarSeries(db, "LBST201", "2026-07-01", "2026-07-10", now)
    expect(res.stale).toBe(false)
    expect(res.closes).toEqual([101.5])
    // §36 — Catalyst corp bonds are priced in PLN
    expect(res.currency).toBe("PLN")
    // corp_bond must NOT consult stooq or record a split candidate
    const candidates = await db.execute(sql`
      select count(*)::int as n from instruments.split_candidates where symbol = 'LBST201'
    `)
    expect(candidates.rows[0].n).toBe(0)
    expect(mockFetchOhlcv).toHaveBeenCalledWith("LBST201", expect.any(String), expect.any(String))
  })

  it("getPriceBarSeries keeps the stooq split-boundary path for a listed stock", async () => {
    await ref("MSFT", "Stock", "NASDAQ")
    mockFetchOhlcv.mockResolvedValue([{ date: "2026-07-09", close: 412 }])
    const now = new Date("2026-07-10T00:00:00Z")
    const res = await getPriceBarSeries(db, "MSFT", "2026-07-01", "2026-07-10", now)
    expect(res.stale).toBe(false)
    expect(res.closes).toEqual([412])
    expect(mockFetchOhlcv).toHaveBeenCalledWith("MSFT", expect.any(String), expect.any(String))
  })

  it("getPriceBarSeries falls back to stock when the symbol is unlisted (regression)", async () => {
    // no ticker_reference row for PLXQ → equity path unchanged
    mockFetchOhlcv.mockResolvedValue([{ date: "2026-07-09", close: 999 }])
    const now = new Date("2026-07-10T00:00:00Z")
    const res = await getPriceBarSeries(db, "PLXQ", "2026-07-01", "2026-07-10", now)
    expect(res.stale).toBe(false)
    expect(res.closes).toEqual([999])
    expect(mockFetchOhlcv).toHaveBeenCalledWith("PLXQ", expect.any(String), expect.any(String))
    expect(mockFetchCryptoOhlcv).not.toHaveBeenCalled()
    expect(mockFetchBondOhlcv).not.toHaveBeenCalled()
  })
})