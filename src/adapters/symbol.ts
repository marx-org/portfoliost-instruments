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

/** Retail savings-bond emission codes (ROD/EDO + 4 digits). These are never
 * exchange-listed and never appear in `ticker_reference` (they are imported
 * separately by the openst bond job) — the obligacje engine is their price
 * source. Single source of truth for the bond-tier routing (plan §37.1). */
export const SAVINGS_BOND = /^(ROD|EDO)\d{4}$/

/** Whether a route symbol (any venue form) is a savings-bond emission. */
export function isSavingsBond(routeSymbol: string): boolean {
  return SAVINGS_BOND.test(venueFreeSymbol(routeSymbol.toUpperCase()))
}

/** The crypto tier keys on the -USD pair; a bare stored ticker (BTC) has to
 *  become BTC-USD or the tier 404s on it. Shared by the quote dispatcher and the
 *  profile route so the two cannot drift into different pair conventions. */
export function cryptoPairFor(routeSymbol: string): string {
  const base = venueFreeSymbol(routeSymbol.toUpperCase())
  return base.includes("-") ? base : `${base}-USD`
}
