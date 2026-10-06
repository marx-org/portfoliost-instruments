/**
 * One-shot dividends backfill (#71 step 7): `npm run dividends:backfill`.
 *
 * Same shape and same reasons as fundamentals-backfill.ts — not a cron, not a
 * HelmRelease entry. The store fills itself on read, so this exists to warm a
 * symbol before anyone opens it and to re-seed after a DB restore. Every run
 * goes through `loadDividendsThrough`, so a backfilled symbol obeys exactly
 * the same windows and backoff as one filled by a page view: a second run is
 * a no-op.
 *
 *   --symbol PKO.WA        one symbol
 *   --from-ticker-reference walk stock/ETF rows in bounded batches
 *   --limit N              cap the walk (default 50)
 *   --dry-run              print the plan, write nothing
 *
 * Concurrency is deliberately 1: each symbol costs one dividends walk, and the
 * whole point of the store is that those walks are rare.
 */
import { closeDb, getDb, type DB } from "../db/index.js"
import { tickerReference } from "../db/schema.js"
import { inArray } from "drizzle-orm"
import { loadDividendsThrough } from "../services/dividends-store.js"
import { fetchDividendHistory, UpstreamError } from "../adapters/cachest.js"

export interface BackfillOptions {
  symbols: string[]
  dryRun?: boolean
  pause?: () => Promise<void>
}

export interface BackfillResult {
  symbol: string
  /** Rows written on this run. */
  rows: number
  /** Scope the provider had no answer for. A backoff, not a failure. */
  empty: boolean
}

/** How long to wait between symbols in the walk. */
export const WALK_PAUSE_MS = 250

export async function backfillSymbol(
  db: DB,
  symbol: string,
  dryRun = false,
): Promise<BackfillResult> {
  if (dryRun) {
    return { symbol, rows: 0, empty: false }
  }
  try {
    const rows = await loadDividendsThrough(db, symbol, () => fetchDividendHistory(symbol))
    return { symbol, rows: rows.length, empty: rows.length === 0 }
  } catch (e) {
    if (e instanceof UpstreamError && e.status === 404) {
      return { symbol, rows: 0, empty: true }
    }
    throw e
  }
}

/** Stock and ETF rows only — funds and bonds don't pay dividends. */
export async function backfillableSymbols(db: DB, limit: number): Promise<string[]> {
  const rows = await db
    .select({ ticker: tickerReference.ticker })
    .from(tickerReference)
    .where(inArray(tickerReference.assetType, ["Stock", "ETF"]))
    .limit(limit)
  return [...new Set(rows.map((r) => r.ticker))]
}

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

const isMain = process.argv[1]?.endsWith("dividends-backfill.js") ?? false
if (isMain) {
  const args = parseArgs(process.argv.slice(2))
  const db = getDb()
  const symbols = args.symbol
    ? [args.symbol]
    : args.fromReference
      ? await backfillableSymbols(db, args.limit)
      : []
  if (symbols.length === 0) {
    console.error("[dividends-backfill] pass --symbol X or --from-ticker-reference")
    process.exit(1)
  }
  console.log(`[dividends-backfill] ${symbols.length} symbol(s)${args.dryRun ? " (dry run)" : ""}`)

  let failed = 0
  for (const symbol of symbols) {
    try {
      const r = await backfillSymbol(db, symbol, args.dryRun)
      console.log(
        `[dividends-backfill] ${r.symbol}: ${r.rows} row(s)` + (r.empty ? ", empty" : ""),
      )
    } catch (e) {
      failed += 1
      console.error(`[dividends-backfill] ${symbol} failed:`, (e as Error)?.message ?? e)
    }
    if (!args.dryRun) await new Promise((r) => setTimeout(r, WALK_PAUSE_MS))
  }

  await closeDb()
  process.exit(failed > 0 ? 1 : 0)
}
