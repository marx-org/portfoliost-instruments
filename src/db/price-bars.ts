/**
 * price-data-architecture (H2) — stooq daily datasets + the unified
 * `price_bars_all` view.
 *
 * In production the `stooq_daily_*` tables are postgres_fdw FOREIGN tables
 * created by the cluster's pfire-init-sql ConfigMap (they live in the remote
 * `stooq` DB on the same Postgres instance). They are intentionally NOT part
 * of the Drizzle schema or migrations — the migration only creates the
 * overflow/owned tables and a *guarded* view, so it never collides with the
 * foreign tables (creating a plain `stooq_daily_*` table would block FDW).
 *
 * PGlite tests and the local docker-compose stack cannot use postgres_fdw, so
 * the DDL below stands in: plain local `stooq_daily_*` tables + the same view.
 * Column layout mirrors the foreign tables (source: stooq d_*_txt.zip).
 */

export const STOOQ_DAILY_TABLES = [
  "stooq_daily_us",
  "stooq_daily_pl",
  "stooq_daily_jp",
  "stooq_daily_world",
  "stooq_daily_uk",
  "stooq_daily_hk",
  "stooq_daily_hu",
  "stooq_daily_macro",
] as const

export const STOOQ_DAILY_COLUMNS = `
  "ticker" text NOT NULL,
  "period" text NOT NULL,
  "date" date NOT NULL,
  "time" text NOT NULL DEFAULT '000000',
  "open" numeric(28, 8),
  "high" numeric(28, 8),
  "low" numeric(28, 8),
  "close" numeric(28, 8),
  "volume" numeric(28, 8),
  "openint" numeric(28, 8)
`

/** Standard 'daily' period value used when seeding local stooq rows. */
export const STOOQ_DAILY_PERIOD = "d"

/**
 * Plain local `stooq_daily_*` tables standing in for the FDW foreign tables
 * (PGlite tests, docker-compose simulation). Idempotent. One statement per
 * table (PGlite prepared statements reject multi-command strings).
 */
export const LOCAL_STOOQ_TABLES_SQL: string[] = STOOQ_DAILY_TABLES.map(
  (t) => `CREATE TABLE IF NOT EXISTS "instruments"."${t}" (${STOOQ_DAILY_COLUMNS});`,
)

/**
 * Functional index mirroring the cluster's `daily_us_stripped_ticker_date`
 * on the remote stooq DB's `public.daily_us` (2026-09-19 pfire-postgres CPU
 * saturation): the view computes `replace(ticker, '.US', '')` per row, which
 * a plain (ticker, date) index cannot serve — per-symbol price lookups
 * degenerate to full scans. Index name stays unqualified (PGlite's parser
 * rejects schema-qualified index names); it lands in the table's schema.
 */
export const LOCAL_STOOQ_INDEX_SQL: string[] = [
  `CREATE INDEX IF NOT EXISTS stooq_daily_us_stripped_ticker_date ON "instruments"."stooq_daily_us" (replace("ticker", '.US', ''), "date");`,
]

/**
 * The `price_bars_all` view. Stooq US tickers carry a '.US' suffix that is
 * stripped to the system symbol; all other datasets pass tickers through
 * as-is. Admin-approved split factors (split_adjustments) are applied via
 * LEFT JOIN on the symbol. Overflow (price_bars) rows pass through directly.
 * Idempotent (CREATE OR REPLACE).
 */
export const PRICE_BARS_ALL_VIEW_SQL = `
CREATE OR REPLACE VIEW "instruments"."price_bars_all" AS
SELECT
  replace(s."ticker", '.US', '') AS "symbol",
  s."date",
  s."close" * COALESCE(adj."factor", 1) AS "close",
  'stooq' AS "source"
FROM "instruments"."stooq_daily_us" s
LEFT JOIN "instruments"."split_adjustments" adj
  ON replace(s."ticker", '.US', '') = adj."symbol"
UNION ALL
SELECT
  s."ticker" AS "symbol",
  s."date",
  s."close" * COALESCE(adj."factor", 1) AS "close",
  'stooq' AS "source"
FROM "instruments"."stooq_daily_pl" s
LEFT JOIN "instruments"."split_adjustments" adj
  ON s."ticker" = adj."symbol"
UNION ALL
SELECT
  s."ticker" AS "symbol",
  s."date",
  s."close" * COALESCE(adj."factor", 1) AS "close",
  'stooq' AS "source"
FROM "instruments"."stooq_daily_jp" s
LEFT JOIN "instruments"."split_adjustments" adj
  ON s."ticker" = adj."symbol"
UNION ALL
SELECT
  s."ticker" AS "symbol",
  s."date",
  s."close" * COALESCE(adj."factor", 1) AS "close",
  'stooq' AS "source"
FROM "instruments"."stooq_daily_world" s
LEFT JOIN "instruments"."split_adjustments" adj
  ON s."ticker" = adj."symbol"
UNION ALL
SELECT
  s."ticker" AS "symbol",
  s."date",
  s."close" * COALESCE(adj."factor", 1) AS "close",
  'stooq' AS "source"
FROM "instruments"."stooq_daily_uk" s
LEFT JOIN "instruments"."split_adjustments" adj
  ON s."ticker" = adj."symbol"
UNION ALL
SELECT
  s."ticker" AS "symbol",
  s."date",
  s."close" * COALESCE(adj."factor", 1) AS "close",
  'stooq' AS "source"
FROM "instruments"."stooq_daily_hk" s
LEFT JOIN "instruments"."split_adjustments" adj
  ON s."ticker" = adj."symbol"
UNION ALL
SELECT
  s."ticker" AS "symbol",
  s."date",
  s."close" * COALESCE(adj."factor", 1) AS "close",
  'stooq' AS "source"
FROM "instruments"."stooq_daily_hu" s
LEFT JOIN "instruments"."split_adjustments" adj
  ON s."ticker" = adj."symbol"
UNION ALL
SELECT
  s."ticker" AS "symbol",
  s."date",
  s."close" * COALESCE(adj."factor", 1) AS "close",
  'stooq' AS "source"
FROM "instruments"."stooq_daily_macro" s
LEFT JOIN "instruments"."split_adjustments" adj
  ON s."ticker" = adj."symbol"
UNION ALL
SELECT "symbol", "date", "close", "source"
FROM "instruments"."price_bars";
`

/** Create local stooq tables + indexes + the unified view. Idempotent. */
export const LOCAL_PRICE_BARS_SETUP_SQL: string[] = [
  ...LOCAL_STOOQ_TABLES_SQL,
  ...LOCAL_STOOQ_INDEX_SQL,
  PRICE_BARS_ALL_VIEW_SQL,
]

/** Joined form used by docker-compose init scripts (psql runs SQL files). */
export const LOCAL_PRICE_BARS_SETUP_SQL_TEXT = LOCAL_PRICE_BARS_SETUP_SQL.join("\n")
