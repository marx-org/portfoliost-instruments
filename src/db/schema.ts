import { index, pgSchema, text, timestamp } from "drizzle-orm/pg-core"

export const instrumentsSchema = pgSchema("instruments")

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
