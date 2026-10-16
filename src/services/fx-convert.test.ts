import { describe, expect, it } from "vitest"
import type { RateTable } from "@marx-org/contracts/fx"
import { convertSeries, rateTablesByDate } from "./fx-convert.js"

/**
 * A USD→PLN leg needs BOTH currencies in the table — `rateTablesByDate` groups
 * rows by currency and nothing else is consulted. `convert` reads it as
 * target-over-source, so 42,586.918 × 0.89/0.2222 ≈ 170,600, which matches what
 * the live endpoint returns for that date. A table holding only one of the pair
 * cannot convert at all — which is itself a way to silently get no conversion.
 */
const RATE = (usd: number, pln: number): RateTable => ({ USD: usd, PLN: pln }) as RateTable

describe("convertSeries (§72.17)", () => {
  it("marks every bar it could not convert", () => {
    // The real BTC-USD window: a rate row for 02-14 and 02-15, none for 02-13
    // and none again for 02-16. The gaps are NOT a prefix, which is why
    // `fxFrom` alone cannot tell a caller which bars are unconverted.
    const tables = new Map<string, RateTable>([
      ["2022-02-14", RATE(0.2222, 0.89)],
      ["2022-02-15", RATE(0.2215, 0.88)],
    ])
    const dates = ["2022-02-13", "2022-02-14", "2022-02-15", "2022-02-16"]
    const closes = [42197.5156, 42586.918, 44575.2031, 43000]

    const r = convertSeries(dates, closes, "USD", "PLN", tables)

    expect(r.fxFrom).toBe("2022-02-14")
    expect(r.convertedMask).toEqual([false, true, true, false])
    // 02-13 and 02-16 keep the raw value; the route drops them.
    expect(r.converted[0]).toBe(42197.5156)
    expect(r.converted[1]).toBeCloseTo(170600, -2)
    expect(r.converted[3]).toBe(43000)
  })

  it("marks nothing converted when there are no rate rows at all", () => {
    const r = convertSeries(["2022-02-13"], [42197.5156], "USD", "PLN", new Map())
    expect(r.fxFrom).toBeNull()
    expect(r.convertedMask).toEqual([false])
  })

  it("converts when the table carries both legs of the pair", () => {
    const r = convertSeries(["2022-02-14"], [42586.918], "USD", "PLN", new Map([["2022-02-14", RATE(0.2222, 0.89)]]))
    expect(r.convertedMask).toEqual([true])
    expect(r.converted[0]).toBeCloseTo(170600, -2)
  })
})

describe("rateTablesByDate", () => {
  it("ignores non-positive and non-finite rates", () => {
    const t = rateTablesByDate([
      { rateDate: "2022-02-14", currency: "PLN", rate: "4.01" },
      { rateDate: "2022-02-15", currency: "PLN", rate: "0" },
      { rateDate: "2022-02-16", currency: "PLN", rate: "nonsense" },
    ])
    expect([...t.keys()]).toEqual(["2022-02-14"])
  })
})
