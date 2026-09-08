import { mkdtemp, readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const fetchLogo = vi.fn()

vi.mock("./adapters/cachest.js", () => ({
  fetchLogo: (...args: unknown[]) => fetchLogo(...args),
  UpstreamError: class UpstreamError extends Error {},
}))

vi.mock("./db/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./db/index.js")>()
  const { createTestDb } = await import("./db/test-db.js")
  const { db } = await createTestDb()
  return { ...actual, getDb: () => db }
})

import app from "./index.js"
import { getDb } from "./db/index.js"
import { logos } from "./db/schema.js"

describe("GET /health", () => {
  it("returns status ok", async () => {
    const res = await app.request("/health")
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ status: "ok" })
  })
})

describe("GET /api/doc", () => {
  it("returns valid OpenAPI document", async () => {
    const res = await app.request("/api/doc")
    expect(res.status).toBe(200)
    const doc = await res.json()
    expect(doc.openapi).toBe("3.1.0")
    expect(doc.info.title).toBe("Portfoliost API")
    expect(doc.paths["/instruments/search"]).toBeDefined()
    expect(doc.paths["/instruments/{symbol}"]).toBeDefined()
    expect(doc.paths["/instruments/{symbol}/profile"]).toBeDefined()
    expect(doc.paths["/instruments/{symbol}/metrics"]).toBeDefined()
    expect(doc.paths["/instruments/{symbol}/overview-metrics"]).toBeDefined()
    expect(doc.paths["/instruments/{symbol}/quote"]).toBeDefined()
    expect(doc.paths["/instruments/{symbol}/history"]).toBeDefined()
    expect(doc.paths["/news/articles"]).toBeDefined()
  })
})

describe("GET /__meta", () => {
  it("returns module identity per D4", async () => {
    const res = await app.request("/__meta")
    expect(res.status).toBe(200)
    const meta = await res.json()
    expect(meta.service).toBe("instruments")
    expect(meta.impl).toBe("real")
    expect(typeof meta.version).toBe("string")
    expect(meta.version.length).toBeGreaterThan(0)
  })
})

describe("GET /internal/verify", () => {
  it("rejects missing bearer token with 401", async () => {
    const res = await app.request("/internal/verify")
    expect(res.status).toBe(401)
  })

  it("rejects invalid bearer token with 401", async () => {
    const res = await app.request("/internal/verify", {
      headers: { Authorization: "Bearer not-a-jwt" },
    })
    expect(res.status).toBe(401)
  })
})

describe("GET /api/logos/:symbol", () => {
  const PNG = Buffer.from("89504e470d0a1a0a000000", "hex")
  let logosDir: string

  beforeEach(async () => {
    fetchLogo.mockReset()
    fetchLogo.mockResolvedValue({ source: "fmp", remote_url: "https://cdn.test/aapl.png" })
    logosDir = await mkdtemp(path.join(tmpdir(), "logos-"))
    process.env.LOGOS_DIR = logosDir
    await getDb().delete(logos)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("serves a venue-qualified request from the bare-symbol stored logo", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(new Uint8Array(PNG), { status: 200, headers: { "Content-Type": "image/png" } })),
    )

    const first = await app.request("/api/logos/AAPL")
    expect(first.status).toBe(200)
    expect(first.headers.get("Content-Type")).toBe("image/png")
    expect(new Uint8Array(await first.arrayBuffer())).toEqual(new Uint8Array(PNG))
    expect(fetchLogo).toHaveBeenCalledTimes(1)
    expect(fetchLogo).toHaveBeenCalledWith("AAPL")

    // The research overview tab requests the venue-qualified route symbol
    // (AAPL.US) — it must hit the same stored logo, not re-resolve upstream.
    fetchLogo.mockClear()
    const second = await app.request("/api/logos/AAPL.US")
    expect(second.status).toBe(200)
    expect(second.headers.get("Content-Type")).toBe("image/png")
    expect(new Uint8Array(await second.arrayBuffer())).toEqual(new Uint8Array(PNG))
    expect(fetchLogo).not.toHaveBeenCalled()

    const rows = await getDb().select().from(logos)
    expect(rows).toHaveLength(1)
    expect(rows[0].symbol).toBe("AAPL")
    expect(await readFile(path.join(logosDir, "AAPL.png"))).toEqual(PNG)
  })

  it("keeps non-US venue suffixes intact when resolving", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(new Uint8Array(PNG), { status: 200, headers: { "Content-Type": "image/png" } })),
    )

    const res = await app.request("/api/logos/KTY.WA")
    expect(res.status).toBe(200)
    expect(fetchLogo).toHaveBeenCalledTimes(1)
    expect(fetchLogo).toHaveBeenCalledWith("KTY.WA")
    const rows = await getDb().select().from(logos)
    expect(rows).toHaveLength(1)
    expect(rows[0].symbol).toBe("KTY.WA")
  })
})
