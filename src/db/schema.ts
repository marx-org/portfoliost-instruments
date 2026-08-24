import { index, pgSchema, text, timestamp } from "drizzle-orm/pg-core"

export const instrumentsSchema = pgSchema("instruments")

/**
 * Venue/exchange metadata synced from adanos canonical_v4/venues.csv,
 * enriched with Yahoo suffixes maintained in seed/exchange_suffixes.csv
 * (Yahoo's venue convention is not part of the upstream dataset).
 */
export const exchangeReference = instrumentsSchema.table("exchange_reference", {
  exchangeCode: text("exchange_code").primaryKey(),
  operatingMic: text("operating_mic"),
  canonicalName: text("canonical_name"),
  countryCode: text("country_code"),
  yahooSuffix: text("yahoo_suffix"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
})

/**
 * Ticker reference data synced from adanos/free-ticker-database
 * (data/tickers.csv — MIT licensed). One row per security.
 * `listingKey` is the upstream collision-safe `exchange::ticker` key.
 */
export const tickerReference = instrumentsSchema.table(
  "ticker_reference",
  {
    listingKey: text("listing_key").primaryKey(),
    ticker: text("ticker").notNull(),
    exchange: text("exchange").notNull(),
    name: text("name").notNull(),
    assetType: text("asset_type").notNull(),
    stockSector: text("stock_sector"),
    etfCategory: text("etf_category"),
    country: text("country"),
    countryCode: text("country_code"),
    isin: text("isin"),
    aliases: text("aliases"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("ticker_reference_ticker_idx").on(t.ticker),
    index("ticker_reference_isin_idx").on(t.isin),
  ],
)
