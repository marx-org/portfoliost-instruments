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

// ─────────────────────────────────────────────────────────────────────────────
// Plan §48.4a — deterministic e2e price series.
//
// The docker-compose e2e suite must be repeatable on a FRESH stack (green on
// the first run and on the Nth), without depending on the live provider tier
// (which 502-bursts under parallel load). The chart's fast leg reads
// `price_bars_all` (price-bars endpoint), and `/history` falls back to it when
// the provider leg fails — so every symbol the suite or the seed portfolio
// touches gets a deterministic daily series here: weekdays only, ~11 years
// (the SPA's default request window), ending today, a mulberry32 random walk
// that lands exactly on the symbol's anchor price (the same anchors the
// stoxly-mock catalog quotes use, so chart and quote agree).
//
// Deterministic: the walk is seeded by the ticker, so re-seeding produces
// byte-identical closes. Idempotent: (ticker, date) rows are never overwritten
// — the fixed AAPL split-adjustment fixtures below always win.
// ─────────────────────────────────────────────────────────────────────────────

/** ~11 years of daily bars, matching PriceChart's default 4018-day window. */
const SERIES_DAYS = 4018
const DAY_MS = 86_400_000

function hashStr(str: string): number {
  let h = 2166132621
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

function mulberry32(seed: number): () => number {
  let a = seed
  return function () {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** [table, ticker, anchor price, daily volatility] — mock-only symbols. */
const SEED_SERIES: Array<[string, string, number, number]> = [
  // seed portfolio positions (portfoliost mocks/db-seed SEED_POSITIONS)
  ["stooq_daily_us", "META.US", 740.0, 0.018],
  ["stooq_daily_pl", "SNT.WA", 100.0, 0.022],
  ["stooq_daily_us", "CART.US", 47.9, 0.025],
  ["stooq_daily_us", "MSFT.US", 506.0, 0.014],
  ["stooq_daily_us", "NVDA.US", 208.4, 0.028],
  ["stooq_daily_us", "PLTR.US", 185.3, 0.032],
  ["stooq_daily_us", "INTU.US", 660.0, 0.016],
  ["stooq_daily_us", "LRCX.US", 230.0, 0.019],
  ["stooq_daily_us", "AMAT.US", 280.0, 0.019],
  ["stooq_daily_us", "ORCL.US", 230.0, 0.016],
  ["stooq_daily_us", "KLAC.US", 290.0, 0.019],
  // research-page specs (chart-currency, chart-title-stability, price-bars)
  ["stooq_daily_us", "AAPL.US", 230.5, 0.015],
  ["stooq_daily_us", "AMD.US", 190.0, 0.026],
  ["stooq_daily_us", "KO.US", 72.0, 0.009],
  // benchmarks (§36 compare overlay — SPY/QQQ/IWM, all USD)
  ["stooq_daily_us", "SPY.US", 600.0, 0.009],
  ["stooq_daily_us", "QQQ.US", 530.0, 0.013],
  ["stooq_daily_us", "IWM.US", 235.0, 0.014],
]

/** Weekday ISO dates for [today-SERIES_DAYS, today], ending on the last
 * weekday ≤ today (a weekend "today" would leave a stale-looking last bar). */
function seriesDates(now: Date): string[] {
  const end = new Date(now)
  while (end.getUTCDay() === 0 || end.getUTCDay() === 6) end.setUTCDate(end.getUTCDate() - 1)
  const start = new Date(end.getTime() - SERIES_DAYS * DAY_MS)
  const dates: string[] = []
  for (const d = new Date(start); d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
    const dow = d.getUTCDay()
    if (dow === 0 || dow === 6) continue
    dates.push(d.toISOString().slice(0, 10))
  }
  return dates
}

/** Random-walk closes anchored at `base` (the LAST close is exactly `base`). */
function walkCloses(ticker: string, dates: string[], base: number, vol: number): number[] {
  const rnd = mulberry32(hashStr(ticker))
  const n = dates.length
  const closes = new Array<number>(n)
  closes[n - 1] = base
  for (let i = n - 2; i >= 0; i--) {
    // daily return ~ uniform(-vol, +vol); walk backwards from the anchor
    const ret = (rnd() - 0.5) * 2 * vol
    closes[i] = closes[i + 1] / (1 + ret)
  }
  return closes.map((c) => Math.max(0.01, Math.round(c * 100) / 100))
}

/**
 * Insert the deterministic series (mock-only). Groups rows per table into one
 * multi-row INSERT ... SELECT ... VALUES guarded by NOT EXISTS, so the fixed
 * fixtures (AAPL 2026-07-29/30, DE10Y, NOTSTOOQ) and any re-run are untouched.
 */
async function seedSeries(sql: postgres.Sql, now: Date): Promise<void> {
  const dates = seriesDates(now)
  const byTable = new Map<string, string[]>()
  for (const [table, ticker, base, vol] of SEED_SERIES) {
    const closes = walkCloses(ticker, dates, base, vol)
    const values = dates.map((d, i) => `('${ticker}','${STOOQ_DAILY_PERIOD}','${d}',${closes[i]})`)
    byTable.set(table, [...(byTable.get(table) ?? []), ...values])
  }
  for (const [table, values] of byTable) {
    await sql.unsafe(
      `INSERT INTO instruments.${table} (ticker, period, date, close)
       SELECT v.ticker, v.period, v.date::date, v.close::numeric
       FROM (VALUES ${values.join(",")}) AS v(ticker, period, date, close)
       WHERE NOT EXISTS (
         SELECT 1 FROM instruments.${table} x WHERE x.ticker = v.ticker AND x.date = v.date::date
       )`,
    )
    console.log(`[price-bars-sim] seeded ${dates.length} daily bars for ${table}`)
  }
}

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

  // 4. Plan §48.4a — deterministic daily series for the e2e symbols +
  //    benchmarks (after the fixed fixtures, so NOT EXISTS keeps those).
  await seedSeries(sql, new Date())

  // 5. Self-verify the unified view (this is the H2 compose simulation check).
  //    - US 'AAPL' must be hit as a split-adjusted close (230.5 * 0.25 = 57.625).
  //    - world 'DE10Y' passes through raw.
  //    - overflow 'NOTSTOOQ' passes through raw.
  const rows = await sql`
    SELECT symbol, date, close
    FROM instruments.price_bars_all
    WHERE date IN ('2026-07-29', '2026-08-03')
    ORDER BY symbol, date, case when source = 'stooq' then 1 else 0 end
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