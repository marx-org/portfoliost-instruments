/** Route symbols are venue-qualified: AAPL.US, SNT.WA, SNT.TO…
 * Provider calls use the full symbol for non-US venues (Yahoo-style suffixes,
 * e.g. SNT.WA) so provider chains fall through to yfinance for markets FMP
 * doesn't cover; ".US" is stripped because US providers want bare tickers. */
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
