import { sql } from "drizzle-orm"
import type { DB } from "./index.js"
import { exchangeReference, tickerReference } from "./schema.js"
import { isSavingsBond, venueFreeSymbol } from "../adapters/symbol.js"

/** Canonical asset-class set for price-bars (D81) and quote (34) dispatch. */
export type AssetType = "stock" | "etf" | "fund" | "crypto" | "bond" | "corp_bond"

/** Map a stored `ticker_reference.asset_type` (mixed case: "Stock", "ETF", "CRYPTO",
 * "corp_bond", …) onto the canonical routing set. Unknown values fall back to `stock`,
 * preserving the existing equity/stooq path. */
export function normalizeAssetType(raw: string | null | undefined): AssetType {
  const v = (raw ?? "").trim().toLowerCase()
  if (v === "etf") return "etf"
  if (v === "fund" || v === "tfi" || v === "funds") return "fund"
  if (v === "crypto" || v === "cryptocurrency") return "crypto"
  if (v === "bond") return "bond"
  if (v === "corp_bond" || v === "corporate_bond" || v === "corporate bond") return "corp_bond"
  return "stock"
}

/**
 * Currency suffixes that form a crypto pair on a stored ticker (BTC-USD).
 * Only these are stripped for the reference lookup — class suffixes like the
 * catalyst `BOS0735-K` are never stripped.
 */
const PAIR_CURRENCIES = ["USD", "EUR", "PLN", "GBP", "CHF", "JPY"]

/**
 * Reference-table lookup keys for a route symbol: the bare venue-free ticker,
 * plus its base when it is a currency pair (`BTC-USD` → `BTC`, where the
 * reference rows live).
 */
export function referenceTickerKeys(symbol: string): string[] {
  const base = venueFreeSymbol(symbol).toUpperCase()
  const keys = [base]
  for (const ccy of PAIR_CURRENCIES) {
    if (base.endsWith(`-${ccy}`)) {
      keys.push(base.slice(0, -(`-${ccy}`).length))
      break
    }
  }
  return [...new Set(keys)]
}

/**
 * Resolve a symbol's asset class from `ticker_reference` (D81, shared with the
 * plan-34 quote dispatch). Matches the bare venue-free ticker against the
 * reference table (venue-qualified `SNT.WA` / US `AAPL.US` resolve to their
 * bare ticker; crypto pairs resolve to their base coin). Returns `null` when
 * the reference table is absent or the symbol is not listed — callers treat
 * that as `stock`.
 */
export async function assetTypeForSymbol(db: DB, symbol: string): Promise<string | null> {
  // Savings bonds are never in ticker_reference (imported separately by the
  // openst bond job) but must route to the obligajes bond tier, not degrade to
  // stock and pay the equity provider walk (plan §37.1, OOM storm 2026-09-20).
  if (isSavingsBond(symbol)) return "bond"
  const keys = referenceTickerKeys(symbol)
  if (keys.length === 0) return null
  // Cross-exchange tickers collide (BTC is an ASX stock AND a crypto pair):
  // when several classes match, the specific one (crypto/bond/corp_bond/fund)
  // wins deterministically — it is the class the price-routing fix targets,
  // while stock/etf is the default fallback anyway.
  const rows = await db
    .select({ assetType: tickerReference.assetType })
    .from(tickerReference)
    .where(sql`${tickerReference.ticker} in (${sql.join(keys.map((k) => sql`${k}`), sql`, `)})`)
    .orderBy(sql`case when upper(${tickerReference.assetType}) in ('STOCK', 'ETF') then 1 else 0 end`)
    .limit(1)
  return rows[0]?.assetType ?? null
}

export interface TickerSearchRow {
  ticker: string
  exchange: string
  name: string
  assetType: string
  stockSector: string | null
  etfCategory: string | null
  country: string | null
  countryCode: string | null
  isin: string | null
  yahooSuffix: string | null
}

/** Resolve a Yahoo-style venue suffix (WA, DE, L…) to the reference exchange
 * code (WSE, XETRA, LSE…) via the exchange_reference table. */
export async function getExchangeBySuffix(db: DB, suffix: string): Promise<string | null> {
  const rows = await db
    .select({ code: exchangeReference.exchangeCode })
    .from(exchangeReference)
    .where(sql`UPPER(${exchangeReference.yahooSuffix}) = ${suffix.toUpperCase()}`)
    .limit(1)
  return rows[0]?.code ?? null
}

/** The reference country an exchange operates in (WSE → "PL", TSX → "CA").
 *
 * §71 — this is how a venue-qualified symbol with NO listing in
 * `ticker_reference` still resolves a currency: the venue is a known fact
 * about where the security trades, which is not the same kind of claim as
 * inferring a currency from some other venue's listing of the same bare
 * ticker. See {@link resolveInstrumentCurrency}. */
export async function getExchangeCountry(db: DB, exchangeCode: string): Promise<string | null> {
  const rows = await db
    .select({ countryCode: exchangeReference.countryCode })
    .from(exchangeReference)
    .where(sql`UPPER(${exchangeReference.exchangeCode}) = ${exchangeCode.toUpperCase()}`)
    .limit(1)
  return rows[0]?.countryCode ?? null
}

/**
 * Venue code that marks a `ticker_reference` row as an analizy.pl fund category
 * (plan §78). The catalogue sync writes `ANALIZY::{CODE}` rows; this constant is
 * what the price tier reads, so the venue column carries routing meaning rather
 * than being decorative.
 */
export const FUND_CATEGORY_VENUE = "ANALIZY"

/**
 * Resolve a symbol's price tier from `ticker_reference.exchange` (plan §78).
 *
 * Replaces the hardcoded code list §72.39 step 5 shipped: the reference table
 * already answers "is this a provider category key?", and duplicating that answer
 * in routing code was a second source of truth free to drift from the catalogue.
 * An unknown symbol is `standard` — the pre-existing behaviour.
 */
export async function priceTierForSymbol(
  db: DB,
  symbol: string,
): Promise<"standard" | "fund_category"> {
  const keys = referenceTickerKeys(symbol)
  if (keys.length === 0) return "standard"
  const rows = await db
    .select({ exchange: tickerReference.exchange })
    .from(tickerReference)
    .where(sql`${tickerReference.ticker} in (${sql.join(keys.map((k) => sql`${k}`), sql`, `)})`)
    .limit(1)
  return rows[0]?.exchange === FUND_CATEGORY_VENUE ? "fund_category" : "standard"
}

/** Symbol/name/alias search over the reference table. Exact ticker matches
 * rank first, then ticker prefixes, then name/alias substring hits. */
export async function searchTickerReference(
  db: DB,
  query: string,
  limit = 50,
  exchange?: string | null,
): Promise<TickerSearchRow[]> {
  const q = query.trim()
  if (q.length === 0) return []
  const upper = q.toUpperCase()
  const select = {
    ticker: tickerReference.ticker,
    exchange: tickerReference.exchange,
    name: tickerReference.name,
    assetType: tickerReference.assetType,
    stockSector: tickerReference.stockSector,
    etfCategory: tickerReference.etfCategory,
    country: tickerReference.country,
    countryCode: tickerReference.countryCode,
    isin: tickerReference.isin,
    yahooSuffix: exchangeReference.yahooSuffix,
  }
  // Venue-qualified lookup (route symbol suffix → exchange): when the exact
  // listing exists, return it alone — cross-exchange ticker collisions
  // (SNT on WSE vs North America) must not bleed into each other.
  if (exchange) {
    // The query may arrive venue-qualified (SNT.WA) — the reference table
    // stores the bare ticker (SNT).
    const baseTicker = upper.split(".")[0]
    const exact = await db
      .select(select)
      .from(tickerReference)
      .leftJoin(exchangeReference, sql`${exchangeReference.exchangeCode} = ${tickerReference.exchange}`)
      .where(sql`${tickerReference.ticker} = ${baseTicker} AND ${tickerReference.exchange} = ${exchange.toUpperCase()}`)
      .limit(1)
    if (exact.length > 0) return exact
  }
  // Users type venue-qualified symbols like "PKN.WA" / "PKN.US" — the base
  // segment before the dot is the ticker they are actually after.
  const base = upper.split(".")[0]
  const baseCondition =
    base !== upper ? sql` OR ${tickerReference.ticker} ILIKE ${base + "%"}` : sql``
  const baseMatches = base !== upper ? sql`${tickerReference.ticker} ILIKE ${base + "%"}` : sql`FALSE`
  const isIsin = upper.length === 12
  const isinCondition = isIsin ? sql` OR upper(${tickerReference.isin}) = ${upper}` : sql``
  return db
    .select(select)
    .from(tickerReference)
    .leftJoin(exchangeReference, sql`${exchangeReference.exchangeCode} = ${tickerReference.exchange}`)
    .where(
      sql`${tickerReference.ticker} ILIKE ${upper + "%"}
        OR ${tickerReference.name} ILIKE ${"%" + q + "%"}
        OR ${tickerReference.aliases} ILIKE ${"%" + q + "%"}
        ${baseCondition}
        ${isinCondition}`,
    )
    .orderBy(
      sql`CASE
          WHEN ${tickerReference.ticker} = ${upper} THEN 0
          WHEN ${tickerReference.ticker} ILIKE ${upper + "%"} THEN 1
          WHEN ${baseMatches} THEN 1
          ELSE 2 END`,
      sql`length(${tickerReference.ticker})`,
      tickerReference.ticker,
    )
    .limit(limit)
}
