/**
 * docker-compose-only stand-in for the production postgres_fdw stooq tables.
 *
 * In production the `instruments.stooq_daily_*` objects are postgres_fdw
 * FOREIGN tables created by the cluster's pfire-init-sql ConfigMap, so the
 * (guarded) `price_bars_all` view from migration 0003 is created over the real
 * remote tables. docker-compose cannot use postgres_fdw, so this script creates
 * plain local stand-in tables + the same view + a few seed rows so the read
 * path (H3+) can be exercised against the local stack.
 *
 * RUNS POST-MIGRATION ONLY: it assumes the `instruments` schema already exists
 * (migration 0000). It is idempotent and must never run in production — gate the
 * compose service on an env flag (default off).
 *
 * Usage:
 *   DATABASE_URL=postgres://portfoliost:portfoliost@postgres:5432/portfoliost \
 *     node dist/scripts/price-bars-sim.js
 */
import postgres from "postgres"
import {
  LOCAL_PRICE_BARS_SETUP_SQL_TEXT,
  STOOQ_DAILY_PERIOD,
} from "../db/price-bars.js"

const url =
  process.env.DATABASE_URL ??
  "postgres://portfoliost:portfoliost@localhost:5432/portfoliost"

const sql = postgres(url, { max: 1 })

async function main() {
  // Wait for the `instruments` schema to exist — it is created by the
  // instruments `db:migrate` (migration 0000) on container boot. The sim
  // depends on `service_started`, which can beat the migration, so poll.
  const deadline = Date.now() + 90_000
  for (;;) {
    try {
      const inits = await sql`
        SELECT 1 FROM information_schema.schemata WHERE schema_name = 'instruments'
      `
      if (inits.count > 0) break
    } catch {
      /* connection not ready yet */
    }
    if (Date.now() > deadline) {
      throw new Error("timed out waiting for instruments schema (did db:migrate run?)")
    }
    await new Promise((r) => setTimeout(r, 2000))
  }

  // 1. Create the plain stand-in stooq tables + the unified view (idempotent).
  await sql.unsafe(LOCAL_PRICE_BARS_SETUP_SQL_TEXT)

  // 2. Seed a handful of rows so the view returns something meaningful.
  const seeds: Array<[string, string, string, number]> = [
    // table, ticker, date, close
    ["stooq_daily_us", "AAPL.US", "2026-07-29", 230.5],
    ["stooq_daily_us", "AAPL.US", "2026-07-30", 232.1],
    // world govt-yield-style ticker passthrough
    ["stooq_daily_world", "DE10Y", "2026-07-29", 2.13],
  ]
  for (const [table, ticker, date, close] of seeds) {
    await sql`
      INSERT INTO instruments.${sql(table)} (ticker, period, date, close)
      SELECT ${ticker}, ${STOOQ_DAILY_PERIOD}, ${date}, ${close}
      WHERE NOT EXISTS (
        SELECT 1 FROM instruments.${sql(table)}
        WHERE ticker = ${ticker} AND date = ${date}
      )
    `
  }

  // split_adjustments rows must be applied through the view; seed one US split.
  await sql`
    INSERT INTO instruments.split_adjustments (symbol, detected_at, factor, split_ratio)
    SELECT 'AAPL', '2026-07-29', 0.25, '4:1'
    WHERE NOT EXISTS (
      SELECT 1 FROM instruments.split_adjustments
      WHERE symbol = 'AAPL' AND detected_at = '2026-07-29'
    )
  `

  // 3. Overlap barrier for the overflow table: a symbol not covered by stooq.
  await sql`
    INSERT INTO instruments.price_bars (symbol, date, close, source)
    SELECT 'NOTSTOOQ', '2026-08-03', 10.0, 'openst'
    WHERE NOT EXISTS (
      SELECT 1 FROM instruments.price_bars WHERE symbol = 'NOTSTOOQ' AND date = '2026-08-03'
    )
  `

  // 4. Self-verify the unified view (this is the H2 compose simulation check).
  //    - US 'AAPL' must be hit as a split-adjusted close (230.5 * 0.25 = 57.625).
  //    - world 'DE10Y' passes through raw.
  //    - overflow 'NOTSTOOQ' passes through raw.
  const rows = await sql`
    SELECT symbol, date, close
    FROM instruments.price_bars_all
    WHERE date IN ('2026-07-29', '2026-08-03')
    ORDER BY symbol, date
  `
  const fmtDate = (d: unknown): string => {
    if (d instanceof Date) {
      const y = d.getUTCFullYear()
      const m = String(d.getUTCMonth() + 1).padStart(2, "0")
      const day = String(d.getUTCDate()).padStart(2, "0")
      return `${y}-${m}-${day}`
    }
    return String(d).slice(0, 10)
  }
  const byKey = new Map(
    rows.map((r) => [`${r.symbol}|${fmtDate(r.date)}`, Number(r.close)]),
  )
  const failures: string[] = []
  const near = (a: number, b: number) => Math.abs(a - b) < 1e-6

  if (!near(byKey.get("AAPL|2026-07-29") ?? NaN, 57.625))
    failures.push(`AAPL 2026-07-29 expected 57.625 got ${byKey.get("AAPL|2026-07-29")}`)
  if (!near(byKey.get("DE10Y|2026-07-29") ?? NaN, 2.13))
    failures.push(`DE10Y 2026-07-29 expected 2.13 got ${byKey.get("DE10Y|2026-07-29")}`)
  if (!near(byKey.get("NOTSTOOQ|2026-08-03") ?? NaN, 10.0))
    failures.push(`NOTSTOOQ 2026-08-03 expected 10.0 got ${byKey.get("NOTSTOOQ|2026-08-03")}`)

  await sql.end()
  if (failures.length > 0) {
    console.error("[price-bars-sim] VERIFY FAILED:\n  " + failures.join("\n  "))
    process.exit(1)
  }
  console.log("[price-bars-sim] stand-in stooq tables + view ready (verified)")
}

main().catch(async (err) => {
  console.error("[price-bars-sim] failed:", err)
  try {
    await sql.end()
  } catch {
    /* ignore */
  }
  process.exit(1)
})