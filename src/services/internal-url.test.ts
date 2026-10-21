import { describe, expect, it } from "vitest"
import { externalImageUrl, internalServiceUrl } from "./internal-url.js"

describe("approved upstream URLs", () => {
  it("selects only the known internal service destinations", () => {
    expect(internalServiceUrl(undefined, "cache")).toBe("http://cachest:8080")
    expect(internalServiceUrl("http://openst:8080", "cache")).toBe("http://openst:8080")
    expect(internalServiceUrl("http://cachest.pfire.svc.cluster.local:8080", "cache"))
      .toBe("http://cachest.pfire.svc.cluster.local:8080")
    expect(internalServiceUrl("http://portfoliost-wallets:3000", "wallets"))
      .toBe("http://portfoliost-wallets:3000")
  })

  it("rejects alternate hosts, ports, paths, and schemes", () => {
    for (const value of [
      "http://127.0.0.1:8080",
      "http://cachest:5432",
      "http://cachest:8080/private",
      "https://cachest:8080",
      "http://attacker.svc:8080",
    ]) {
      expect(() => internalServiceUrl(value, "cache")).toThrow()
    }
  })

  it("accepts only the two known logo providers and canonicalizes their URL", () => {
    expect(externalImageUrl("https://images.financialmodelingprep.com/symbol/AAPL.png"))
      .toBe("https://images.financialmodelingprep.com/symbol/AAPL.png")
    expect(externalImageUrl("https://www.google.com/s2/favicons?domain=example.com&sz=128"))
      .toBe("https://www.google.com/s2/favicons?domain=example.com&sz=128")
  })

  it("rejects private, redirected, and unapproved logo destinations", () => {
    for (const value of [
      "http://127.0.0.1:8080/secrets",
      "https://169.254.169.254/latest/meta-data",
      "https://evil.example/logo.png",
      "https://www.google.com/s2/favicons?domain=127.0.0.1&sz=128&redirect=http://evil",
      "not a URL",
    ]) {
      expect(externalImageUrl(value)).toBeNull()
    }
  })
})
