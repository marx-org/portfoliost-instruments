/**
 * §36 — resolve the ISO-4217 currency an instrument trades in.
 *
 * The provider tier (openst) does not expose a currency per OHLCV series, so
 * the instruments module resolves it locally from facts it already holds:
 *
 *   1. crypto pair form (BTC-USD)  → the pair's quote currency
 *   2. bond (savings-bond engine)  → PLN (obligacje prices in PLN)
 *   3. corp_bond / fund (.WA/.TFI) → PLN (biznesradar Catalyst/TFI universe)
 *   4. venue suffix + a listing for THAT venue → the listing's country
 *   5. venue suffix, listing absent      → the VENUE's country (WSE → PL → PLN)
 *   6. no venue hint: exact listings must agree, else null
 *   7. anything else → null (NOT "USD" — plan §47: never guess)
 *
 * Every branch is either a parse (1), a market-structure rule (2, 3, 5), or an
 * unambiguous fact read off a listing (4, 6). §71 removed the two that were not:
 * an unfiltered cross-venue search when a venue was already known, and reading a
 * currency off a prefix/name match. A currency is a label that MULTIPLIES a
 * number, so a wrong one does not fail — it silently produces a plausible total,
 * which is exactly how CRI.WA was priced in CAD.
 *
 * DB lookups degrade to ``null``, never a guessed code: the SPA takes the
 * ``currencySource`` signal ("estimated" vs "unknown") to red-flag it.
 */
import { CURRENCIES } from "@marx2/contracts/currencies"
import type { DB } from "../db/index.js"
import {
  assetTypeForSymbol,
  curatedListingOverrideForSymbol,
  getExchangeBySuffix,
  getExchangeCountry,
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
  /**
   * §72.4 — the venue the bars were actually fetched from, when the CALLER knows
   * it. Optional and unused by every existing caller, so nothing changes until a
   * route is wired to pass it.
   *
   * **Why this exists.** A venue-free ticker on a cross-listed company
   * (`MFC` on NYSE→USD *and* TSX→CAD) makes the candidates-must-agree guard
   * return `null`, which is correct — with no venue named there is no honest
   * answer. The damage was done after that: `resolveCurrency`'s fallback took
   * the provider's declaration, and a provider declares the issuer's **primary**
   * listing. PROD served `currency: CAD` for an instrument whose
   * `exchange` was `NYQ` and whose bar was a USD number (17.29 against a stored
   * trade of 17.50 USD), so every consumer trusting the declared currency
   * converted a correct number into a wrong one. 21 symbols in the price-audit,
   * 18 of which reconcile to under 3% with no conversion at all.
   *
   * A hint is a **fact about which listing the data came from**, not a guess, so
   * it outranks both the ambiguity guard and the provider — consistent with §47.4,
   * where local resolution already wins over a provider mismatch.
   */
  exchangeHint?: string | null,
): Promise<string | null> {
  const symbol = routeSymbol.toUpperCase()
  const pairCcy = cryptoPairCurrency(symbol)
  if (pairCcy) return pairCcy
  if (!db) return null
  try {
    const curated = await curatedListingOverrideForSymbol(db, symbol, exchangeHint)
    if (curated) return curated.quoteCurrency.toUpperCase()
    // §72.4 — a known venue is a FACT, so it is consulted before anything that
    // would have to guess. Deliberately AFTER the crypto pair test (BTC-USD is
    // denominated by its quote leg regardless of any venue) and before the bond /
    // fund PLN shortcut, which is about instrument CLASS not venue.
    //
    // Placed before the ambiguity guard, not after: for a cross-listed ticker the
    // guard returns null, and returning null is what let the provider's
    // home-market currency in. A hint is strictly more information than the guard
    // has, so it has to be able to answer where the guard cannot.
    if (exchangeHint) {
      const byVenue = currencyForCountry(await getExchangeCountry(db, exchangeHint))
      if (byVenue) return byVenue
      // An exchange we cannot map to a country is not an answer — fall through
      // rather than invent one.
    }
    const assetType: AssetType = normalizeAssetType(await assetTypeForSymbol(db, symbol))
    if (assetType === "bond" || assetType === "corp_bond" || assetType === "fund") {
      // Savings bonds (obligacje engine) and the biznesradar Catalyst/TFI
      // universe are priced in PLN.
      return "PLN"
    }

    const suffix = symbolSuffix(symbol)
    if (suffix) {
      // ── venue-qualified: the suffix names WHERE it trades, so another venue's
      // listing of the same bare ticker is not evidence about this one.
      const exchange = await getExchangeBySuffix(db, suffix)
      if (!exchange) {
        // No exchange_reference row for this suffix. Before refusing, accept a
        // listing that records the venue in the ticker itself ("SNT.WA" on WSE) —
        // that row states its own venue, so it is evidence rather than a guess,
        // and it keeps the resolver working when exchange data is incomplete.
        const selfQualified = (await searchTickerReference(db, symbol, 1, null)).find(
          (r) => r.ticker === symbol && r.countryCode,
        )
        return selfQualified ? currencyForCountry(selfQualified.countryCode) : null
      }
      const base = venueFreeSymbol(symbol)
      const rows = await searchTickerReference(db, symbol, 1, exchange)
      // Accept the listing written either bare ("SNT", the production shape) or
      // venue-qualified ("SNT.WA") — both denote the same security, and the
      // exchange check below is what actually scopes it. Matching only one form
      // turns a reference-data spelling difference into a silent null.
      const exact = rows.find(
        (r) => (r.ticker === base || r.ticker === symbol) && r.exchange === exchange.toUpperCase(),
      )
      if (exact) return currencyForCountry(exact.countryCode)
      // §71 — the listing is missing from the reference, but the VENUE is known.
      // Return the venue's own currency (WSE → PL → PLN) and nothing more.
      //
      // This branch is where CRI.WA used to be priced in Canadian dollars. The
      // venue-qualified lookup missed (CRI has no WSE row), and the search then
      // fell through to an UNFILTERED `ticker ILIKE 'CRI%'`, whose first exact
      // match was CRI/TSXV/CA. Because a venue *was* resolved, the
      // candidates-must-agree guard was skipped too, so a single arbitrary row
      // decided the currency: 9,451 PLN became 9,451 CAD and the live headline
      // overstated this one position by 16,190 PLN (×2.7131). The stored price
      // bars were never affected — they arrive pre-converted to the portfolio
      // base currency — so the two valuation paths silently disagreed by 18%.
      return currencyForCountry(await getExchangeCountry(db, exchange))
    }

    // ── no venue hint: the ticker alone must be unambiguous.
    //
    // Candidates must agree; a genuine collision (AFL: ASX/AUD vs NYSE/USD,
    // META: NASDAQ/USD vs LSE/EUR) is silence, not a coin flip (plan §47).
    // MSFT matching NASDAQ and NEO is not a collision — both are US, so USD is
    // a fact about the candidates rather than a guess about the ticker.
    const rows = await searchTickerReference(db, symbol, 10, null)
    const base = venueFreeSymbol(symbol)
    const candidates = rows.filter((r) => r.ticker === base)
    if (candidates.length === 0) {
      // §71 — no exact listing. The remaining rows are PREFIX or name/alias
      // matches ("CRI%" also matches CRIS, CRISIL, CRIMSON…), and reading a
      // currency off those is a guess about a different security. Refuse.
      return null
    }
    const codes = new Set(
      candidates.map((r) => currencyForCountry(r.countryCode)).filter((c): c is string => c !== null),
    )
    return codes.size === 1 ? [...codes][0] : null
  } catch {
    return null
  }
}

/** §39 — OpenBB labels LSE pence quotes "GBp"; the ISO code is "GBP".
 * "GBp" and "GBP" collide once lowercased, so the ISO code is excluded
 * case-sensitively (mirrors translate.ts isPence). Exported so the price-bars
 * series-label path can normalize the provider's declaration the same way. */
export function normalizeProviderDeclaration(currency: string | null | undefined): string | null {
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
  /**
   * §72.4 — the venue the underlying data came from, when known. Threaded to
   * `resolveInstrumentCurrency`; see its docstring for the defect this closes.
   *
   * A venue answer is LOCAL resolution, so it reports `currencySource:
   * "estimated"` even when it disagrees with the provider — §47.4 already ranks
   * local above a provider mismatch, and calling it `"provider"` would tell a
   * consumer the upstream said so, which is the false confidence that let this
   * reach PROD.
   */
  exchangeHint?: string | null,
): Promise<CurrencyResolution> {
  const provider = normalizeProviderDeclaration(providerCurrency)
  const local = await resolveInstrumentCurrency(db, routeSymbol, exchangeHint)
  if (provider) {
    if (provider === local) return { currency: provider, currencySource: "provider" }
    if (local) return { currency: local, currencySource: "estimated" }
    return { currency: provider, currencySource: "provider" }
  }
  if (local) return { currency: local, currencySource: "estimated" }
  return { currency: null, currencySource: "unknown" }
}
