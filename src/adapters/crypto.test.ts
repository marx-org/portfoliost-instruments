import { describe, expect, it } from "vitest"
import {
  curatedPairFromQuery,
  normalizeCryptoRow,
  normalizeCryptoRows,
} from "./crypto.js"

describe("normalizeCryptoRow — curated majors", () => {
  it("maps a bare BTCUSD row to BTC-USD", () => {
    expect(normalizeCryptoRow({ symbol: "BTCUSD", name: "Bitcoin USD" })).toEqual({
      symbol: "BTC-USD",
      name: "Bitcoin USD",
    })
  })

  it("maps ETH-USD and SOL-USD the same way", () => {
    expect(normalizeCryptoRow({ symbol: "ETHUSD", name: "Ethereum USD" })).toEqual({
      symbol: "ETH-USD",
      name: "Ethereum USD",
    })
    expect(normalizeCryptoRow({ symbol: "SOLUSD", name: "Solana USD" })).toEqual({
      symbol: "SOL-USD",
      name: "Solana USD",
    })
  })

  it("rebases MATIC rows to the renamed POL pair", () => {
    expect(normalizeCryptoRow({ symbol: "MATICUSD", name: "Polygon USD" })).toEqual({
      symbol: "POL-USD",
      name: "Polygon USD",
    })
  })

  it("falls back to the curated pair name when the row has no name", () => {
    expect(normalizeCryptoRow({ symbol: "BTCUSD" })).toEqual({
      symbol: "BTC-USD",
      name: "BTC-USD",
    })
  })
})

describe("normalizeCryptoRow — excluding noisy FMP rows", () => {
  it("excludes wrapped tBTC", () => {
    expect(normalizeCryptoRow({ symbol: "TBTCUSD", name: "tBTC USD" })).toBeNull()
  })

  it("excludes wrapped wBTC / hBTC / renBTC", () => {
    expect(normalizeCryptoRow({ symbol: "WBTCUSD", name: "Wrapped Bitcoin USD" })).toBeNull()
    expect(normalizeCryptoRow({ symbol: "HBTCUSD", name: "Huobi BTC USD" })).toBeNull()
    expect(normalizeCryptoRow({ symbol: "RENBTCUSD", name: "renBTC USD" })).toBeNull()
  })

  it("excludes BUSD-venue rows even when the base is a curated major", () => {
    expect(normalizeCryptoRow({ symbol: "BTCBUSD", name: "Bitcoin BEP2 USD" })).toBeNull()
    expect(normalizeCryptoRow({ symbol: "ETHBUSD", name: "Ethereum BUSD" })).toBeNull()
  })

  it("excludes dotted-venue rows and leveraged/index variants", () => {
    expect(normalizeCryptoRow({ symbol: "BTC.BUSD", name: "Bitcoin Avalanche Bridged USD" })).toBeNull()
    expect(normalizeCryptoRow({ symbol: "BTC2X-FLIUSD", name: "BTC 2x Flexible Leverage Index USD" })).toBeNull()
  })

  it("excludes wrapped-coin variants with long prefixes", () => {
    expect(normalizeCryptoRow({ symbol: "PUMPBTCUSD", name: "pumpBTC USD" })).toBeNull()
    expect(normalizeCryptoRow({ symbol: "SOLVBTCBBNUSD", name: "SolvBTC.BBN USD" })).toBeNull()
    expect(normalizeCryptoRow({ symbol: "0XBTCUSD", name: "0xBitcoin USD" })).toBeNull()
  })

  it("excludes rows without a symbol", () => {
    expect(normalizeCryptoRow({ name: "No symbol" })).toBeNull()
    expect(normalizeCryptoRow({})).toBeNull()
  })
})

describe("normalizeCryptoRow — bare-mnemonic fallback", () => {
  it("maps an unknown-but-bare mnemonic to base-USD", () => {
    expect(normalizeCryptoRow({ symbol: "ZECUSD", name: "Zcash USD" })).toEqual({
      symbol: "ZEC-USD",
      name: "Zcash USD",
    })
  })
})

describe("normalizeCryptoRows", () => {
  it("normalizes a batch and drops the non-tradeable rows", () => {
    expect(
      normalizeCryptoRows([
        { symbol: "BTCUSD", name: "Bitcoin USD" },
        { symbol: "TBTCUSD", name: "tBTC USD" },
        { symbol: "BTCBUSD", name: "Bitcoin BEP2 USD" },
        { symbol: "ETHUSD", name: "Ethereum USD" },
      ]),
    ).toEqual([
      { symbol: "BTC-USD", name: "Bitcoin USD" },
      { symbol: "ETH-USD", name: "Ethereum USD" },
    ])
  })

  it("returns [] for a missing batch", () => {
    expect(normalizeCryptoRows(undefined as never)).toEqual([])
  })
})

describe("curatedPairFromQuery", () => {
  it("returns the exact pair for a curated base mnemonic", () => {
    expect(curatedPairFromQuery("btc")).toEqual({ symbol: "BTC-USD", name: "BTC-USD" })
    expect(curatedPairFromQuery("ETH")).toEqual({ symbol: "ETH-USD", name: "ETH-USD" })
    expect(curatedPairFromQuery("  sol ")).toEqual({ symbol: "SOL-USD", name: "SOL-USD" })
  })

  it("returns null for unknown queries", () => {
    expect(curatedPairFromQuery("zzzz")).toBeNull()
    expect(curatedPairFromQuery("btcusd")).toBeNull()
  })
})