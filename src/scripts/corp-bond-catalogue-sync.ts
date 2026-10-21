import { closeDb, getDb, type DB } from "../db/index.js"
import { internalServiceUrl } from "../services/internal-url.js"

// Syncs the Catalyst corporate-bond catalogue into ticker_reference (D80 25.3).
//
// Design notes:
// - The CSV comes from cachest `/corp-bond/catalogue` (→ openst scrape of the
//   single server-rendered obligacje.pl listing, ~937 rows, asset_type pinned
//   to corp_bond, listing keys `WSE::{SYMBOL}`).
// - `syncTickerReference` (tickerref-sync.ts) upserts on listingKey, so a run
//   only touches `WSE::` rows — it never deletes and never touches the adanos
//   stock/ETF rows. Delisted bonds therefore linger (harmless: their OHLCV
//   simply 404s upstream); purge, if ever wanted, is a separate decision.
// - The row-count sanity gate below is the protection against a TRUNCATED
//   scrape: the upsert is additive per key, so a short CSV would only update
//   the rows it contains — but an empty/garbage CSV must not silently pass as
//   a "successful" run in the job logs.

const MIN_EXPECTED_ROWS = 500

/** Fetch the catalogue CSV from cachest. Throws on non-200 / non-text.
 *
 * Content type: openst answers `text/csv`, but cachest re-serializes every
 * proxied body as `PlainTextResponse` — so both are accepted. The row-count
 * gate in `syncCorpBondCatalogue` is the real protection against a garbage
 * or truncated body. */
export async function fetchCorpBondCatalogue(baseUrl: string): Promise<string> {
  const url = `${internalServiceUrl(baseUrl, "cache")}/corp-bond/catalogue`
  const res = await fetch(url, { redirect: "error" })
  if (!res.ok) throw new Error(`catalogue fetch failed: HTTP ${res.status} for ${url}`)
  const csv = await res.text()
  const contentType = res.headers.get("content-type") ?? ""
  if (!contentType.includes("text/csv") && !contentType.includes("text/plain")) {
    throw new Error(`expected text/csv or text/plain from ${url}, got ${contentType || "no content-type"}`)
  }
  return csv
}

/** Count data rows (excludes the header); CSV must be non-empty. */
export function countCsvRows(csv: string): number {
  const lines = csv.split(/\r?\n/).filter((l) => l.length > 0)
  return Math.max(0, lines.length - 1)
}

/**
 * Fetch + sanity-check + upsert. Returns the number of upserted rows.
 * Exits non-zero on any failure (job must signal via exit code).
 */
export async function syncCorpBondCatalogue(
  baseUrl: string,
  sync: (csv: string, db: DB) => Promise<{ total: number }>,
  db?: DB,
): Promise<number> {
  const csv = await fetchCorpBondCatalogue(baseUrl)
  const rows = countCsvRows(csv)
  if (rows < MIN_EXPECTED_ROWS) {
    throw new Error(
      `catalogue too small: ${rows} rows (< ${MIN_EXPECTED_ROWS}) — refusing to sync a truncated scrape`,
    )
  }
  const { total } = await sync(csv, db ?? getDb())
  return total
}

const isMain = process.argv[1]?.endsWith("corp-bond-catalogue-sync.js") ?? false
if (isMain) {
  const { syncTickerReference } = await import("./tickerref-sync.js")
  const baseUrl = internalServiceUrl(process.env.CACHEST_URL ?? process.env.OPENST_URL, "cache")
  const total = await syncCorpBondCatalogue(baseUrl, (csv, db) => syncTickerReference(csv, db))
  console.log(`[corp-bond-catalogue-sync] upserted ${total} corp_bond rows into ticker_reference`)
  await closeDb()
  process.exit(0)
}
