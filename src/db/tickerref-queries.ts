import { sql } from "drizzle-orm"
import type { DB } from "./index.js"
import { tickerReference } from "./schema.js"

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
}

/** Symbol/name/alias search over the reference table. Exact ticker matches
 * rank first, then ticker prefixes, then name/alias substring hits. */
export async function searchTickerReference(db: DB, query: string, limit = 50): Promise<TickerSearchRow[]> {
  const q = query.trim()
  if (q.length === 0) return []
  const upper = q.toUpperCase()
  // Users type venue-qualified symbols like "PKN.WA" / "PKN.US" — the base
  // segment before the dot is the ticker they are actually after.
  const base = upper.split(".")[0]
  const baseCondition =
    base !== upper ? sql` OR ${tickerReference.ticker} ILIKE ${base + "%"}` : sql``
  const baseMatches = base !== upper ? sql`${tickerReference.ticker} ILIKE ${base + "%"}` : sql`FALSE`
  return db
    .select({
      ticker: tickerReference.ticker,
      exchange: tickerReference.exchange,
      name: tickerReference.name,
      assetType: tickerReference.assetType,
      stockSector: tickerReference.stockSector,
      etfCategory: tickerReference.etfCategory,
      country: tickerReference.country,
      countryCode: tickerReference.countryCode,
      isin: tickerReference.isin,
    })
    .from(tickerReference)
    .where(
      sql`${tickerReference.ticker} ILIKE ${upper + "%"}
        OR ${tickerReference.name} ILIKE ${"%" + q + "%"}
        OR ${tickerReference.aliases} ILIKE ${"%" + q + "%"}
        ${baseCondition}`,
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
