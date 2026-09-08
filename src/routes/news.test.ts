import { describe, it, expect, vi, beforeEach } from "vitest"
import { Hono } from "hono"
import { createNewsRoutes } from "./instruments.js"

const mocks = vi.hoisted(() => ({
  getNewsForTicker: vi.fn(),
  getRecentNews: vi.fn(),
}))

vi.mock("../services/news.js", () => ({
  getNewsForTicker: mocks.getNewsForTicker,
  getRecentNews: mocks.getRecentNews,
}))

vi.mock("../db/index.js", () => ({
  getDb: () => ({}),
  closeDb: async () => {},
}))

vi.mock("../adapters/cachest.js", () => ({
  UpstreamError: class UpstreamError extends Error {},
}))

function appWithUser() {
  const app = new Hono()
  app.route("/api/news", createNewsRoutes())
  return app
}

const USER_HEADERS = { "X-User-Id": "user-1", "X-User-Email": "t@example.com" }

function req(path: string) {
  return appWithUser().request(path, { headers: USER_HEADERS })
}

function row(over: Record<string, unknown> = {}) {
  return {
    url: "https://example.com/1",
    title: "Apple unveils new chip",
    summary: "AAPL details",
    source: "polygon",
    publishedAt: new Date("2026-09-08T08:30:00Z"),
    symbols: ["AAPL"],
    ...over,
  }
}

beforeEach(() => {
  mocks.getNewsForTicker.mockReset()
  mocks.getRecentNews.mockReset()
})

describe("GET /api/news/articles", () => {
  it("requires login", async () => {
    const res = await appWithUser().request("/api/news/articles")
    expect(res.status).toBe(401)
  })

  it("delegates to getNewsForTicker for a ticker and returns NewsArticleList shape", async () => {
    mocks.getNewsForTicker.mockResolvedValue([row()])
    const res = await req("/api/news/articles?ticker=AAPL&limit=20")
    expect(res.status).toBe(200)
    expect(mocks.getNewsForTicker).toHaveBeenCalledWith({}, "AAPL", 20)
    const body = await res.json()
    expect(body.pagination).toEqual({
      count: 1,
      total_count: 1,
      has_next_page: false,
      has_previous_page: false,
      next_cursor: null,
      previous_cursor: null,
    })
    const item = body.data[0]
    expect(item.id).toBe("https://example.com/1")
    expect(item.type).toBe("article")
    expect(item.ticker).toBe("AAPL")
    expect(item.article.title).toBe("Apple unveils new chip")
    expect(item.article.source).toBe("polygon")
    expect(item.published_at).toBe("2026-09-08T08:30:00.000Z")
  })

  it("defaults limit to 20 and caps at 100", async () => {
    mocks.getNewsForTicker.mockResolvedValue([])
    await req("/api/news/articles?ticker=AAPL")
    expect(mocks.getNewsForTicker).toHaveBeenCalledWith({}, "AAPL", 20)
    await req("/api/news/articles?ticker=AAPL&limit=500")
    expect(mocks.getNewsForTicker).toHaveBeenCalledWith({}, "AAPL", 100)
  })

  it("uses getRecentNews for ticker-less calls (SPA getAllNews)", async () => {
    mocks.getRecentNews.mockResolvedValue([row()])
    const res = await req("/api/news/articles?limit=10")
    expect(res.status).toBe(200)
    expect(mocks.getRecentNews).toHaveBeenCalledWith({}, 10)
    expect((await res.json()).data).toHaveLength(1)
  })

  it("falls back to the fetch ticker in item.ticker when the row lacks symbols", async () => {
    mocks.getNewsForTicker.mockResolvedValue([row({ symbols: [] })])
    const res = await req("/api/news/articles?ticker=AAPL")
    expect((await res.json()).data[0].ticker).toBe("AAPL")
  })

  it("maps upstream failure to 502", async () => {
    mocks.getNewsForTicker.mockRejectedValue(new Error("boom"))
    const res = await req("/api/news/articles?ticker=AAPL")
    expect(res.status).toBe(502)
  })
})