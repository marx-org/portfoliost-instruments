CREATE SCHEMA "instruments";
--> statement-breakpoint
CREATE TABLE "instruments"."exchange_reference" (
	"exchange_code" text PRIMARY KEY NOT NULL,
	"operating_mic" text,
	"canonical_name" text,
	"country_code" text,
	"yahoo_suffix" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "instruments"."logos" (
	"symbol" text PRIMARY KEY NOT NULL,
	"source" text NOT NULL,
	"remote_url" text NOT NULL,
	"file" text NOT NULL,
	"bytes" integer NOT NULL,
	"sha256" text NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	"refresh_after" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "instruments"."price_bar_metadata" (
	"symbol" text PRIMARY KEY NOT NULL,
	"last_fetched_at" timestamp with time zone,
	"fetch_status" text DEFAULT 'ok' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "instruments"."price_bars" (
	"symbol" text NOT NULL,
	"date" date NOT NULL,
	"close" numeric(28, 8) NOT NULL,
	"source" text DEFAULT 'openst' NOT NULL,
	CONSTRAINT "price_bars_symbol_date_pk" PRIMARY KEY("symbol","date")
);
--> statement-breakpoint
CREATE TABLE "instruments"."split_adjustments" (
	"symbol" text NOT NULL,
	"detected_at" date NOT NULL,
	"factor" numeric(10, 6) NOT NULL,
	"split_ratio" text,
	CONSTRAINT "split_adjustments_symbol_detected_at_pk" PRIMARY KEY("symbol","detected_at")
);
--> statement-breakpoint
CREATE TABLE "instruments"."split_candidates" (
	"symbol" text NOT NULL,
	"detected_at" date NOT NULL,
	"last_stooq_date" date,
	"last_stooq_close" numeric(28, 8),
	"first_overflow_date" date,
	"first_overflow_close" numeric(28, 8),
	"ratio" numeric(10, 6),
	"suggested_factor" numeric(10, 6),
	"suggested_ratio" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"reviewed_at" timestamp with time zone,
	"reviewed_by" text,
	CONSTRAINT "split_candidates_symbol_detected_at_pk" PRIMARY KEY("symbol","detected_at")
);
--> statement-breakpoint
CREATE TABLE "instruments"."ticker_reference" (
	"listing_key" text PRIMARY KEY NOT NULL,
	"ticker" text NOT NULL,
	"exchange" text NOT NULL,
	"name" text NOT NULL,
	"asset_type" text NOT NULL,
	"stock_sector" text,
	"etf_category" text,
	"country" text,
	"country_code" text,
	"isin" text,
	"aliases" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "ticker_reference_ticker_idx" ON "instruments"."ticker_reference" USING btree ("ticker");--> statement-breakpoint
CREATE INDEX "ticker_reference_isin_idx" ON "instruments"."ticker_reference" USING btree ("isin");--> statement-breakpoint
-- price_bars_all: unified close-price view over every stooq DAILY dataset +
-- the overflow (price_bars) table. All daily foreign tables are wired here
-- (us, pl, jp, world, uk, hk, hu, macro) — see pfire-init-sql ConfigMap for
-- the matching foreign-table set.
--
-- US tickers carry a '.US' suffix (e.g. 'AAPL.US') which is stripped to give
-- the system symbol ('AAPL'). PL/world/jp/uk/hk/hu/macro tickers pass through
-- as-is (exact mapping TBC against imported data). Admin-approved split
-- factors (split_adjustments) are applied via LEFT JOIN on the symbol.
-- Overflow rows are kept free of stooq-covered dates by the post-import
-- cleanup hook, so the UNION ALL never produces duplicates.
--
-- The view is created conditionally: in production the stooq_daily_* objects
-- are postgres_fdw foreign tables created by the cluster's pfire-init-sql
-- ConfigMap (available by the time migrations run). In PGlite unit tests the
-- postgres_fdw extension is unavailable, so the guard is a no-op and tests
-- build the view themselves over plain local stooq tables (see
-- db/price-bars test helper). This keeps the production migration free of any
-- local stooq table that would collide with (and block) the foreign tables.
DO $$
BEGIN
  IF to_regclass('instruments.stooq_daily_us') IS NOT NULL
     AND to_regclass('instruments.stooq_daily_pl') IS NOT NULL
     AND to_regclass('instruments.stooq_daily_world') IS NOT NULL
     AND to_regclass('instruments.price_bars_all') IS NULL THEN
    CREATE VIEW "instruments"."price_bars_all" AS
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
  END IF;
END $$;