/**
 * §63.15 — prune orphaned price-bar rows.
 *
 * `instruments.price_bar_metadata` is a per-symbol health table, and its whole
 * value depends on being readable. With 192 of 379 rows describing symbols no
 * transaction references, `fetch_status = 'failed'` reads as "a third of the
 * fleet is broken" — which is exactly the false signal that made the first
 * §63.13 symbol sweep unreliable. The bar rows are worse than the misleading
 * count: 401k of 697k rows (129 symbols) belong to symbols nothing holds.
 *
 * **Retention rule: delete, and there is no warm cache.** A search for an
 * unheld symbol refetches it on demand — one upstream call, bounded and correct.
 * The alternative needs a second sweeper and a documented TTL to expire what the
 * first sweeper declined to delete, which is two mechanisms to reason about
 * instead of one.
 *
 * **The gate is a JOIN against a schema this service does not own.** The
 * referenced set lives in `portfolios.transactions` and `portfolios.positions`
 * (wallets' tables), so it is passed in rather than queried: a sweep that
 * computed "referenced" from instruments' own tables would see an empty world
 * and delete every bar in the database. A symbol is protected when ANY of:
 *
 *   - a transaction references it (any type, open or closed — a closed holding
 *     still needs its history to value the period it was held),
 *   - an OPEN position holds it, which covers a position whose opening
 *     transaction has not been written yet,
 *   - the caller lists it explicitly (`keep`), for the live fetch set.
 *
 * Symbols are compared on the venue-free form (`AAPL` for `AAPL.US`), because
 * that is how `price_bars` keys them.
 */
import { sql } from "drizzle-orm"
import type { DB } from "../db/index.js"
import { closeDb } from "../db/index.js"

export interface PruneReport {
  /** Symbols examined. */
  considered: number
  /** Symbols deleted. */
  removed: string[]
  /** `price_bars` rows deleted. */
  barRows: number
  /** Symbols that were protected, with the reason. */
  kept: Array<{ symbol: string; reason: "referenced" | "keep" }>
}

const MAX_REPORTED = 50

/**
 * The symbols a sweep must not touch: the venue-free form of every symbol
 * wallets references, plus anything the caller names.
 */
export function protectedSymbols(referenced: Iterable<string>, extra: Iterable<string> = []): Set<string> {
  const out = new Set<string>()
  for (const raw of [...referenced, ...extra]) {
    if (typeof raw !== "string") continue
    const t = raw.trim()
    if (t) out.add(venueFree(t))
  }
  return out
}

export function venueFree(symbol: string): string {
  return symbol.trim().split(".")[0].toUpperCase()
}

/**
 * `db.execute` returns `{ rows }` under PGlite (the test database) and the bare
 * array under postgres-js (production). Reading `.rows` alone made the script
 * find **zero** candidates in prod and cheerfully report "nothing to prune" —
 * a fixture/prod divergence that the unit tests could not have caught, because
 * they only ever saw one of the two shapes.
 */
function rowsOf<T>(r: { rows?: T[] } | T[]): T[] {
  return Array.isArray(r) ? r : (r.rows ?? [])
}

export async function pruneOrphanedBars(
  db: DB,
  referenced: Iterable<string>,
  opts: { keep?: Iterable<string>; dryRun?: boolean } = {},
): Promise<PruneReport> {
  const keep = protectedSymbols(referenced, opts.keep ?? [])
  const dryRun = opts.dryRun ?? false

  const metaRows = await db.execute(sql`select symbol from instruments.price_bar_metadata`)
  const candidates = rowsOf<{ symbol: string }>(metaRows)
  const report: PruneReport = { considered: candidates.length, removed: [], barRows: 0, kept: [] }

  // Bars can exist for a symbol with no metadata row (metadata is upserted on
  // every fetch, so in practice they agree — but a sweep must not assume it).
  const barOnlyRows = await db.execute(
    sql`select symbol, count(*)::int as n from instruments.price_bars group by symbol`,
  )
  const barCounts = new Map<string, number>()
  for (const r of rowsOf<{ symbol: string; n: number }>(barOnlyRows)) {
    barCounts.set(venueFree(r.symbol), r.n)
  }
  for (const { symbol } of candidates) {
    const key = venueFree(symbol)
    if (!barCounts.has(key)) barCounts.set(key, 0)
  }

  const orphans = [...barCounts.keys()].filter((s) => !keep.has(s)).sort()
  for (const symbol of orphans) {
    report.barRows += barCounts.get(symbol) ?? 0
    report.removed.push(symbol)
  }
  for (const { symbol } of candidates) {
    const key = venueFree(symbol)
    if (keep.has(key)) report.kept.push({ symbol: key, reason: "referenced" })
  }
  if (report.removed.length > MAX_REPORTED) {
    report.removed = report.removed.slice(0, MAX_REPORTED)
  }
  if (report.kept.length > MAX_REPORTED) {
    report.kept = report.kept.slice(0, MAX_REPORTED)
  }

  if (dryRun || orphans.length === 0) return report

  // One statement, one transaction: either the whole set goes or none of it
  // does. A per-symbol loop would leave the table half-pruned if it died
  // halfway, which is the state nobody can reason about.
  await db.transaction(async (tx) => {
    for (const symbol of orphans) {
      await tx.execute(sql`delete from instruments.price_bars where upper(split_part(symbol,'.',1)) = ${symbol}`)
      await tx.execute(
        sql`delete from instruments.price_bar_metadata where upper(symbol) = ${symbol}`,
      )
    }
  })
  return report
}

// ── entrypoint ─────────────────────────────────────────────────────────
// `node dist/scripts/prune-orphan-bars.js --referenced AAPL,MSFT --apply`
//
// `--referenced` is REQUIRED unless `--all` is passed, and the default is a
// dry run: deleting the entire price history because the caller forgot an
// argument is not a failure mode worth having.
async function main() {
  const args = process.argv.slice(2)
  const flag = (name: string) => args.includes(name)
  const value = (name: string) => {
    const i = args.indexOf(name)
    return i >= 0 ? args[i + 1] : undefined
  }

  if (flag("--all")) {
    console.error(
      "[instruments] refusing to run: --all would delete the whole price history. " +
        "Pass --referenced <symbols> with every symbol a portfolio references.",
    )
    process.exit(2)
  }
  const referencedRaw = value("--referenced")
  if (!referencedRaw) {
    console.error(
      "[instruments] --referenced is required. It is the set of symbols wallets " +
        "references; without it a sweep cannot tell an orphan from a holding.",
    )
    process.exit(2)
  }

  const { getDb } = await import("../db/index.js")
  const db = getDb()
  const apply = flag("--apply")
  const report = await pruneOrphanedBars(db, referencedRaw.split(",").map((s) => s.trim()), {
    keep: (value("--keep") ?? "").split(",").map((s) => s.trim()).filter(Boolean),
    dryRun: !apply,
  })
  console.log(
    `[instruments] prune-orphan-bars ${apply ? "APPLIED" : "DRY RUN"}: ` +
      `considered ${report.considered} metadata symbols, ` +
      `${report.removed.length} orphaned symbol(s), ${report.barRows} bar row(s) would be removed.`,
  )
  if (report.removed.length) console.log(`[instruments] would remove: ${report.removed.join(" ")}`)
  await closeDb()
}

if (process.argv[1]?.endsWith("prune-orphan-bars.js") || process.argv[1]?.endsWith("prune-orphan-bars.ts")) {
  main().catch((err) => {
    console.error("[instruments] prune-orphan-bars failed:", err?.message ?? err)
    process.exit(1)
  })
}
