DO $migration$
BEGIN
  IF to_regclass('instruments.stooq_daily_us') IS NOT NULL THEN
    EXECUTE $view$
DROP VIEW IF EXISTS "instruments"."price_bars_all";
CREATE OR REPLACE VIEW "instruments"."price_bars_all" AS
SELECT
  replace(s."ticker", '.US', '') AS "symbol",
  s."date",
  s."close" * COALESCE(adj."factor", 1) AS "close",
  'stooq' AS "source",
  0 AS "source_priority"
FROM "instruments"."stooq_daily_us" s
LEFT JOIN "instruments"."split_adjustments" adj
  ON replace(s."ticker", '.US', '') = adj."symbol"
UNION ALL
SELECT
  s."ticker" AS "symbol",
  s."date",
  s."close" * COALESCE(adj."factor", 1) AS "close",
  'stooq' AS "source",
  1 AS "source_priority"
FROM "instruments"."stooq_daily_pl" s
LEFT JOIN "instruments"."split_adjustments" adj
  ON s."ticker" = adj."symbol"
WHERE NOT EXISTS (
  SELECT 1 FROM "instruments"."stooq_daily_us" us
  WHERE replace(us."ticker", '.US', '') = s."ticker"
)
UNION ALL
SELECT
  s."ticker" AS "symbol",
  s."date",
  s."close" * COALESCE(adj."factor", 1) AS "close",
  'stooq' AS "source",
  1 AS "source_priority"
FROM "instruments"."stooq_daily_jp" s
LEFT JOIN "instruments"."split_adjustments" adj
  ON s."ticker" = adj."symbol"
WHERE NOT EXISTS (
  SELECT 1 FROM "instruments"."stooq_daily_us" us
  WHERE replace(us."ticker", '.US', '') = s."ticker"
)
UNION ALL
SELECT
  s."ticker" AS "symbol",
  s."date",
  s."close" * COALESCE(adj."factor", 1) AS "close",
  'stooq' AS "source",
  1 AS "source_priority"
FROM "instruments"."stooq_daily_world" s
LEFT JOIN "instruments"."split_adjustments" adj
  ON s."ticker" = adj."symbol"
WHERE NOT EXISTS (
  SELECT 1 FROM "instruments"."stooq_daily_us" us
  WHERE replace(us."ticker", '.US', '') = s."ticker"
)
UNION ALL
SELECT
  s."ticker" AS "symbol",
  s."date",
  s."close" * COALESCE(adj."factor", 1) AS "close",
  'stooq' AS "source",
  1 AS "source_priority"
FROM "instruments"."stooq_daily_uk" s
LEFT JOIN "instruments"."split_adjustments" adj
  ON s."ticker" = adj."symbol"
WHERE NOT EXISTS (
  SELECT 1 FROM "instruments"."stooq_daily_us" us
  WHERE replace(us."ticker", '.US', '') = s."ticker"
)
UNION ALL
SELECT
  s."ticker" AS "symbol",
  s."date",
  s."close" * COALESCE(adj."factor", 1) AS "close",
  'stooq' AS "source",
  1 AS "source_priority"
FROM "instruments"."stooq_daily_hk" s
LEFT JOIN "instruments"."split_adjustments" adj
  ON s."ticker" = adj."symbol"
WHERE NOT EXISTS (
  SELECT 1 FROM "instruments"."stooq_daily_us" us
  WHERE replace(us."ticker", '.US', '') = s."ticker"
)
UNION ALL
SELECT
  s."ticker" AS "symbol",
  s."date",
  s."close" * COALESCE(adj."factor", 1) AS "close",
  'stooq' AS "source",
  1 AS "source_priority"
FROM "instruments"."stooq_daily_hu" s
LEFT JOIN "instruments"."split_adjustments" adj
  ON s."ticker" = adj."symbol"
WHERE NOT EXISTS (
  SELECT 1 FROM "instruments"."stooq_daily_us" us
  WHERE replace(us."ticker", '.US', '') = s."ticker"
)
UNION ALL
SELECT
  s."ticker" AS "symbol",
  s."date",
  s."close" * COALESCE(adj."factor", 1) AS "close",
  'stooq' AS "source",
  1 AS "source_priority"
FROM "instruments"."stooq_daily_macro" s
LEFT JOIN "instruments"."split_adjustments" adj
  ON s."ticker" = adj."symbol"
WHERE NOT EXISTS (
  SELECT 1 FROM "instruments"."stooq_daily_us" us
  WHERE replace(us."ticker", '.US', '') = s."ticker"
)
UNION ALL
SELECT "symbol", "date", "close", "source", 2 AS "source_priority"
FROM "instruments"."price_bars";
    $view$;
  END IF;
END $migration$;
