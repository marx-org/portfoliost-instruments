type InternalService = "cache" | "wallets"

/**
 * Select one of the service destinations the module is designed to call.
 *
 * These values are configuration, not routing input. Keep the result as a
 * server-owned literal so an environment variable cannot turn a data fetch
 * into a request to an arbitrary host, port, or URL path.
 */
export function internalServiceUrl(value: string | undefined, service: InternalService): string {
  const candidate = value?.trim()

  if (service === "cache") {
    if (!candidate || candidate === "http://cachest:8080") return "http://cachest:8080"
    if (candidate === "http://cachest.pfire.svc.cluster.local:8080") {
      return "http://cachest.pfire.svc.cluster.local:8080"
    }
    if (candidate === "http://openst:8080") return "http://openst:8080"
    if (candidate === "http://openst.pfire.svc.cluster.local:8080") {
      return "http://openst.pfire.svc.cluster.local:8080"
    }
  }

  if (service === "wallets") {
    if (!candidate || candidate === "http://wallets:3000") return "http://wallets:3000"
    if (candidate === "http://portfoliost-wallets:3000") return "http://portfoliost-wallets:3000"
    if (candidate === "http://portfoliost-wallets.pfire.svc.cluster.local:3000") {
      return "http://portfoliost-wallets.pfire.svc.cluster.local:3000"
    }
  }

  throw new Error("upstream URL is not an approved internal service")
}

/**
 * Logo providers used by openst. The redirect is rejected by the caller too:
 * an allow-listed origin must not be able to redirect the fetch to a private
 * or otherwise unintended destination.
 */
export function externalImageUrl(value: string): string | null {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return null
  }

  if (url.protocol !== "https:") return null

  if (url.hostname.toLowerCase() === "images.financialmodelingprep.com") {
    if (!/^\/symbol\/[A-Za-z0-9.-]{1,30}\.png$/.test(url.pathname) || url.search || url.hash) return null
    return `https://images.financialmodelingprep.com${url.pathname}`
  }

  if (url.hostname.toLowerCase() === "www.google.com") {
    const domain = url.searchParams.get("domain")
    if (
      url.pathname !== "/s2/favicons" ||
      !domain ||
      !/^[A-Za-z0-9.-]{1,253}$/.test(domain) ||
      url.searchParams.get("sz") !== "128" ||
      [...url.searchParams.keys()].some((key) => !["domain", "sz"].includes(key))
    ) {
      return null
    }
    return `https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=128`
  }

  return null
}
