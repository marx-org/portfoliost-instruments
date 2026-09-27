import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { Hono } from "hono"
import { createFxRoutes } from "./fx.js"
import { createInstrumentsRoutes } from "./instruments.js"
import { serviceTokenMatches } from "../auth.js"
import * as cachest from "../adapters/cachest.js"

/**
 * §63.10 — the second accepted credential.
 *
 * instruments has no `user_id` anywhere and none of its data handlers reads
 * `userIdentity`, but the chain behind it (cachest → openst → provider keys) has
 * no authentication of its own and pfire has no edge auth, so *something* has to
 * authenticate the caller. A service token lets the scheduled wallets snapshot
 * sweep — which has no user to be, because it iterates every portfolio of every
 * user — in without weakening that gate.
 *
 * The properties that matter: it is not a way to be a user (no `userIdentity`, so
 * `requireGroup` still bites), and it fails closed.
 */

const dbState = vi.hoisted(() => ({ db: null as unknown }))

vi.mock("../db/index.js", () => ({
  getDb: () => dbState.db,
  closeDb: async () => {},
}))

vi.mock("../adapters/cachest.js", () => ({
  UpstreamError: class UpstreamError extends Error {
    constructor(
      public url: string,
      public status: number,
    ) {
      super(`upstream ${status} for ${url}`)
    }
  },
  fetchOhlcv: vi.fn(),
  fetchBondOhlcv: vi.fn(),
  fetchProfile: vi.fn(),
  fetchQuote: vi.fn(),
  fetchFixedincomeQuote: vi.fn(),
  fetchCryptoQuote: vi.fn(),
  fetchMetrics: vi.fn(),
  fetchProjections: vi.fn(),
  fetchCalendarEarnings: vi.fn(),
  fetchCalendarDividends: vi.fn(),
  fetchSearch: vi.fn(),
  fetchCryptoSearch: vi.fn(),
  fetchBondSearch: vi.fn(),
  fetchBondProfile: vi.fn(),
  fetchDividendHistory: vi.fn(),
  fetchFilings: vi.fn(),
  fetchMda: vi.fn(),
  fetchInsiderTrading: vi.fn(),
}))

const SERVICE_TOKEN = "test-service-token"
const USER_HEADERS = { "X-User-Id": "user-1", "X-User-Email": "t@example.com" }
const svc = (token = SERVICE_TOKEN) => ({ "X-Service-Token": token })

const mocked = vi.mocked(cachest, true)

function app() {
  const a = new Hono()
  // fx routes take the db explicitly; the instruments routes use getDb().
  a.route("/api", createFxRoutes(dbState.db as never))
  a.route("/api/instruments", createInstrumentsRoutes())
  return a
}

async function seed() {
  const { sql } = await import("drizzle-orm")
  const { createTestDb } = await import("../db/test-db.js")
  const { LOCAL_PRICE_BARS_SETUP_SQL } = await import("../db/price-bars.js")
  const t = await createTestDb()
  dbState.db = t.db
  await t.db.execute(sql.raw(`
    INSERT INTO instruments.fx_rates (rate_date, currency, rate, source) VALUES
      ('2026-09-16', 'PLN', 4.0000000000, 'ecb'),
      ('2026-09-16', 'USD', 4.3000000000, 'ecb');
  `))
  for (const stmt of LOCAL_PRICE_BARS_SETUP_SQL) await t.db.execute(sql.raw(stmt))
  return t
}

const prevToken = process.env.INSTRUMENTS_SERVICE_TOKEN

beforeEach(async () => {
  process.env.INSTRUMENTS_SERVICE_TOKEN = SERVICE_TOKEN
  mocked.fetchOhlcv.mockReset()
  mocked.fetchBondOhlcv.mockReset()
  // No bars, and no upstream: the point of these cases is the credential, not the data.
  mocked.fetchOhlcv.mockResolvedValue([])
})

afterEach(() => {
  if (prevToken === undefined) delete process.env.INSTRUMENTS_SERVICE_TOKEN
  else process.env.INSTRUMENTS_SERVICE_TOKEN = prevToken
})

describe("serviceTokenMatches", () => {
  it("accepts only an exact match", () => {
    expect(serviceTokenMatches(SERVICE_TOKEN, SERVICE_TOKEN)).toBe(true)
    expect(serviceTokenMatches("wrong", SERVICE_TOKEN)).toBe(false)
    expect(serviceTokenMatches(`${SERVICE_TOKEN}x`, SERVICE_TOKEN)).toBe(false)
    expect(serviceTokenMatches(SERVICE_TOKEN.slice(0, -1), SERVICE_TOKEN)).toBe(false)
  })

  it("fails closed when no token is configured", () => {
    // §63.10 — a missing secret must reject, never accept.
    expect(serviceTokenMatches(SERVICE_TOKEN, undefined)).toBe(false)
    expect(serviceTokenMatches(SERVICE_TOKEN, "")).toBe(false)
    expect(serviceTokenMatches(undefined, SERVICE_TOKEN)).toBe(false)
    expect(serviceTokenMatches(undefined, undefined)).toBe(false)
  })
})

describe("service token on the fx routes (plan §63.10)", () => {
  it("serves /api/internal/fx-rates to a valid service token", async () => {
    const t = await seed()
    try {
      const res = await app().request("/api/internal/fx-rates?from=PLN&to=USD&date=2026-09-16", { headers: svc() })
      expect(res.status).toBe(200)
      // same D27 cross-rate the user-credential case asserts: rate(USD)/rate(PLN)
      expect((await res.json()).rate).toBeCloseTo(4.3 / 4.0, 8)
    } finally {
      await t.client.close()
    }
  })

  it("rejects a wrong service token", async () => {
    const t = await seed()
    try {
      const res = await app().request("/api/internal/fx-rates?from=USD&to=PLN", { headers: svc("nope") })
      expect(res.status).toBe(401)
    } finally {
      await t.client.close()
    }
  })

  it("rejects a service token when none is configured (fails closed)", async () => {
    delete process.env.INSTRUMENTS_SERVICE_TOKEN
    const t = await seed()
    try {
      const res = await app().request("/api/internal/fx-rates?from=USD&to=PLN", { headers: svc() })
      expect(res.status).toBe(401)
    } finally {
      await t.client.close()
    }
  })

  it("still requires a credential of some kind", async () => {
    const t = await seed()
    try {
      const res = await app().request("/api/internal/fx-rates?from=USD&to=PLN")
      expect(res.status).toBe(401)
    } finally {
      await t.client.close()
    }
  })

  it("does NOT let a service token read the admin listing", async () => {
    // The sweep has no business reading /api/admin/fx-rates, and a service token
    // fabricates no identity, so requireGroup cannot be satisfied by one.
    const t = await seed()
    try {
      const res = await app().request("/api/admin/fx-rates", { headers: svc() })
      expect(res.status).toBe(401)
    } finally {
      await t.client.close()
    }
  })

  it("keeps the dev X-User-* path working (the user-credential equivalent)", async () => {
    const t = await seed()
    try {
      const res = await app().request("/api/internal/fx-rates?from=USD&to=PLN", { headers: USER_HEADERS })
      expect(res.status).toBe(200)
    } finally {
      await t.client.close()
    }
  })
})

describe("service token on the instruments routes (plan §63.10)", () => {
  const BARS = "/api/instruments/AAA/price-bars?from=2026-01-01&to=2026-01-31"

  it("serves a price-bars request to a valid service token", async () => {
    const t = await seed()
    try {
      const res = await app().request(BARS, { headers: svc() })
      expect(res.status).toBe(200)
      // Empty is the point: the credential is accepted, the data is simply absent.
      expect((await res.json()).dates).toEqual([])
    } finally {
      await t.client.close()
    }
  })

  it("rejects a wrong service token", async () => {
    const t = await seed()
    try {
      const res = await app().request(BARS, { headers: svc("nope") })
      expect(res.status).toBe(401)
    } finally {
      await t.client.close()
    }
  })

  it("still rejects an anonymous request", async () => {
    const t = await seed()
    try {
      const res = await app().request(BARS)
      expect(res.status).toBe(401)
    } finally {
      await t.client.close()
    }
  })
})
