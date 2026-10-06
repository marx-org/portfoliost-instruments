/**
 * One-shot fundamentals backfill (#51 step 7): `npm run fundamentals:backfill`.
 *
 * Not a cron and not a HelmRelease entry — the store fills itself on read, so
 * this exists for the two cases reading cannot cover:
 *
 *  - warming a symbol before anyone opens it, so the first page view is warm
 *  - re-seeding after a database restore, where nothing would otherwise be warm
 *    until real traffic arrived
 *
 * Every scope goes through `loadStatementsThrough`, so a backfilled symbol obeys
 * exactly the same windows and backoff as one filled by a page view. A second run
 * is a no-op: the windows have not passed, so nothing is fetched and nothing is
 * rewritten.
 *
 *   --symbol PKO.WA        one symbol, every statement × both periods + metrics
 *   --from-ticker-reference walk stock/ETF rows in bounded batches
 *   --limit N              cap the walk (default 50)
 *   --dry-run              print the plan, write nothing
 *
 * Concurrency in the walk is deliberately 1, and it is not an oversight: each
 * symbol costs up to seven provider walks (three statements × two periods, plus
 * metrics) and the whole point of the store is that those walks are rare. A
 * parallel sweep would turn "warm the cache" into a provider flood, which is the
 * failure the analizy.pl catalogue scrape already demonstrated.
 */
import { closeDb, getDb, type DB } from "../db/index.js"
import { tickerReference } from "../db/schema.js"
import { inArray } from "drizzle-orm"
import {
  loadMetricsThrough,
  loadStatementsThrough,
  type StatementScope,
} from "../services/fundamentals.js"
import { fetchFundamentals, fetchMetrics, UpstreamError } from "../adapters/cachest.js"

const STATEMENTS: Array<StatementScope["statement"]> = ["income", "balance", "cash"]
const PERIODS: Array<StatementScope["period"]> = ["annual", "quarter"]

export interface BackfillOptions {
  symbols: string[]
  dryRun?: boolean
  /** Called between symbols in the walk — the pause that keeps this a trickle. */
  pause?: () => Promise<void>
}

export interface BackfillResult {
  symbol: string
  scopes: number
  periods: number
  /** Scopes the provider had no answer for. A backoff, not a failure. */
  empty: number
}

/** How long to wait between symbols in the walk. */
export const WALK_PAUSE_MS = 250

/**
 * Backfill one symbol: every statement × both periods, plus the metrics snapshot.
 *
 * A scope that 404s is counted as empty and the walk continues — a fund or an ETF
 * has no statements, and that is an answer, not an error. Anything else
 * propagates, because a broken provider tier must not look like a completed run.
 */
export async function backfillSymbol(
  db: DB,
  symbol: string,
  dryRun = false,
): Promise<BackfillResult> {
  if (dryRun) {
    return { symbol, scopes: STATEMENTS.length * PERIODS.length + 1, periods: 0, empty: 0 }
  }

  let empty = 0
  let periods = 0
  for (const statement of STATEMENTS) {
    for (const period of PERIODS) {
      try {
        const rows = await loadStatementsThrough(db, symbol, { statement, period }, () =>
          fetchFundamentals(symbol, statement, period),
        )
        periods += rows.length
        if (rows.length === 0) empty += 1
      } catch (e) {
        if (e instanceof UpstreamError && e.status === 404) {
          empty += 1
          continue
        }
        throw e
      }
    }
  }

  try {
    const metrics = await loadMetricsThrough(db, symbol, () => fetchMetrics(symbol))
    if (metrics === null) empty += 1
  } catch (e) {
    if (e instanceof UpstreamError && e.status === 404) empty += 1
    else throw e
  }

  return { symbol, scopes: STATEMENTS.length * PERIODS.length + 1, periods, empty }
}

/** Stock and ETF rows only. Funds and bonds have no statements to fetch. */
export async function backfillableSymbols(db: DB, limit: number): Promise<string[]> {
  const rows = await db
    .select({ ticker: tickerReference.ticker })
    .from(tickerReference)
    .where(inArray(tickerReference.assetType, ["Stock", "ETF"]))
    .limit(limit)
  return [...new Set(rows.map((r) => r.ticker))]
}

/**
 * Backfill a list of symbols sequentially.
 *
 * Sequential, with a pause, on purpose — see the note at the top of the file.
 * `concurrency` is asserted by the test rather than left to the reader: a sweep
 * that fires seven walks per symbol at a provider is the exact failure mode this
 * command must not have.
 */
export async function backfillSymbols(
  db: DB,
  options: BackfillOptions,
): Promise<BackfillResult[]> {
  const pause = options.pause ?? (async () => {})
  const results: BackfillResult[] = []
  for (const symbol of options.symbols) {
    results.push(await backfillSymbol(db, symbol, options.dryRun ?? false))
    await pause()
  }
  return results
}

/** `--symbol X` / `--from-ticker-reference --limit N` / `--dry-run`. */
export function parseArgs(argv: string[]): { symbol?: string; fromReference: boolean; limit: number; dryRun: boolean } {
  let symbol: string | undefined
  let fromReference = false
  let limit = 50
  let dryRun = false
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === "--symbol") symbol = argv[++i]?.toUpperCase()
    else if (arg === "--from-ticker-reference") fromReference = true
    else if (arg === "--limit") limit = Number(argv[++i]) || limit
    else if (arg === "--dry-run") dryRun = true
  }
  return { symbol, fromReference, limit, dryRun }
}

const isMain = process.argv[1]?.endsWith("fundamentals-backfill.js") ?? false
if (isMain) {
  const args = parseArgs(process.argv.slice(2))
  const db = getDb()
  const symbols = args.symbol
    ? [args.symbol]
    : args.fromReference
      ? await backfillableSymbols(db, args.limit)
      : []
  if (symbols.length === 0) {
    console.error("[fundamentals-backfill] pass --symbol X or --from-ticker-reference")
    process.exit(1)
  }
  console.log(`[fundamentals-backfill] ${symbols.length} symbol(s)${args.dryRun ? " (dry run)" : ""}`)

  // One bad symbol must not abandon the rest of the run: everything already
  // written stays written, and the exit code reports that something failed.
  let failed = 0
  for (const symbol of symbols) {
    try {
      const r = await backfillSymbol(db, symbol, args.dryRun)
      console.log(
        `[fundamentals-backfill] ${r.symbol}: ${r.periods} period(s) across ${r.scopes} scope(s)` +
          (r.empty > 0 ? `, ${r.empty} empty` : ""),
      )
    } catch (e) {
      failed += 1
      console.error(`[fundamentals-backfill] ${symbol} failed:`, (e as Error)?.message ?? e)
    }
    if (!args.dryRun) await new Promise((r) => setTimeout(r, WALK_PAUSE_MS))
  }

  await closeDb()
  // A non-zero exit is how whatever ran this learns the run was incomplete.
  process.exit(failed > 0 ? 1 : 0)
}
