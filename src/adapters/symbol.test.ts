import { describe, expect, it } from "vitest"
import { providerSymbol, symbolSuffix } from "./symbol.js"

describe("providerSymbol", () => {
  it("strips the .US suffix (US providers want bare tickers)", () => {
    expect(providerSymbol("AAPL.US")).toBe("AAPL")
    expect(providerSymbol("aapl.us")).toBe("AAPL")
  })

  it("keeps venue suffixes for non-US listings (Yahoo-style lookup)", () => {
    expect(providerSymbol("SNT.WA")).toBe("SNT.WA")
    expect(providerSymbol("SAP.DE")).toBe("SAP.DE")
    expect(providerSymbol("BP.L")).toBe("BP.L")
  })

  it("passes bare symbols through unchanged", () => {
    expect(providerSymbol("AAPL")).toBe("AAPL")
  })

  it("uppercases input", () => {
    expect(providerSymbol("snt.wa")).toBe("SNT.WA")
    expect(providerSymbol("aapl.us")).toBe("AAPL")
  })

  it("does not treat dots inside tickers as suffixes without a second segment", () => {
    expect(providerSymbol("BRK.B")).toBe("BRK.B")
  })
})

describe("symbolSuffix", () => {
  it("returns the suffix for venue-qualified symbols", () => {
    expect(symbolSuffix("SNT.WA")).toBe("WA")
    expect(symbolSuffix("snt.wa")).toBe("WA")
  })

  it("returns null for bare and .US symbols", () => {
    expect(symbolSuffix("AAPL")).toBeNull()
    expect(symbolSuffix("AAPL.US")).toBeNull()
    expect(symbolSuffix("aapl.us")).toBeNull()
  })

  it("returns only the first suffix segment", () => {
    expect(symbolSuffix("A.B.C")).toBe("B")
  })
})

