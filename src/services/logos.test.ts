import { mkdir, mkdtemp, readFile, readdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const fetchLogo = vi.fn()

vi.mock("../adapters/cachest.js", () => ({
  fetchLogo: (...args: unknown[]) => fetchLogo(...args),
  UpstreamError: class UpstreamError extends Error {},
}))

vi.mock("../db/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../db/test-db.js")>()
  const { createTestDb } = await import("../db/test-db.js")
  const { db } = await createTestDb()
  return { ...actual, getDb: () => db }
})

import { getDb } from "../db/index.js"
import { logos } from "../db/schema.js"
import { initialsSvg, serveLogo } from "./logos.js"

function honoContext() {
  const headers = new Headers()
  const ctx = {
    req: { param: () => "AAPL" },
    header: (name: string, value: string) => headers.set(name, value),
    body: (data: BodyInit | null, status = 200, init?: { "Content-Type"?: string }) => {
      const resHeaders = new Headers(init)
      if (!resHeaders.has("Content-Type") && typeof data === "string") {
        resHeaders.set("Content-Type", "text/plain")
      }
      for (const [k, v] of headers) resHeaders.set(k, v)
      return new Response(data, { status, headers: resHeaders })
    },
  } as never
  return { ctx, headers }
}

let logosDir: string
let cwdSpy: ReturnType<typeof vi.spyOn>

beforeEach(async () => {
  fetchLogo.mockReset()
  const root = await mkdtemp(path.join(tmpdir(), "logos-"))
  logosDir = path.join(root, "data", "logos")
  await mkdir(logosDir, { recursive: true })
  cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(root)
  await getDb().delete(logos)
})

afterEach(() => {
  cwdSpy.mockRestore()
  vi.unstubAllGlobals()
})

const PNG = Buffer.from("89504e470d0a1a0a000000", "hex")

describe("serveLogo", () => {
  it("resolves via cachest, persists file and metadata row", async () => {
    fetchLogo.mockResolvedValue({ source: "fmp", remote_url: "https://images.financialmodelingprep.com/symbol/AAPL.png" })
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(new Uint8Array(PNG), { status: 200, headers: { "Content-Type": "image/png" } })),
    )
    const { ctx } = honoContext()

    const res = await serveLogo(ctx, "AAPL")

    expect(res.status).toBe(200)
    expect(res.headers.get("Content-Type")).toBe("image/png")
    expect(await readFile(path.join(logosDir, "AAPL.png"))).toEqual(PNG)
    const rows = await getDb().select().from(logos)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ symbol: "AAPL", source: "fmp", bytes: PNG.length })
  })

  it("serves stored file without calling upstream again", async () => {
    fetchLogo.mockResolvedValue({ source: "fmp", remote_url: "https://images.financialmodelingprep.com/symbol/AAPL.png" })
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(new Uint8Array(PNG), { status: 200, headers: { "Content-Type": "image/png" } })),
    )
    await serveLogo(honoContext().ctx, "AAPL")
    expect(fetchLogo).toHaveBeenCalledTimes(1)

    fetchLogo.mockClear()
    const { ctx } = honoContext()
    const res = await serveLogo(ctx, "aapl")

    expect(res.status).toBe(200)
    expect(fetchLogo).not.toHaveBeenCalled()
    expect(res.headers.get("Cache-Control")).toContain("immutable")
  })

  it("falls back to deterministic initials and persists nothing", async () => {
    fetchLogo.mockRejectedValue(new Error("upstream down"))
    const { ctx } = honoContext()

    const res = await serveLogo(ctx, "KTY.WA")

    expect(res.status).toBe(200)
    expect(res.headers.get("Content-Type")).toBe("image/svg+xml")
    expect(await res.text()).toContain(">KTY<")
    expect(await readdir(logosDir)).toHaveLength(0)
    expect(await getDb().select().from(logos)).toHaveLength(0)
  })

  it("deduplicates concurrent resolutions via single-flight", async () => {
    fetchLogo.mockResolvedValue({ source: "fmp", remote_url: "https://images.financialmodelingprep.com/symbol/MSFT.png" })
    let releaseFetch!: (v: Response) => void
    const fetchMock = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          releaseFetch = resolve
        }),
    )
    vi.stubGlobal("fetch", fetchMock)

    const first = serveLogo(honoContext().ctx, "MSFT")
    const second = serveLogo(honoContext().ctx, "MSFT")
    await vi.waitFor(() => {
      if (!fetchMock.mock.calls.length) throw new Error("fetch not yet called")
    })
    releaseFetch(new Response(new Uint8Array(PNG), { status: 200, headers: { "Content-Type": "image/png" } }))
    await Promise.all([first, second])

    expect(fetchLogo).toHaveBeenCalledTimes(1)
  })

  it("does not fetch an unapproved logo destination", async () => {
    fetchLogo.mockResolvedValue({ source: "fmp", remote_url: "http://127.0.0.1:8080/secrets" })
    const fetchMock = vi.fn()
    vi.stubGlobal("fetch", fetchMock)

    const res = await serveLogo(honoContext().ctx, "AAPL")

    expect(res.status).toBe(200)
    expect(fetchMock).not.toHaveBeenCalled()
    expect(await res.text()).toContain(">AAP<")
  })

  it("initialsSvg is deterministic per symbol", () => {
    expect(initialsSvg("kty.wa")).toBe(initialsSvg("KTY.WA"))
    expect(initialsSvg("KTY.WA")).toContain("hsl(")
  })
})
