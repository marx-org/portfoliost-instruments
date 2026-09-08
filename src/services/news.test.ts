import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest"
import { createTestDb } from "../db/test-db.js"
import type { DB } from "../db/index.js"
import { newsArticles } from "../db/schema.js"
import {
  floorWatermark,
  getNewsForTicker,
  getNewsStats,
  newsExpiryDays,
  newsFetchLimit,
  newsGranularityHours,
  newsTicker,
  syncStartDate,
} from "./news.js"

vi.mock("../adapters/cachest.js", () => ({
  fetchCompanyNews: vi.fn(),
  translateCompanyNewsList: vi.fn(),
}))
vi.mock("../adapters/symbol.js", () => ({
  providerSymbol: (s: string) => (s.toUpperCase().endsWith(".US") ? s.toUpperCase().slice(0, -3) : s.toUpperCase()),
}))

import { fetchCompanyNews, translateCompanyNewsList } from "../adapters/cachest.js"

const mockFetch = vi.mocked(fetchCompanyNews)
const mockTranslate = vi.mocked(translateCompanyNewsList)

const NOW = new Date("2026-09-08T12:00:00Z")

function rawArticle(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    date: "2026-09-08T08:30:00Z",
    title: "Apple unveils new chip",
    text: "AAPL details",
    url: "https://example.com/1",
    symbols: ["AAPL"],
    source: "polygon",
    ...over,
  }
}

describe("news service helpers", () => {
  it("newsTicker strips .US but keeps other venue suffixes", () => {
    expect(newsTicker("AAPL.US")).toBe("AAPL")
    expect(newsTicker("AAPL")).toBe("AAPL")
    expect(newsTicker("SNT.WA")).toBe("SNT.WA")
  })

  it("floorWatermark rounds down to the hour bucket", () => {
    expect(floorWatermark(new Date("2026-09-08T09:37:42Z"), 1)?.toISOString()).toBe(
      "2026-09-08T09:00:00.000Z",
    )
    expect(floorWatermark(new Date("2026-09-08T09:00:00Z"), 1)?.toISOString()).toBe(
      "2026-09-08T09:00:00.000Z",
    )
  })

  it("floorWatermark supports granularity buckets and 0 = exact", () => {
    expect(floorWatermark(new Date("2026-09-08T09:37:42Z"), 6)?.toISOString()).toBe(
      "2026-09-08T06:00:00.000Z",
    )
    expect(floorWatermark(new Date("2026-09-08T09:37:42Z"), 0)?.toISOString()).toBe(
      "2026-09-08T09:37:42.000Z",
    )
    expect(floorWatermark(null, 1)).toBeNull()
  })

  it("syncStartDate uses watermark date else now - 10 days on first fetch", () => {
    expect(syncStartDate(new Date("2026-09-08T09:00:00Z"), NOW)).toBe("2026-09-08")
    expect(syncStartDate(null, NOW)).toBe("2026-08-29")
  })

  it("config envs fall back to proposal defaults", () => {
    expect(newsExpiryDays()).toBe(90)
    expect(newsFetchLimit()).toBe(50)
    expect(newsGranularityHours()).toBe(1)
  })
})

describe("getNewsForTicker (N4)", () => {
  let db: DB
  let client: Awaited<ReturnType<typeof createTestDb>>["client"]

  beforeAll(async () => {
    const t = await createTestDb()
    db = t.db
    client = t.client
  })

  afterAll(async () => {
    await client.close()
  })

  afterEach(async () => {
    vi.clearAllMocks()
    await db.delete(newsArticles)
    for (const k of Object.keys(process.env)) {
      if (k.startsWith("NEWS_")) delete process.env[k]
    }
  })

  it("purges expired rows while keeping fresh ones", async () => {
    await db.insert(newsArticles).values({
      url: "old", title: "old", source: "polygon",
      publishedAt: new Date("2026-09-07T00:00:00Z"),
      symbols: ["AAPL"],
      expiresAt: new Date(NOW.getTime() - 1000),
    })
    await db.insert(newsArticles).values({
      url: "fresh", title: "fresh", source: "polygon",
      publishedAt: new Date("2026-09-08T00:00:00Z"),
      symbols: ["AAPL"],
      expiresAt: new Date(NOW.getTime() + 86_400_000),
    })
    mockFetch.mockResolvedValue([])
    mockTranslate.mockReturnValue([])

    await getNewsForTicker(db, "AAPL", 10, NOW)

    expect((await db.select().from(newsArticles)).map((r) => r.url)).toEqual(["fresh"])
  })

  it("first fetch uses a 10-day window and caps persisted rows", async () => {
    mockFetch.mockResolvedValue([rawArticle({ url: "https://example.com/1" })])
    mockTranslate.mockReturnValue([
      {
        url: "https://example.com/1",
        title: "Apple unveils new chip",
        summary: "AAPL details",
        source: "polygon",
        publishedAt: new Date("2026-09-08T08:30:00Z"),
        symbols: ["AAPL"],
      },
    ])

    const out = await getNewsForTicker(db, "AAPL", 10, NOW)

    expect(mockFetch).toHaveBeenCalledTimes(1)
    const [ticker, startDate, limit] = mockFetch.mock.calls[0]
    expect(ticker).toBe("AAPL")
    expect(startDate).toBe("2026-08-29") // now - 10 days
    expect(limit).toBe(50) // NEWS_FETCH_LIMIT
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ title: "Apple unveils new chip", source: "polygon" })
  })

  it("watermark restart syncs from the rounded hour bucket", async () => {
    mockFetch.mockResolvedValue([rawArticle({})])
    mockTranslate.mockReturnValue([
      {
        url: "https://example.com/1",
        title: "Apple unveils new chip",
        summary: "AAPL details",
        source: "polygon",
        publishedAt: new Date("2026-09-08T08:30:00Z"),
        symbols: ["AAPL"],
      },
    ])
    await getNewsForTicker(db, "AAPL", 10, NOW)
    mockFetch.mockClear()

    const out = await getNewsForTicker(db, "AAPL", 10, NOW)

    const startDate = mockFetch.mock.calls[0]?.[1]
    expect(startDate).toBe("2026-09-08") // watermark 08:30 floored to 08:00 → day
    expect(out).toHaveLength(1)
  })

  it("granularity=0 restarts from the exact watermark timestamp date", async () => {
    process.env.NEWS_SYNC_GRANULARITY_HOURS = "0"
    mockFetch.mockResolvedValue([rawArticle({})])
    mockTranslate.mockReturnValue([
      {
        url: "https://example.com/1",
        title: "Apple unveils new chip",
        summary: "AAPL details",
        source: "polygon",
        publishedAt: new Date("2026-09-08T08:30:00Z"),
        symbols: ["AAPL"],
      },
    ])
    await getNewsForTicker(db, "AAPL", 10, NOW)
    mockFetch.mockClear()

    await getNewsForTicker(db, "AAPL", 10, NOW)
    const startDate = mockFetch.mock.calls[0]?.[1]
    expect(startDate).toBe("2026-09-08")
  })

  it("upserts dedup by url and unions symbols across tickers", async () => {
    mockTranslate.mockReturnValue([
      {
        url: "https://example.com/shared",
        title: "Cross-listed story",
        summary: null,
        source: "fmp",
        publishedAt: new Date("2026-09-08T10:00:00Z"),
        symbols: ["AAPL"],
      },
    ])
    mockFetch.mockResolvedValue([rawArticle({ url: "https://example.com/shared" })])

    await getNewsForTicker(db, "AAPL", 10, NOW)
    // same url arrives again tagged MSFT only — one row, both symbols
    mockTranslate.mockReturnValue([
      {
        url: "https://example.com/shared",
        title: "Cross-listed story",
        summary: null,
        source: "fmp",
        publishedAt: new Date("2026-09-08T10:00:00Z"),
        symbols: ["MSFT"],
      },
    ])
    mockFetch.mockResolvedValue([rawArticle({ url: "https://example.com/shared" })])

    await getNewsForTicker(db, "MSFT", 10, NOW)

    const rows = await db.select().from(newsArticles)
    expect(rows).toHaveLength(1)
    expect(rows[0].symbols.sort()).toEqual(["AAPL", "MSFT"])
  })

  it("returns stored rows newest-first capped by limit, ticker-scoped", async () => {
    await db.insert(newsArticles).values({
      url: "https://example.com/a", title: "a", summary: null, source: "polygon",
      publishedAt: new Date("2026-09-08T09:00:00Z"),
      symbols: ["AAPL"],
      expiresAt: new Date(NOW.getTime() + 86_400_000),
    })
    await db.insert(newsArticles).values({
      url: "https://example.com/b", title: "b", summary: null, source: "polygon",
      publishedAt: new Date("2026-09-08T10:00:00Z"),
      symbols: ["AAPL"],
      expiresAt: new Date(NOW.getTime() + 86_400_000),
    })
    await db.insert(newsArticles).values({
      url: "https://example.com/c", title: "c", summary: null, source: "polygon",
      publishedAt: new Date("2026-09-08T10:00:00Z"),
      symbols: ["MSFT"],
      expiresAt: new Date(NOW.getTime() + 86_400_000),
    })
    mockFetch.mockResolvedValue([])
    mockTranslate.mockReturnValue([])

    const out = await getNewsForTicker(db, "AAPL", 1, NOW)

    expect(out).toHaveLength(1)
    expect(out[0].url).toBe("https://example.com/b")
  })

  it("serves stored rows when cachest is unreachable", async () => {
    await db.insert(newsArticles).values({
      url: "https://example.com/offline", title: "offline", summary: null, source: "polygon",
      publishedAt: new Date("2026-09-08T09:00:00Z"),
      symbols: ["AAPL"],
      expiresAt: new Date(NOW.getTime() + 86_400_000),
    })
    mockFetch.mockRejectedValue(new Error("upstream down"))

    const out = await getNewsForTicker(db, "AAPL", 10, NOW)

    expect(out).toHaveLength(1)
    expect(out[0].title).toBe("offline")
  })

  it("supports venue-qualified route symbols via provider ticker", async () => {
    mockFetch.mockResolvedValue([rawArticle({})])
    mockTranslate.mockImplementation((raw, ticker) => [
      {
        url: "https://example.com/1",
        title: "Apple unveils new chip",
        summary: "AAPL details",
        source: "polygon",
        publishedAt: new Date("2026-09-08T08:30:00Z"),
        symbols: [ticker],
      },
    ])

    const out = await getNewsForTicker(db, "AAPL.US", 10, NOW)

    expect(mockFetch.mock.calls[0]?.[0]).toBe("AAPL")
    expect(out).toHaveLength(1)
    expect(out[0].symbols).toEqual(["AAPL"])
  })
})

describe("getNewsStats (N7 stats)", () => {
  let db: DB
  let client: Awaited<ReturnType<typeof createTestDb>>["client"]

  beforeAll(async () => {
    const t = await createTestDb()
    db = t.db
    client = t.client
  })

  afterAll(async () => {
    await client.close()
  })

  afterEach(async () => {
    await db.delete(newsArticles)
  })

  it("aggregates counts over stored rows for the ticker", async () => {
    const mk = (url: string, symbols: string[], summary: string | null) =>
      db.insert(newsArticles).values({
        url, title: "t", summary, source: "polygon",
        publishedAt: new Date("2026-09-08T09:00:00Z"),
        symbols,
        expiresAt: new Date(NOW.getTime() + 86_400_000),
      })
    await mk("https://a.com/1", ["AAPL"], "s1")
    await mk("https://a.com/2", ["AAPL"], "s2")
    await mk("https://a.com/3", ["AAPL"], null)
    await mk("https://a.com/4", ["MSFT"], "other")

    const stats = await getNewsStats(db, "AAPL.US", NOW)

    expect(stats.ticker).toBe("AAPL")
    expect(stats.total_article_count).toBe(3)
    expect(stats.article_count).toBe(3)
    expect(stats.total_analyzed_article_count).toBe(2)
    expect(stats.last_fetched_at).not.toBeNull()
  })

  it("returns zeroes for a ticker with no stored rows", async () => {
    const stats = await getNewsStats(db, "NVDA", NOW)
    expect(stats.total_article_count).toBe(0)
    expect(stats.total_analyzed_article_count).toBe(0)
    expect(stats.last_fetched_at).toBeNull()
  })

  it("purges expired rows before aggregating", async () => {
    await db.insert(newsArticles).values({
      url: "https://a.com/expired", title: "t", summary: null, source: "polygon",
      publishedAt: new Date("2026-09-07T00:00:00Z"),
      symbols: ["AAPL"],
      expiresAt: new Date(NOW.getTime() - 1000),
    })
    const stats = await getNewsStats(db, "AAPL", NOW)
    expect(stats.total_article_count).toBe(0)
  })
})