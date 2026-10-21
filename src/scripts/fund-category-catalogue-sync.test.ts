import { describe, expect, it, vi } from "vitest"

import {
  countCsvRows,
  fetchFundCatalogue,
  FUND_CATALOGUE_VENUE,
  syncFundCatalogue,
} from "./fund-category-catalogue-sync.js"

/**
 * Fund-category catalogue sync (§78 step 5), modelled on
 * `corp-bond-catalogue-sync.test.ts`.
 *
 * The row-count gate is the real protection here: the failure modes seen in
 * practice are an HTML error page and a truncated body, and both parse as
 * "some rows" — a sync that accepted them would quietly shrink the catalogue
 * and make funds disappear from search one refresh at a time.
 */

const HEADER =
  "listing_key,ticker,exchange,name,asset_type,stock_sector,etf_category,country,country_code,isin,aliases"

function catalogue(rows: number): string {
  const body = Array.from(
    { length: rows },
    (_, i) => `${FUND_CATALOGUE_VENUE}::ING${String(i + 1).padStart(2, "0")},ING${String(i + 1).padStart(2, "0")},${FUND_CATALOGUE_VENUE},Fund ${i},fund,,,Poland,PL,,`,
  ).join("\n")
  return `${HEADER}\n${body}\n`
}

describe("countCsvRows", () => {
  it("excludes the header", () => {
    expect(countCsvRows(catalogue(5))).toBe(5)
  })

  it("ignores trailing newlines and counts zero for a header-only file", () => {
    expect(countCsvRows(`${HEADER}\n\n\n`)).toBe(0)
    expect(countCsvRows("")).toBe(0)
  })
})

describe("fetchFundCatalogue", () => {
  it("accepts text/csv", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      headers: new Headers({ "content-type": "text/csv" }),
      text: async () => catalogue(3),
    }))
    vi.stubGlobal("fetch", fetchMock)
    expect(await fetchFundCatalogue("http://cachest:8080")).toContain(HEADER)
    expect(fetchMock).toHaveBeenCalledWith("http://cachest:8080/fund/catalogue", { redirect: "error" })
  })

  it("accepts text/plain, because cachest re-serialises every proxied body", async () => {
    // Same asymmetry as the corp-bond route: openst answers text/csv, cachest
    // hands back PlainTextResponse. Accepting only one of them would break the
    // path this actually runs on.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 200,
        headers: new Headers({ "content-type": "text/plain; charset=utf-8" }),
        text: async () => catalogue(3),
      })),
    )
    expect(await fetchFundCatalogue("http://cachest:8080")).toContain(HEADER)
  })

  it("throws on a non-200", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 503, headers: new Headers(), text: async () => "" })),
    )
    await expect(fetchFundCatalogue("http://cachest:8080")).rejects.toThrow(/HTTP 503/)
  })

  it("throws on an unexpected content type", async () => {
    // The shape an upstream HTML error page arrives in.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 200,
        headers: new Headers({ "content-type": "text/html" }),
        text: async () => "<html>502</html>",
      })),
    )
    await expect(fetchFundCatalogue("http://cachest:8080")).rejects.toThrow(/text\/csv/)
  })
})

describe("syncFundCatalogue", () => {
  const sync = vi.fn(async (_csv: string, _db: unknown) => ({ total: 0 }))

  it("upserts a full catalogue", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 200,
        headers: new Headers({ "content-type": "text/csv" }),
        text: async () => catalogue(734),
      })),
    )
    sync.mockClear()
    const db = {} as never
    await syncFundCatalogue("http://cachest:8080", sync, db)
    expect(sync).toHaveBeenCalledOnce()
    expect(sync.mock.calls[0][1]).toBe(db)
  })

  it("refuses a truncated catalogue rather than shrinking search", async () => {
    // The important case: a partial body is valid CSV and would sync happily,
    // deleting funds from the table a few hundred at a time.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 200,
        headers: new Headers({ "content-type": "text/csv" }),
        text: async () => catalogue(12),
      })),
    )
    sync.mockClear()
    await expect(syncFundCatalogue("http://cachest:8080", sync, {} as never)).rejects.toThrow(
      /too small/,
    )
    expect(sync).not.toHaveBeenCalled()
  })

  it("refuses an empty catalogue", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 200,
        headers: new Headers({ "content-type": "text/csv" }),
        text: async () => `${HEADER}\n`,
      })),
    )
    sync.mockClear()
    await expect(syncFundCatalogue("http://cachest:8080", sync, {} as never)).rejects.toThrow(
      /too small/,
    )
    expect(sync).not.toHaveBeenCalled()
  })

  it("the floor sits below a real catalogue but above a substantial truncation", async () => {
    // 734 categories today, floor 400 (~54%, matching the corp-bond gate's 53%).
    // The boundary is probed by behaviour rather than by reading the constant.
    // The 150 case is the one that matters: it is a *plausible* partial body,
    // not a stub, and a loose floor would have accepted it and silently dropped
    // 584 funds from search.
    const serve = async (rows: number) => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => ({
          ok: true,
          status: 200,
          headers: new Headers({ "content-type": "text/csv" }),
          text: async () => catalogue(rows),
        })),
      )
    }

    sync.mockClear()
    await serve(500)
    await expect(syncFundCatalogue("http://cachest:8080", sync, {} as never)).resolves.toBe(0)
    expect(sync).toHaveBeenCalledOnce()

    for (const rows of [150, 12, 0]) {
      sync.mockClear()
      await serve(rows)
      await expect(
        syncFundCatalogue("http://cachest:8080", sync, {} as never),
        `${rows} rows must be refused`,
      ).rejects.toThrow(/too small/)
      expect(sync).not.toHaveBeenCalled()
    }
  })
})
