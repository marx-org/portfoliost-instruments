/**
 * §36 — resolve the ISO-4217 currency an instrument trades in.
 *
 * The provider tier (openst) does not expose a currency per OHLCV series, so
 * the instruments module resolves it locally from facts it already holds:
 *
 *   1. crypto pair form (BTC-USD)  → the pair's quote currency
 *   2. bond (savings-bond engine)  → PLN (obligacje prices in PLN)
 *   3. corp_bond / fund (.WA/.TFI) → PLN (biznesradar Catalyst/TFI universe)
 *   4. ticker_reference.country_code → ISO-4217 map
 *   5. everything else             → null (NOT "USD" — plan §47: never guess)
 *
 * DB lookups degrade to ``null``, never a guessed code: the SPA takes the
 * ``currencySource`` signal ("estimated" vs "unknown") to red-flag it.
 */
import { CURRENCIES } from "@marx2/contracts/currencies"
import type { DB } from "../db/index.js"
import {
  assetTypeForSymbol,
  getExchangeBySuffix,
  normalizeAssetType,
  searchTickerReference,
  type AssetType,
} from "../db/tickerref-queries.js"
import { symbolSuffix, venueFreeSymbol } from "../adapters/symbol.js"

/** How an instrument's ``currency`` was determined (contract CurrencySource, §47.3). */
export type CurrencySource = "provider" | "estimated" | "unknown"

/** Currency + sourcing signal, as served on quote/profile/history (§47.4). */
export interface CurrencyResolution {
  currency: string | null
  currencySource: CurrencySource
}

/** ISO-4217 for the currencies the contract catalog knows (upper-cased codes). */
const KNOWN_CODES = new Set(CURRENCIES.map((c) => c.code))

const PAIR_CURRENCIES = ["USD", "EUR", "PLN", "GBP", "CHF", "JPY"]

/** ISO-2 country code → ISO-4217 currency. EU members map to EUR. */
const COUNTRY_CURRENCY: Record<string, string> = {
  PL: "PLN",
  US: "USD",
  GB: "GBP",
  DE: "EUR",
  FR: "EUR",
  IT: "EUR",
  ES: "EUR",
  NL: "EUR",
  AT: "EUR",
  IE: "EUR",
  FI: "EUR",
  PT: "EUR",
  BE: "EUR",
  GR: "EUR",
  SK: "EUR",
  SI: "EUR",
  EE: "EUR",
  LV: "EUR",
  LT: "EUR",
  CY: "EUR",
  MT: "EUR",
  HR: "EUR",
  CZ: "CZK",
  HU: "HUF",
  SE: "SEK",
  NO: "NOK",
  DK: "DKK",
  CH: "CHF",
  JP: "JPY",
  KR: "KRW",
  CN: "CNY",
  HK: "HKD",
  TW: "TWD",
  IN: "INR",
  AU: "AUD",
  CA: "CAD",
  BR: "BRL",
  MX: "MXN",
  ZA: "ZAR",
  IL: "ILS",
  TR: "TRY",
  RO: "RON",
  BG: "BGN",
  CL: "CLP",
  SG: "SGD",
  NZ: "NZD",
  PH: "PHP",
  TH: "THB",
  ID: "IDR",
  MY: "MYR",
  VN: "VND",
}

function currencyForCountry(countryCode: string | null | undefined): string | null {
  const c = (countryCode ?? "").toUpperCase()
  const mapped = COUNTRY_CURRENCY[c]
  return mapped && KNOWN_CODES.has(mapped) ? mapped : null
}

/** Quote currency of a crypto pair (BTC-USD → USD); null for non-pairs. */
export function cryptoPairCurrency(symbol: string): string | null {
  const base = venueFreeSymbol(symbol).toUpperCase()
  const idx = base.lastIndexOf("-")
  if (idx === -1) return null
  const quote = base.slice(idx + 1)
  return PAIR_CURRENCIES.includes(quote) ? quote : null
}

/**
 * Resolve the trading currency for a route symbol (SNT.WA, AAPL, BTC-USD,
 * ROD1033…). Pure local lookup — no upstream HTTP. Returns an ISO-4217 code
 * when the symbol type/country is known, ``null`` on any uncertainty (plan
 * §47 — never guess USD; consumers read ``currencySource`` to differentiate).
 */
export async function resolveInstrumentCurrency(
  db: DB | null,
  routeSymbol: string,
): Promise<string | null> {
  const symbol = routeSymbol.toUpperCase()
  const pairCcy = cryptoPairCurrency(symbol)
  if (pairCcy) return pairCcy
  if (!db) return null
  try {
    const assetType: AssetType = normalizeAssetType(await assetTypeForSymbol(db, symbol))
    if (assetType === "bond" || assetType === "corp_bond" || assetType === "fund") {
      // Savings bonds (obligacje engine) and the biznesradar Catalyst/TFI
      // universe are priced in PLN.
      return "PLN"
    }
    const suffix = symbolSuffix(symbol)
    const exchange = suffix ? await getExchangeBySuffix(db, suffix) : null
    const rows = await searchTickerReference(db, symbol, 1, exchange)
    const row = rows[0]
    if (row && row.countryCode) return currencyForCountry(row.countryCode)
    return null
  } catch {
    return null
  }
}

/** §39 — OpenBB labels LSE pence quotes "GBp"; the ISO code is "GBP".
 * "GBp" and "GBP" collide once lowercased, so the ISO code is excluded
 * case-sensitively (mirrors translate.ts isPence). */
function normalizeProviderDeclaration(currency: string | null | undefined): string | null {
  const c = (currency ?? "").trim()
  if (!c) return null
  if (c !== "GBP" && c.toLowerCase() === "gbp") return "GBP"
  return c.toUpperCase()
}

/**
 * Compare the provider's declared currency against the local resolver and
 * derive the ``currency`` + ``currencySource`` pair served to clients (§47.4):
 *
 * - provider declared AND matches local       → provider value, ``provider``
 * - provider declared but local differs      → local value, ``estimated``
 *   (the local, instrument-aware resolution wins over a provider mismatch)
 * - provider declared, local silent          → provider value, ``provider``
 *   (a real declaration is never downgraded by a silence)
 * - provider silent, local resolved          → local value, ``estimated``
 * - both silent                              → ``null``, ``unknown``
 */
export async function resolveCurrency(
  db: DB | null,
  routeSymbol: string,
  providerCurrency: string | null | undefined,
): Promise<CurrencyResolution> {
  const provider = normalizeProviderDeclaration(providerCurrency)
  const local = await resolveInstrumentCurrency(db, routeSymbol)
  if (provider) {
    if (provider === local) return { currency: provider, currencySource: "provider" }
    if (local) return { currency: local, currencySource: "estimated" }
    return { currency: provider, currencySource: "provider" }
  }
  if (local) return { currency: local, currencySource: "estimated" }
  return { currency: null, currencySource: "unknown" }
}
