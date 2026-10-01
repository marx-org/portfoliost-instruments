import { describe, expect, it } from "vitest"

import { isSavingsBond, venueFreeSymbol } from "./symbol.js"
import { UpstreamError } from "./cachest.js"

/**
 * Fund-category routing after §78.
 *
 * §72.39 step 5 shipped a hardcoded `FUND_CATEGORY_CODES` set in symbol.ts.
 * §78 deleted it: the catalogue sync writes `ANALIZY::{CODE}` rows into
 * `ticker_reference`, and the price tier is read from those rows' `exchange`
 * column. These tests exist to pin what replaced it — and, just as importantly,
 * what it must still NOT capture.
 *
 * The recogniser was membership-gated because no shape test is safe, and that
 * reasoning still applies to anything that tries to re-derive the category codes
 * from the symbol:
 *
 * - the code is not derivable (of ING01's nine categories only ING01/U/W/T/F
 *   resolve; A/I/K/S/E are 404 upstream);
 * - all 941 `corp_bond` rows in PROD ticker_reference are dotless (ABE0227);
 * - the table holds 35,894 symbols with 0–8 digits (A, ZTM25, ZOR1142,
 *   BE01725053), so no digit window separates the namespace.
 */

describe("no symbol-shape recogniser for fund categories", () => {
  it("symbol.ts exports no fund-category code list", async () => {
    const mod = await import("./symbol.js")
    expect("FUND_CATEGORY_CODES" in mod).toBe(false)
    expect("isFundCategory" in mod).toBe(false)
  })

  it("still recognises savings bonds, which fit a category-code shape exactly", () => {
    // ROD1033 is ROD + 4 digits — indistinguishable from a category code by
    // shape. That collision is precisely why the fund side went to data.
    for (const bond of ["ROD1033", "EDO0123", "ROD1033.WA"]) {
      expect(isSavingsBond(bond), bond).toBe(true)
    }
  })

  it("venueFreeSymbol leaves a dotless category code alone", () => {
    // The analysys codes are venue-free; the old recogniser stripped a suffix
    // defensively, and this is the behaviour the catalogue relies on.
    expect(venueFreeSymbol("ING01W")).toBe("ING01W")
    expect(venueFreeSymbol("ING01W.WA")).toBe("ING01W")
  })
})

describe("fund-category upstream errors stay distinguishable", () => {
  it("a 404 becomes an UpstreamError carrying the status, not an empty array", async () => {
    // "Cannot serve" must not silently become "no history in window": a 200 with
    // zero bars is what a dead provider returns, and that shape is how the
    // reverted mapping would have shipped unnoticed (77434fd).
    const { fetchFundCategoryHistory } = await import("./cachest.js")
    const original = globalThis.fetch
    globalThis.fetch = (async () =>
      new Response('{"detail":"No fund category ING01A"}', { status: 404 })) as typeof fetch
    try {
      await expect(
        fetchFundCategoryHistory("ING01A", "2023-01-01", "2026-12-31"),
      ).rejects.toBeInstanceOf(UpstreamError)
      await expect(
        fetchFundCategoryHistory("ING01A", "2023-01-01", "2026-12-31"),
      ).rejects.toMatchObject({ status: 404 })
    } finally {
      globalThis.fetch = original
    }
  })

  it("requests the provider's own code on the category route", async () => {
    const { fetchFundCategoryHistory } = await import("./cachest.js")
    const original = globalThis.fetch
    let seen = ""
    globalThis.fetch = (async (url: string) => {
      seen = String(url)
      return new Response("[]", { status: 200 })
    }) as typeof fetch
    try {
      await fetchFundCategoryHistory("ING01W", "2023-01-01", "2026-12-31")
      expect(seen).toContain("/fund/history/ING01W")
      expect(seen).not.toContain("/ohlcv/")
    } finally {
      globalThis.fetch = original
    }
  })
})
