/** Route symbols are venue-qualified for non-US listings (SNT.WA, SAP.DE)
 * and bare tickers for US listings (AAPL, SAP).
 * Provider calls use the full symbol for non-US venues (Yahoo-style suffixes);
 * US providers receive bare tickers — providerSymbol() is a no-op for those. */
export function providerSymbol(routeSymbol: string): string {
  const s = routeSymbol.toUpperCase()
  return s.endsWith(".US") ? s.slice(0, -3) : s
}

/** Exchange suffix of a route symbol, or null (incl. ".US"). */
export function symbolSuffix(routeSymbol: string): string | null {
  const parts = routeSymbol.toUpperCase().split(".")
  if (parts.length < 2 || parts[1] === "US") return null
  return parts[1]
}
