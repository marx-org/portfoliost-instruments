import { afterEach, describe, expect, it, vi } from "vitest"
import {
  UpstreamError,
  fetchCorpBondProfile,
  fetchCryptoProfile,
} from "./cachest.js"

function stubFetch(body: unknown, status = 200) {
  const seen: string[] = []
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      seen.push(url)
      return new Response(JSON.stringify(body), { status })
    }),
  )
  return seen
}

describe("fetchCorpBondProfile (§86)", () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("calls cachest /corp-bond/profile/{symbol}", async () => {
    const seen = stubFetch({ symbol: "BST0327", issuer: "Best S.A." })

    const row = await fetchCorpBondProfile("BST0327")

    expect(seen).toHaveLength(1)
    expect(new URL(seen[0]).pathname).toBe("/corp-bond/profile/BST0327")
    expect(row).toEqual({ symbol: "BST0327", issuer: "Best S.A." })
  })

  it("URL-encodes the Catalyst code", async () => {
    const seen = stubFetch({})

    await fetchCorpBondProfile("BST 0327/A")

    expect(seen[0]).toContain("/corp-bond/profile/BST%200327%2FA")
  })

  it("turns a 404 into an UpstreamError carrying the status", async () => {
    // Deliberately not swallowed: the profile route needs to distinguish "not a
    // Catalyst bond" from "cachest is unreachable" before it picks a fallback.
    stubFetch({ detail: "No corporate-bond profile" }, 404)

    await expect(fetchCorpBondProfile("AAPL")).rejects.toBeInstanceOf(UpstreamError)
    await expect(fetchCorpBondProfile("AAPL")).rejects.toThrow(/upstream 404/)
  })

  it("propagates a 500 as an UpstreamError too", async () => {
    stubFetch({}, 500)
    await expect(fetchCorpBondProfile("BST0327")).rejects.toThrow(/upstream 500/)
  })
})

describe("fetchCryptoProfile (§86)", () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("calls cachest /crypto/profile/{pair}", async () => {
    const seen = stubFetch({ symbol: "BTC-USD", currency: "USD" })

    const row = await fetchCryptoProfile("BTC-USD")

    expect(seen).toHaveLength(1)
    expect(new URL(seen[0]).pathname).toBe("/crypto/profile/BTC-USD")
    expect(row).toEqual({ symbol: "BTC-USD", currency: "USD" })
  })

  it("URL-encodes a pair whose quote currency needs escaping", async () => {
    const seen = stubFetch({})

    await fetchCryptoProfile("BTC-USD/EUR")

    // The slash is data here: unescaped it would read as a second path segment.
    expect(seen[0]).toContain("/crypto/profile/BTC-USD%2FEUR")
    expect(new URL(seen[0]).pathname).toBe("/crypto/profile/BTC-USD%2FEUR")
  })

  it("turns a 404 into an UpstreamError carrying the status", async () => {
    stubFetch({ detail: "No profile" }, 404)

    const error = await fetchCryptoProfile("NOPE-USD").catch((e: unknown) => e)

    expect(error).toBeInstanceOf(UpstreamError)
    expect((error as UpstreamError).status).toBe(404)
  })
})