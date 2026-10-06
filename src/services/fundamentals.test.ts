import { readFileSync } from "fs"
import { fileURLToPath } from "url"
import { describe, expect, it } from "vitest"
import { rejectedRowCount, rowIdentity, rowsIdentity } from "./fundamentals.js"

const FIXTURES = fileURLToPath(new URL("../../test/fixtures/fundamentals", import.meta.url))

interface Envelope {
  provider: string | null
  rows: Array<Record<string, unknown>>
}

function body(provider: string, file: string): Envelope {
  return JSON.parse(readFileSync(`${FIXTURES}/${provider}/${file}`, "utf8")) as Envelope
}

/** The row whose period end is the newest — the most recent filed period. */
function newestRow(provider: string, file: string): Record<string, unknown> {
  const rows = body(provider, file).rows
  return rows.reduce((a, b) => (String(a.period_ending) > String(b.period_ending) ? a : b))
}

describe("rowIdentity", () => {
  it("keys both provider shapes onto the same period for the same symbol", () => {
    // The regression this whole module exists for. Apple FY2025 is 2025-09-27 per
    // fmp and 2025-09-30 per yfinance: keying on `period_ending` would store the
    // same fiscal year twice and fork the history on a provider switch.
    const fmp = rowIdentity(newestRow("fmp", "AAPL-income-annual.json"))
    const yf = rowIdentity(newestRow("yfinance", "AAPL-income-annual.json"))

    expect(fmp).not.toBeNull()
    expect(yf).not.toBeNull()
    expect(fmp!.periodKey).toBe("2025-Q3")
    expect(yf!.periodKey).toBe(fmp!.periodKey)
    // …while the provider's own period end is kept, and genuinely differs.
    expect(fmp!.periodEnd).toBe("2025-09-27")
    expect(yf!.periodEnd).toBe("2025-09-30")
  })

  it("collides the calendar quarter of a fiscal quarter across providers", () => {
    // fmp calls the quarter ending 2026-06-27 "Q3 of FY2026"; yfinance reports
    // 2026-06-30, which is calendar Q2. Both are 2026Q2 by period end.
    const fmp = rowIdentity(newestRow("fmp", "AAPL-income-quarter.json"))
    const yf = rowIdentity(newestRow("yfinance", "AAPL-income-quarter.json"))

    expect(fmp!.periodKey).toBe("2026-Q2")
    expect(yf!.periodKey).toBe(fmp!.periodKey)
    // The fiscal labels the providers disagree on are recorded, not used as identity.
    expect(fmp!.fiscalYear).toBe(2026)
    expect(fmp!.fiscalPeriod).toBe("Q3")
    expect(yf!.fiscalYear).toBeNull()
    expect(yf!.fiscalPeriod).toBeNull()
  })

  it("keys an annual row and the quarterly row for that same quarter differently by scope", () => {
    // 2025-09-30 is both Apple's FY2025 annual row and its 2025Q3 quarterly row,
    // so `period` has to be part of the store's primary key.
    const annual = rowIdentity(newestRow("yfinance", "AAPL-income-annual.json"))!
    const quarter = rowsIdentity(body("yfinance", "AAPL-income-quarter.json").rows).find(
      (r) => r.periodEnd === "2025-09-30",
    )

    expect(annual.periodEnd).toBe("2025-09-30")
    expect(quarter).toBeDefined()
    expect(quarter!.periodKey).toBe(annual.periodKey)
  })

  it("reads a period end in all three shapes a provider sends it", () => {
    expect(rowIdentity({ period_ending: "2025-09-30" })!.periodEnd).toBe("2025-09-30")
    expect(rowIdentity({ period_ending: "2025-09-27T00:00:00.000" })!.periodEnd).toBe("2025-09-27")
    expect(rowIdentity({ period_ending: "2025-09-27T00:00:00.000+00:00" })!.periodKey).toBe("2025-Q3")
    expect(rowIdentity({ date: "2025-12-31" })!.periodKey).toBe("2025-Q4")
  })

  it("refuses a row with no usable period end rather than inventing a key", () => {
    expect(rowIdentity({ revenue: 1 })).toBeNull()
    expect(rowIdentity({ period_ending: "" })).toBeNull()
    expect(rowIdentity({ period_ending: "not-a-date" })).toBeNull()
    expect(rowIdentity({ period_ending: "2025-13-01" })).toBeNull()
  })

  it("falls back to the provider's declared fiscal year when there is no date", () => {
    // Still dropped rather than keyed under a value that would collide with a
    // calendar-quarter key — see the comment in rowIdentity.
    expect(rowIdentity({ fiscal_year: 2025, fiscal_period: "FY" })).toBeNull()
  })

  it("normalises every captured fixture row and rejects none of them", () => {
    const files = [
      "AAPL-income-annual", "AAPL-income-quarter",
      "AAPL-balance-annual", "AAPL-balance-quarter",
      "AAPL-cash-annual", "AAPL-cash-quarter",
    ]
    for (const provider of ["fmp", "yfinance"]) {
      for (const file of files) {
        const rows = body(provider, `${file}.json`).rows
        expect(rows.length, `${provider}/${file}`).toBeGreaterThan(0)
        expect(rejectedRowCount(rows), `${provider}/${file}`).toBe(0)
        for (const id of rowsIdentity(rows)) expect(id.periodKey).toMatch(/^\d{4}-Q[1-4]$/)
      }
    }
  })

  it("gives every statement of one symbol the same period keys", () => {
    // Income, balance and cash describe the same periods; if they disagreed the
    // response would silently pair an income row with a balance row from another
    // quarter.
    const keys = ["income", "balance", "cash"].map(
      (s) => rowsIdentity(body("yfinance", `AAPL-${s}-annual.json`).rows).map((r) => r.periodKey).sort(),
    )
    expect(keys[1]).toEqual(keys[0])
    expect(keys[2]).toEqual(keys[0])
  })
})
