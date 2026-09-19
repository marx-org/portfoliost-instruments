import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  countCsvRows,
  fetchCorpBondCatalogue,
  syncCorpBondCatalogue,
} from "./corp-bond-catalogue-sync.js"

const HEADER = "listing_key,ticker,exchange,name,asset_type,stock_sector,etf_category,country,country_code,isin,aliases"

function makeCsv(rows: number): string {
  const body = Array.from(
    { length: rows },
    (_, i) => `WSE::SYM${i.toString().padStart(4, "0")},SYM${i.toString().padStart(4, "0")},WSE,Issuer ${i},corp_bond,,,Poland,PL,,`,
  ).join("\n")
  return `${HEADER}\n${body}`
}

function mockFetch(response: Response): void {
  vi.stubGlobal("fetch", vi.fn(async () => response))
}

describe("countCsvRows", () => {
  it("excludes the header and empty lines", () => {
    expect(countCsvRows(makeCsv(3))).toBe(3)
    expect(countCsvRows(HEADER)).toBe(0)
    expect(countCsvRows("")).toBe(0)
  })
})

describe("fetchCorpBondCatalogue", () => {
  afterEach(() => vi.unstubAllGlobals())

  it("returns the CSV body on 200", async () => {
    const csv = makeCsv(2)
    mockFetch(new Response(csv, { status: 200, headers: { "content-type": "text/csv" } }))
    await expect(fetchCorpBondCatalogue("http://cachest:8080")).resolves.toBe(csv)
  })

  it("throws on non-200", async () => {
    mockFetch(new Response(null, { status: 502 }))
    await expect(fetchCorpBondCatalogue("http://cachest:8080")).rejects.toThrow("HTTP 502")
  })

  it("accepts text/plain (cachest re-serializes proxied bodies as PlainTextResponse)", async () => {
    const csv = makeCsv(2)
    mockFetch(new Response(csv, { status: 200, headers: { "content-type": "text/plain; charset=utf-8" } }))
    await expect(fetchCorpBondCatalogue("http://cachest:8080")).resolves.toBe(csv)
  })

  it("throws when the content type is not text", async () => {
    mockFetch(new Response("<html>oops</html>", { status: 200, headers: { "content-type": "text/html" } }))
    await expect(fetchCorpBondCatalogue("http://cachest:8080")).rejects.toThrow("text/html")
  })
})

describe("syncCorpBondCatalogue", () => {
  afterEach(() => vi.unstubAllGlobals())

  it("upserts the full catalogue and returns the row count", async () => {
    const csv = makeCsv(937)
    mockFetch(new Response(csv, { status: 200, headers: { "content-type": "text/csv" } }))
    const sync = vi.fn(async (_csv: string, _db?: unknown) => ({ total: 937 }))
    const total = await syncCorpBondCatalogue("http://cachest:8080", sync, undefined)
    expect(total).toBe(937)
    expect(sync).toHaveBeenCalledTimes(1)
    expect(sync.mock.calls[0]?.[0]).toBe(csv)
  })

  it("refuses a truncated scrape before any DB write", async () => {
    const csv = makeCsv(10)
    mockFetch(new Response(csv, { status: 200, headers: { "content-type": "text/csv" } }))
    const sync = vi.fn()
    await expect(syncCorpBondCatalogue("http://cachest:8080", sync, undefined)).rejects.toThrow(
      "too small",
    )
    expect(sync).not.toHaveBeenCalled()
  })

  it("propagates fetch failures without touching the DB", async () => {
    mockFetch(new Response(null, { status: 404 }))
    const sync = vi.fn()
    await expect(syncCorpBondCatalogue("http://cachest:8080", sync, undefined)).rejects.toThrow(
      "HTTP 404",
    )
    expect(sync).not.toHaveBeenCalled()
  })
})
