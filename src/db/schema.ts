import { char, date, index, integer, numeric, pgSchema, primaryKey, text, timestamp } from "drizzle-orm/pg-core"

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

/**
 * Logo cache index (logos.md D35). The row is the index; the binary lives on
 * disc at `LOGOS_DIR/{file}`. `refresh_after` drives lazy background
 * revalidation on read; failures never persist (initials serve instead).
 */
export const logos = instrumentsSchema.table("logos", {
  symbol: text("symbol").primaryKey(),
  source: text("source").notNull(),
  remoteUrl: text("remote_url").notNull(),
  file: text("file").notNull(),
  bytes: integer("bytes").notNull(),
  sha256: text("sha256").notNull(),
  fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull().defaultNow(),
  refreshAfter: timestamp("refresh_after", { withTimezone: true }).notNull(),
})

/**
 * Price history overflow store (price-data-architecture H2). Prices NOT
 * covered by stooq (recent tail after the last import + symbols stooq does
 * not carry) live here. Only `close` is stored — all downstream consumers
 * (analytics, charts) render close-price series. The `price_bars_all` view
 * unifies this with the stooq foreign tables in one query.
 */
export const priceBars = instrumentsSchema.table(
  "price_bars",
  {
    symbol: text("symbol").notNull(), // system format: AAPL, KRU.WA, RHM.DE
    date: date("date").notNull(),
    close: numeric("close", { precision: 28, scale: 8 }).notNull(),
    source: text("source").notNull().default("openst"),
  },
  (t) => [primaryKey({ columns: [t.symbol, t.date] })],
)

/**
 * Per-symbol fetch circuit breaker (price-data-architecture H2): after a
 * fetch failure the read endpoint serves stale data for an hour before
 * retrying upstream, instead of hammering openst on every request.
 *
 * §63.9.2 — `lastError` exists because `fetchStatus` alone cannot say *why* a
 * fetch failed, and the two reasons need opposite handling: a 404 means the
 * symbol has no upstream history and retrying is pointless for an hour, while a
 * 429/502/503/504 (notably cachest's own rate-limit 503, which is returned
 * without the upstream ever being called) is transient and must be retried in
 * minutes. Without the status code both looked identical, and one lost race in a
 * 175-symbol sweep parked a symbol for the rest of the day.
 */
export const priceBarMetadata = instrumentsSchema.table("price_bar_metadata", {
  symbol: text("symbol").primaryKey(),
  lastFetchedAt: timestamp("last_fetched_at", { withTimezone: true }),
  fetchStatus: text("fetch_status").notNull().default("ok"), // 'ok' | 'failed'
  /** Upstream status + message behind a non-'ok' `fetchStatus`, truncated. NULL when
   * the last fetch succeeded. */
  lastError: text("last_error"),
})

/**
 * Detected split discontinuities at the stooq/overflow boundary awaiting
 * admin review (price-data-architecture H2/H10). `suggested_factor` is NULL
 * when the ratio is ambiguous (extreme move, not a clean split).
 */
export const splitCandidates = instrumentsSchema.table(
  "split_candidates",
  {
    symbol: text("symbol").notNull(),
    detectedAt: date("detected_at").notNull(),
    lastStooqDate: date("last_stooq_date"),
    lastStooqClose: numeric("last_stooq_close", { precision: 28, scale: 8 }),
    firstOverflowDate: date("first_overflow_date"),
    firstOverflowClose: numeric("first_overflow_close", { precision: 28, scale: 8 }),
    ratio: numeric("ratio", { precision: 10, scale: 6 }),
    suggestedFactor: numeric("suggested_factor", { precision: 10, scale: 6 }),
    suggestedRatio: text("suggested_ratio"),
    status: text("status").notNull().default("pending"), // 'pending'|'applied'|'dismissed'
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    reviewedBy: text("reviewed_by"),
  },
  (t) => [primaryKey({ columns: [t.symbol, t.detectedAt] })],
)

/**
 * Admin-approved split factors applied by the `price_bars_all` view until the
 * next stooq import heals the boundary (price-data-architecture H2/H10).
 */
export const splitAdjustments = instrumentsSchema.table(
  "split_adjustments",
  {
    symbol: text("symbol").notNull(),
    detectedAt: date("detected_at").notNull(),
    factor: numeric("factor", { precision: 10, scale: 6 }).notNull(),
    splitRatio: text("split_ratio"),
  },
  (t) => [primaryKey({ columns: [t.symbol, t.detectedAt] })],
)

/**
 * Company news articles (stock-news.md N3) backed by the provider tier
 * (cachest → openst → OpenBB). `url` is the dedup key; `symbols` is the GIN
 * index for per-ticker lookups. `expires_at` = `fetched_at` + NEWS_EXPIRY_DAYS
 * drives the on-read purge in the news service.
 */
export const newsArticles = instrumentsSchema.table(
  "news_articles",
  {
    url: text("url").primaryKey(),
    title: text("title").notNull(),
    summary: text("summary"),
    source: text("source"),
    publishedAt: timestamp("published_at", { withTimezone: true }).notNull(),
    symbols: text("symbols").array().notNull(),
    fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    index("idx_news_symbols").using("gin", t.symbols),
    index("idx_news_published").on(t.publishedAt.desc()),
    index("idx_news_expires").on(t.expiresAt),
  ],
)

/**
 * Global EUR-quoted daily FX closes (plan §48, moved out of wallets 2026-09-26:
 * FX rates are daily market data, same module as price bars). NOT user-scoped —
 * shared reference data. Availability of distinct currencies here IS the
 * supported-currency registry served publicly as GET /api/currencies (D26).
 */
export const fxRates = instrumentsSchema.table(
  "fx_rates",
  {
    rateDate: date("rate_date").notNull(),
    currency: char("currency", { length: 3 }).notNull(),
    rate: numeric("rate", { precision: 20, scale: 10 }).notNull(),
    source: text("source").notNull().default("ecb"),
    fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.rateDate, t.currency] })],
)

/** Singleton bookkeeping row for the daily FX import job. */
export const fxSyncState = instrumentsSchema.table("fx_sync_state", {
  id: integer("id").primaryKey().default(1),
  lastRateDate: date("last_rate_date"),
  lastRunAt: timestamp("last_run_at", { withTimezone: true }),
  lastStatus: text("last_status"),
})
