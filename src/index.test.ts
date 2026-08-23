import { describe, it, expect } from "vitest"
import app from "./index.js"

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
