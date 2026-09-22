import { describe, expect, it } from "vitest"
import { Hono } from "hono"
import { sql } from "drizzle-orm"
import { createFxRoutes } from "./fx.js"
import { createTestDb } from "../db/test-db.js"
import type { DB } from "../db/index.js"

const USER_HEADERS = { "X-User-Id": "user-1", "X-User-Email": "t@example.com" }

function appWithDb(db: DB) {
  const a = new Hono()
  a.route("/api", createFxRoutes(db))
  return a
}

async function withFxDb(fn: (app: Hono) => Promise<void>) {
  const t = await createTestDb()
  await t.db.execute(sql.raw(`
    INSERT INTO instruments.fx_rates (rate_date, currency, rate, source) VALUES
      ('2026-09-16', 'PLN', 4.0000000000, 'ecb'),
      ('2026-09-16', 'USD', 4.3000000000, 'ecb'),
      ('2026-09-16', 'GBP', 0.8500000000, 'ecb'),
      ('2026-09-17', 'PLN', 4.1000000000, 'ecb'),
      ('2026-09-17', 'USD', 4.2000000000, 'ecb');
  `))
  try {
    await fn(appWithDb(t.db))
  } finally {
    await t.client.close()
  }
}

describe("GET /api/currencies (moved from wallets, plan §48.3)", () => {
  it("lists the fx_rates currencies + EUR with catalog metadata, no auth", async () => {
    await withFxDb(async (app) => {
      const res = await app.request("/api/currencies")
      expect(res.status).toBe(200)
      const body = (await res.json()) as { currencies: Array<{ code: string; name: string; minorUnits: number }> }
      const codes = body.currencies.map((c) => c.code)
      expect(codes).toEqual(expect.arrayContaining(["EUR", "PLN", "USD", "GBP"]))
      const usd = body.currencies.find((c) => c.code === "USD")!
      expect(usd.name).toBe("US Dollar")
      expect(usd.minorUnits).toBe(2)
    })
  })
})

describe("GET /api/internal/fx-rates (moved from wallets, plan §48.3)", () => {
  it("resolves a dated pair rate", async () => {
    await withFxDb(async (app) => {
      const res = await app.request("/api/internal/fx-rates?from=PLN&to=USD&date=2026-09-16", {
        headers: USER_HEADERS,
      })
      expect(res.status).toBe(200)
      const body = (await res.json()) as { rate: number; asOf: string }
      expect(body.rate).toBeCloseTo(4.3 / 4.0, 8)
      expect(body.asOf).toBe("2026-09-16")
    })
  })

  it("carries forward over dates without rows", async () => {
    await withFxDb(async (app) => {
      const res = await app.request("/api/internal/fx-rates?from=PLN&to=USD&date=2026-09-20", {
        headers: USER_HEADERS,
      })
      expect(res.status).toBe(200)
      const body = (await res.json()) as { rate: number; asOf: string }
      expect(body.rate).toBeCloseTo(4.2 / 4.1, 8)
      expect(body.asOf).toBe("2026-09-17")
    })
  })

  it("404s when nothing exists on or before the date", async () => {
    await withFxDb(async (app) => {
      const res = await app.request("/api/internal/fx-rates?from=PLN&to=USD&date=1990-01-01", {
        headers: USER_HEADERS,
      })
      expect(res.status).toBe(404)
    })
  })

  it("rejects malformed codes with 422", async () => {
    await withFxDb(async (app) => {
      const res = await app.request("/api/internal/fx-rates?from=PL&to=USD", {
        headers: USER_HEADERS,
      })
      expect(res.status).toBe(422)
    })
  })

  it("requires a user identity", async () => {
    await withFxDb(async (app) => {
      const res = await app.request("/api/internal/fx-rates?from=PLN&to=USD")
      expect(res.status).toBe(401)
    })
  })
})

describe("GET /api/fx/latest (SPA dialog rate, moved from wallets)", () => {
  it("resolves the same pair semantics as the internal route", async () => {
    await withFxDb(async (app) => {
      const res = await app.request("/api/fx/latest?from=USD&to=PLN", { headers: USER_HEADERS })
      expect(res.status).toBe(200)
      const body = (await res.json()) as { rate: number; asOf: string }
      expect(body.rate).toBeCloseTo(4.1 / 4.2, 8) // latest table on/before today
      expect(body.asOf).toBe("2026-09-17")
    })
  })
})

describe("GET /api/admin/fx-rates (D47 listing, moved from wallets)", () => {
  it("pages the EUR-quoted rows with filters", async () => {
    await withFxDb(async (app) => {
      const res = await app.request("/api/admin/fx-rates?per_page=3&quote_currency=PLN", {
        headers: USER_HEADERS,
      })
      expect(res.status).toBe(200)
      const body = (await res.json()) as {
        items: Array<{ date: string; baseCurrency: string; quoteCurrency: string; rate: number }>
        pagination: { total: number; page: number; per_page: number; total_pages: number }
      }
      expect(body.pagination.total).toBe(2)
      expect(body.items).toHaveLength(2)
      expect(body.items.every((i) => i.baseCurrency === "EUR" && i.quoteCurrency === "PLN")).toBe(true)

      const eurBase = await app.request("/api/admin/fx-rates?base_currency=USD", { headers: USER_HEADERS })
      expect((await eurBase.json()).items).toHaveLength(0)
    })
  })
})
