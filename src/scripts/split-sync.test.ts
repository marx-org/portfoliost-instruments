import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const { db, rows } = vi.hoisted(() => {
  const rows = vi.fn()
  const db = vi.fn(async (parts: TemplateStringsArray) => {
    const query = Array.from(parts).join("?")
    if (query.includes("SELECT DISTINCT symbol")) return [{ symbol: "DNP.WA" }, { symbol: "NVDA" }]
    if (query.includes("RETURNING status")) return [{ status: "pending" }]
    return []
  }) as any
  db.end = vi.fn()
  return { db, rows }
})

vi.mock("postgres", () => ({ default: vi.fn(() => db) }))

describe("split sync", () => {
  const originalFetch = globalThis.fetch

  beforeEach(() => {
    rows.mockReset()
    db.mockClear()
    globalThis.fetch = vi.fn(async (input: string | URL) => {
      const url = String(input)
      if (url.includes("DNP.WA")) {
        return new Response(JSON.stringify({ status: "unsupported", provider: "fmp", events: [] }), { status: 200 })
      }
      return new Response(JSON.stringify({
        status: "confirmed",
        provider: "fmp",
        events: [{
          symbol: "NVDA",
          effectiveDate: "2024-06-10",
          numerator: 10,
          denominator: 1,
          factor: 10,
          provider: "fmp",
        }],
      }), { status: 200 })
    }) as typeof fetch
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  it("scans distinct open-stock symbols, stages coverage gaps, and applies confirmed events", async () => {
    const { runSplitSync } = await import("./split-sync.js")
    const summary = await runSplitSync()

    expect(summary).toMatchObject({ symbols: 2, confirmed: 1, applied: 1, manual: 1, failed: 0 })
    expect(globalThis.fetch).toHaveBeenCalledWith(
      expect.stringContaining("/splits/NVDA"),
      expect.any(Object),
    )
    expect(globalThis.fetch).toHaveBeenCalledWith(
      expect.stringContaining("/internal/apply-split"),
      expect.objectContaining({ method: "POST" }),
    )
    expect(db).toHaveBeenCalled()
  })
})
