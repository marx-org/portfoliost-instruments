import { describe, expect, it } from "vitest"

import {
  FUND_CATEGORY_CODES,
  isFundCategory,
  isSavingsBond,
  venueFreeSymbol,
} from "../adapters/symbol.js"
import { UpstreamError } from "../adapters/cachest.js"

describe("isFundCategory", () => {
  it("recognises the verified analizy.pl category codes", () => {
    for (const code of ["ING01", "ING01W", "ING04", "ING81", "ING82", "ING88", "ING92"]) {
      expect(isFundCategory(code), code).toBe(true)
    }
  })

  it("is case-insensitive and venue-free, like the bond recogniser", () => {
    expect(isFundCategory("ing01w")).toBe(true)
    expect(isFundCategory("ING01W.WA")).toBe(true)
  })

  it("does NOT claim a .TFI symbol — those stay on the biznesradar route", () => {
    // The regression this guards: NNEP65 reproduces 34 of 66 trades to the cent
    // through the existing fund route. Routing it to analizy.pl would change a
    // working series, and NNEP30's first trade sits only 17 days inside
    // ING82's window, so a trimmed window would silently lose a bar.
    for (const tfi of ["INGAKC.TFI", "INGOBL.TFI", "NNEP25.TFI", "NNEP30.TFI", "NNEP60.TFI", "NNEP65.TFI"]) {
      expect(isFundCategory(tfi), tfi).toBe(false)
    }
  })

  it("does NOT claim savings bonds, which fit a category-code shape exactly", () => {
    // ROD1033 is ROD + 4 digits — indistinguishable from a category code by
    // shape, so the recognisers must be checked in that order.
    for (const bond of ["ROD1033", "EDO0123"]) {
      expect(isSavingsBond(bond), bond).toBe(true)
      expect(isFundCategory(bond), bond).toBe(false)
    }
  })

  it("does NOT claim real corp-bond codes, which are all dotless", () => {
    // Measured against PROD 2026-09-30: all 941 corp_bond rows in
    // ticker_reference are dotless, e.g. ABE0227 = 3 letters + 4 digits — the
    // exact shape of SKR110/ING92. Any regex broad enough to admit a fund
    // category would capture every one of them.
    for (const bond of ["ABE0227", "BST0327", "ZOR1142", "PKN0123"]) {
      expect(isFundCategory(bond), bond).toBe(false)
    }
  })

  it("does not claim ordinary equities, ETFs or crypto pairs", () => {
    for (const s of ["AAPL", "SNT.WA", "SAP.DE", "BTC-USD", "ETH-USD", "VIG04B.TFI"]) {
      expect(isFundCategory(s), s).toBe(false)
    }
  })

  it("stays membership-gated: a plausible-but-unverified code is not admitted", () => {
    // The source 404s four of ING01's nine categories. A `fund + letter`
    // transform would invent exactly these.
    for (const code of ["ING01A", "ING01I", "ING01K", "ING01S", "ING01E"]) {
      expect(isFundCategory(code), code).toBe(false)
    }
  })

  it("venueFreeSymbol leaves a dotless code alone", () => {
    expect(venueFreeSymbol("ING01W")).toBe("ING01W")
  })

  it("every registered code is dotless and upper-case", () => {
    for (const code of FUND_CATEGORY_CODES) {
      expect(code, code).toBe(code.toUpperCase())
      expect(code.includes("."), code).toBe(false)
    }
  })
})

describe("fund-category upstream errors stay distinguishable", () => {
  it("a 404 becomes an UpstreamError carrying the status, not an empty array", async () => {
    // This is the property stage 5 exists to preserve. `200` with zero bars is
    // what a dead provider returns, and that shape is how the reverted mapping
    // would have shipped unnoticed (77434fd).
    const { fetchFundCategoryHistory } = await import("../adapters/cachest.js")
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

  it("requests the provider's own code on its own route", async () => {
    const { fetchFundCategoryHistory } = await import("../adapters/cachest.js")
    const original = globalThis.fetch
    let seen = ""
    globalThis.fetch = (async (url: string) => {
      seen = String(url)
      return new Response("[]", { status: 200 })
    }) as typeof fetch
    try {
      await fetchFundCategoryHistory("ING01W", "2023-01-01", "2026-12-31")
      expect(seen).toContain("/fund/history/ING01W")
      expect(seen).toContain("start=2023-01-01")
      expect(seen).toContain("end=2026-12-31")
    } finally {
      globalThis.fetch = original
    }
  })
})
