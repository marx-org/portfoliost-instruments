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

/** Query key for tiers that key on the bare, unqualified symbol (the bond and
 * crypto catalogues): cut any trailing venue suffix (".WA", ".US", …). Unlike
 * providerSymbol() every suffix is dropped here — these tiers have no venues,
 * so "ROD1033.WA" must resolve the same row as "ROD1033". */
export function venueFreeSymbol(routeSymbol: string): string {
  const idx = routeSymbol.lastIndexOf(".")
  return idx === -1 ? routeSymbol : routeSymbol.slice(0, idx)
}
