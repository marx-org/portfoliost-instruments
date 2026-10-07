import { sql } from "drizzle-orm"
import { char, date, index, integer, jsonb, numeric, pgSchema, primaryKey, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core"

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
 * §63.9.2 — `lastError` exists because the failure status alone could not say
 * *why* a fetch failed, and the two reasons need opposite handling: a 404 means
 * the symbol has no upstream history and retrying is pointless for an hour, while
 * a 429/502/503/504 (notably cachest's own rate-limit 503, which is returned
 * without the upstream ever being called) is transient and must be retried in
 * minutes. Without the status code both looked identical, and one lost race in
 * a 175-symbol sweep parked a symbol for the rest of the day.
 *
 * §72.33 — that reasoning is now carried by `fetchStatus` itself, which is a
 * classification rather than a flat `ok`/`failed`:
 *   `ok`               fetched; the symbol has bars
 *   `no_data`          fetched, upstream returned nothing, nothing is stored
 *   `failed_transient` 429/5xx/network/DB — retry in minutes
 *   `failed_permanent` 404 — nothing to fetch upstream
 *   `sanity_failed`    fetched, bars refused as impossible (§63.5)
 *
 * `lastError` is kept for the human-readable message and is NO LONGER the thing
 * the cooldown is derived from — it used to be, by substring match, which meant
 * a reworded 404 became transient. Cooldown now reads `fetchStatus`.
 *
 * **This table has no reader outside this repo.** The only consumer is
 * `recentlyFailed` in `services/price-bars.ts`; wallets and the SPA read nothing
 * from it. So `fetchStatus` is a circuit-breaker record, not a quality signal,
 * and an earlier version of this comment claiming `ok` is "what every downstream
 * reader takes as priced" was simply wrong. A *reporting* consumer would have to
 * be built for `no_data` vs `failed_permanent` to be worth anything to a person.
 */
export const priceBarMetadata = instrumentsSchema.table("price_bar_metadata", {
  symbol: text("symbol").primaryKey(),
  lastFetchedAt: timestamp("last_fetched_at", { withTimezone: true }),
  /** §72.33 — a classification, not `ok`|`failed`. See the note above; the values
   * are `ok` | `no_data` | `failed_transient` | `failed_permanent` |
   * `sanity_failed`, and the cooldown is read off this column. */
  fetchStatus: text("fetch_status").notNull().default("ok"),
  /** Upstream status + message behind a non-`ok` `fetchStatus`, truncated. NULL when
   * the last fetch succeeded or was legitimately empty. Human-readable only —
   * nothing derives behaviour from its text any more. */
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
    effectiveDate: date("effective_date"),
    lastStooqDate: date("last_stooq_date"),
    lastStooqClose: numeric("last_stooq_close", { precision: 28, scale: 8 }),
    firstOverflowDate: date("first_overflow_date"),
    firstOverflowClose: numeric("first_overflow_close", { precision: 28, scale: 8 }),
    ratio: numeric("ratio", { precision: 10, scale: 6 }),
    suggestedFactor: numeric("suggested_factor", { precision: 10, scale: 6 }),
    suggestedRatio: text("suggested_ratio"),
    provider: text("provider"),
    providerNumerator: numeric("provider_numerator", { precision: 18, scale: 8 }),
    providerDenominator: numeric("provider_denominator", { precision: 18, scale: 8 }),
    providerFactor: numeric("provider_factor", { precision: 18, scale: 8 }),
    providerStatus: text("provider_status").notNull().default("manual"),
    evidence: jsonb("evidence"),
    status: text("status").notNull().default("pending"), // 'pending'|'applied'|'dismissed'
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    reviewedBy: text("reviewed_by"),
    appliedAt: timestamp("applied_at", { withTimezone: true }),
  },
  (t) => [
    primaryKey({ columns: [t.symbol, t.detectedAt] }),
    uniqueIndex("split_candidates_symbol_effective_date_uidx")
      .on(t.symbol, t.effectiveDate)
      .where(sql`${t.effectiveDate} is not null`),
  ],
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

/**
 * One row of one financial statement for one period (pfire-docs #51).
 *
 * NOT user-scoped — shared reference data, same as `fx_rates` and `news_articles`.
 *
 * The primary key is `(symbol, statement, period, period_key)`, and none of
 * those four is negotiable:
 *
 * - `period_key` is the calendar quarter containing the provider's period end
 *   (`YYYY-Qn`), NOT `period_ending` and NOT `fiscal_year`+`fiscal_period`.
 *   Both of those fork a symbol's history when the provider changes: fmp reports
 *   Apple's FY2025 as ending 2025-09-27 and yfinance as 2025-09-30, and fmp
 *   labels the quarter ending 2026-06-27 "Q3 of FY2026" where yfinance's
 *   calendarised date is calendar Q2. Derived by `rowIdentity()` — see
 *   `src/services/fundamentals.ts` and `test/fixtures/fundamentals/README.md`.
 * - `period` is in the key because the same period end legitimately appears in
 *   both scopes: AAPL 2025-09-30 is the FY2025 annual row AND the 2025Q3
 *   quarterly row.
 * - `period_end` is stored but is NOT part of the key — it is the provider's own
 *   date, kept for display and audit, and it legitimately differs per provider.
 *
 * `payload` is `jsonb` because there is no fixed statement schema (§79.3): fmp
 * emits the same typed snake_case keys for every symbol, while yfinance emits
 * per-listing passthrough names, so the rows are not one relational shape.
 * `fiscal_year`/`fiscal_period` keep whatever the provider declared — audit
 * metadata, not identity.
 *
 * `provider` is the §79.2 envelope's provider. It is NOT stable over time: fmp
 * 402s on non-US symbols, which blocks it in-process for 24h inside a long-lived
 * openst container, so a symbol's rows can come from fmp and later be rewritten
 * from yfinance. The upsert is therefore last-write-wins and a switch is visible
 * here rather than forking a second row set.
 */
export const fundamentalsStatements = instrumentsSchema.table(
  "fundamentals_statements",
  {
    symbol: text("symbol").notNull(),
    statement: text("statement").notNull(),
    period: text("period").notNull(),
    periodKey: text("period_key").notNull(),
    periodEnd: date("period_end"),
    fiscalYear: integer("fiscal_year"),
    fiscalPeriod: text("fiscal_period"),
    provider: text("provider"),
    payload: jsonb("payload").notNull(),
    fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.symbol, t.statement, t.period, t.periodKey] }),
    index("idx_fundamentals_symbol_period").on(t.symbol, t.period, t.periodEnd.desc()),
  ],
)

/**
 * Current metrics snapshot per symbol (P/E, margins, market cap — #51).
 *
 * A snapshot, not a history: `get_metrics` goes through `_single_record`, which
 * returns one record with no date and no provenance envelope
 * (`openst/src/openbb_client.py:409-421`). Nothing to key a history on, and no
 * `provider` to store, so both are deliberately absent rather than null columns.
 *
 * Written on read with a one-day revalidation window, because the ratios here
 * are price-derived and go stale within a trading day.
 */
export const fundamentalsMetrics = instrumentsSchema.table("fundamentals_metrics", {
  symbol: text("symbol").primaryKey(),
  payload: jsonb("payload").notNull(),
  fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull().defaultNow(),
})

/**
 * Revalidation clock and negative backoff, one row per (symbol, scope) (#51).
 *
 * `scope` is `income:annual`, `balance:quarter`, `metrics`, … — the granularity a
 * fetch decision is made at, which is finer than a statement because the three
 * statements are three independent provider walks (§79.2).
 *
 * `last_status` is `ok` or `empty`. `empty` is what stops an ETF or a fund — a
 * symbol with no statements at all — from re-walking the provider chain on every
 * single read; it is a backoff, not data, and is never written to
 * `fundamentals_statements`.
 *
 * Same shape as `fx_syncState`, one row per unit of work instead of one singleton.
 */
export const fundamentalsFetchState = instrumentsSchema.table(
  "fundamentals_fetch_state",
  {
    symbol: text("symbol").notNull(),
    scope: text("scope").notNull(),
    lastFetchedAt: timestamp("last_fetched_at", { withTimezone: true }),
    lastStatus: text("last_status"),
  },
  (t) => [primaryKey({ columns: [t.symbol, t.scope] })],
)

/**
 * Per-symbol dividend history and its upcoming (predicted) ex-dates (#71).
 *
 * One row per (symbol, ex_date). `payment_date` is mutable so the state
 * lifecycle `predicted` -> `confirmed` -> `paid` updates the row in place on
 * last-write-wins upsert, rather than forking a second row set for the same
 * ex-date. `status` is the marker: `predicted` rows are date-only forecasts
 * (dividendmax `Forecast` — the amount cell is sign-up gated, so `amount` is
 * NULL until the row goes `confirmed` with a declared amount). `confirmed` and
 * `paid` rows always beat a late-arriving `predicted` row for the same ex-date.
 *
 * `provider` is the §79.2 envelope's provider — which one answered last is
 * stored rather than guessed. `fetched_at` + the 7d window live next to
 * `dividends_fetch_state`.
 */
export const dividends = instrumentsSchema.table(
  "dividends",
  {
    symbol: text("symbol").notNull(),
    exDate: date("ex_date").notNull(),
    paymentDate: date("payment_date"),
    declarationDate: date("declaration_date"),
    amount: numeric("amount", { precision: 18, scale: 8 }),
    currency: text("currency"),
    status: text("status").notNull(),
    provider: text("provider"),
    payload: jsonb("payload").notNull(),
    fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.symbol, t.exDate] }),
    index("idx_dividends_symbol_payment").on(t.symbol, t.paymentDate),
  ],
)

/**
 * Revalidation clock and negative backoff for the dividends store (#71).
 *
 * `scope` is `history` or `predicted` — the granularity the fetch decision is
 * made at, because the paid history and the forecast walk are independent
 * provider passes. `last_status` is `ok` or `empty`; `empty` is what stops an
 * ETF or a fund — a symbol that never pays — from re-walking on every read.
 */
export const dividendsFetchState = instrumentsSchema.table(
  "dividends_fetch_state",
  {
    symbol: text("symbol").notNull(),
    scope: text("scope").notNull(),
    lastFetchedAt: timestamp("last_fetched_at", { withTimezone: true }),
    lastStatus: text("last_status"),
  },
  (t) => [primaryKey({ columns: [t.symbol, t.scope] })],
)
