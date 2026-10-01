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

/** Polish open-end fund *category* codes served by the analizy.pl feed
 *  (plan §72.39 step 2). A PPO/PPI broker executes against the category's NAV —
 *  `ING01W` reproduces four of five stored executed prices to the cent — while
 *  every other provider we carry serves only the fund's default category.
 *
 *  **Membership-gated on purpose, because no shape test is safe here.** Three
 *  measurements forced it:
 *
 *  - the code is **not derivable** from a `.TFI` symbol: of ING01's nine
 *    categories only ING01/U/W/T/F resolve, and A/I/K/S/E are 404 upstream.
 *    A `fund + letter` transform would invent codes that do not exist.
 *  - all **941 corp bonds in `ticker_reference` are dotless** (`ABE0227`), so
 *    "dotless" is not a discriminator — the plan assumed it was and was wrong.
 *  - `ticker_reference` holds **35,894 symbols with 0–8 digits** (`A`, `ZTM25`,
 *    `ZOR1142`, `BE01725053`, …), so neither letter-count nor digit-count
 *    separates the namespace. Any regex wide enough to admit `SKR110` also
 *    admits a bond.
 *
 *  The failure modes are lopsided, which is what settles it: a code wrongly
 *  admitted here would reroute a working bond to the fund tier, while a code
 *  wrongly omitted falls through to the equity walk and returns
 *  `200 / bars=0` — the silent shape that nearly shipped a broken mapping
 *  before (reverted 77434fd). So the safe direction is an explicit list, and
 *  adding an entry means resolving it against the source first.
 *
 *  Six of the seven verified against the source 2026-09-30; the Emerytura set
 *  covers the `.TFI` holdings, the Akcji set covers the class-W work.
 */
export const FUND_CATEGORY_CODES: ReadonlySet<string> = new Set([
  // ING Akcji (ING Parasol FIO) — INGAKC.TFI serves the default category,
  // ING01W the one the broker executes against.
  "ING01",
  "ING01W",
  // ING Obligacji — INGOBL.TFI, the sheet's folded "nn obligacji".
  "ING04",
  // ING Emerytura SFIO — the NNEP*.TFI holdings.
  "ING81", // 2025
  "ING82", // 2030
  "ING88", // 2060
  "ING92", // 2065
])

/** Whether a route symbol is an analizy.pl fund-category code (e.g. `ING01W`).
 *
 *  Venue-free on purpose: these codes have no venue, so `ING01W.WA` resolves the
 *  same as `ING01W` — the same rule `venueFreeSymbol` applies to bonds. */
export function isFundCategory(routeSymbol: string): boolean {
  return FUND_CATEGORY_CODES.has(venueFreeSymbol(routeSymbol.toUpperCase()))
}
