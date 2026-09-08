import { afterEach, describe, expect, it, vi } from "vitest"
import {
  fetchCompanyNews,
  translateCompanyNews,
  translateCompanyNewsList,
} from "./cachest.js"

describe("fetchCompanyNews (N4)", () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("calls cachest /news/company/{ticker} with start_date + limit", async () => {
    const seen: { url: string; init?: RequestInit }[] = []
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        seen.push({ url })
        return new Response(JSON.stringify([]), { status: 200 })
      }),
    )

    await fetchCompanyNews("AAPL", "2026-08-29", 50)

    expect(seen).toHaveLength(1)
    const u = new URL(seen[0].url)
    expect(u.pathname).toBe("/news/company/AAPL")
    expect(u.searchParams.get("start_date")).toBe("2026-08-29")
    expect(u.searchParams.get("limit")).toBe("50")
  })

  it("omits start_date when absent", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => new Response("[]", { status: 200 })),
    )
    await fetchCompanyNews("AAPL")
    const call = vi.mocked(fetch).mock.calls[0]?.[0] as string
    expect(new URL(call).searchParams.has("start_date")).toBe(false)
    expect(new URL(call).searchParams.get("limit")).toBe("50")
  })

  it("URL-encodes venue-qualified tickers", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => new Response("[]", { status: 200 })),
    )
    await fetchCompanyNews("SNT.WA", undefined, 20)
    const call = vi.mocked(fetch).mock.calls[0]?.[0] as string
    expect(call).toContain("/news/company/SNT.WA")
    expect(new URL(call).searchParams.get("limit")).toBe("20")
  })

  it("propagates upstream non-ok as UpstreamError", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 404 })))
    await expect(fetchCompanyNews("UNKNOWN")).rejects.toThrow(/upstream 404/)
  })
})

describe("translateCompanyNews (N4)", () => {
  it("maps the openst shape to DB columns and fills symbols from provider", () => {
    const row = translateCompanyNews(
      {
        date: "2026-09-08T08:30:00Z",
        title: "Apple unveils new chip",
        text: "AAPL details",
        url: "https://example.com/1",
        symbols: ["aapl", "MSFT"],
        source: "polygon",
      },
      "AAPL",
    )
    expect(row).toEqual({
      url: "https://example.com/1",
      title: "Apple unveils new chip",
      summary: "AAPL details",
      source: "polygon",
      publishedAt: new Date("2026-09-08T08:30:00Z"),
      symbols: ["AAPL", "MSFT"],
    })
  })

  it("falls back to the fetch ticker when provider omits symbols (NaN/empty)", () => {
    const row = translateCompanyNews(
      { date: "2026-09-08T08:30:00Z", title: "t", url: "u", symbols: [] },
      "MSFT",
    )
    expect(row?.symbols).toEqual(["MSFT"])
  })

  it("normalizes summary/source nullability", () => {
    expect(
      translateCompanyNews(
        { date: "2026-09-08T08:30:00Z", title: "t", url: "u" },
        "AAPL",
      )?.summary,
    ).toBeNull()
    expect(
      translateCompanyNews(
        { date: "2026-09-08T08:30:00Z", title: "t", url: "u", text: "" },
        "AAPL",
      )?.source,
    ).toBeNull()
  })

  it("drops records missing url, title, or a parseable date", () => {
    expect(translateCompanyNews({ title: "t", url: "u", date: "not-a-date" }, "AAPL")).toBeNull()
    expect(translateCompanyNews({ date: "2026-09-08T00:00:00Z", url: "u" }, "AAPL")).toBeNull()
    expect(translateCompanyNews({ date: "2026-09-08T00:00:00Z", title: "t" }, "AAPL")).toBeNull()
  })

  it("translateCompanyNewsList dedupes by url keeping first occurrence", () => {
    const base = { date: "2026-09-08T08:30:00Z", title: "t", url: "u", symbols: ["AAPL"] }
    const out = translateCompanyNewsList([base, { ...base }, { ...base, url: "u2" }], "AAPL")
    expect(out.map((a) => a.url)).toEqual(["u", "u2"])
  })
})