import { sql } from "drizzle-orm"
import type { DB } from "./index.js"
import { exchangeReference, tickerReference } from "./schema.js"

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
