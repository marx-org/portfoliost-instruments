import { closeDb, getDb, type DB } from "../db/index.js"

// Syncs the analizy.pl fund-category catalogue into ticker_reference (plan §78).
//
// Design notes:
// - The CSV comes from cachest `/fund/catalogue` (→ openst's snapshot of the
//   codes enumerated by the refresh job). It is NOT scraped here: the corpus is
//   734 codes built by ~960 requests in two enumeration passes, so per-row
//   fetching is not viable and openst serves a snapshot instead.
// - `syncTickerReference` upserts on listingKey, so a run only touches `ANALIZY::`
//   rows — it never deletes and never touches the adanos stock/ETF rows or the
//   `WSE::` corp-bond rows. Codes that leave the catalogue therefore linger
//   (harmless: their price fetch 404s upstream); purge is a separate decision,
//   exactly as for corp bonds.
// - The row-count gate is the protection against a truncated or garbled body.
//   The two failure modes seen in practice are an HTML error page and a partial
//   body, and both are valid CSV — a permissive gate would accept them and
//   shrink the catalogue a few hundred funds at a time, which is invisible until
//   someone notices a fund missing from search.
//
//   400 against a real count of 734 is ~54%, deliberately close to the corp-bond
//   gate's ratio (500 of ~937, ~53%). A floor set merely "well below" the real
//   count is the same as no floor: 200 would have accepted a 300-row truncation.

const MIN_EXPECTED_ROWS = 400

/** Venue code the listing keys are namespaced under. Mirrors `WSE::` for bonds. */
export const FUND_CATALOGUE_VENUE = "ANALIZY"

/**
 * Fetch the fund catalogue CSV from cachest. Throws on non-200 / non-text.
 *
 * Content type: openst answers `text/csv`, but cachest re-serializes every
 * proxied body as `PlainTextResponse` — so both are accepted, and the row-count
 * gate below is the real protection against a garbage or truncated body.
 */
export async function fetchFundCatalogue(baseUrl: string): Promise<string> {
  const url = `${baseUrl}/fund/catalogue`
  const res = await fetch(url)
  if (!res.ok) throw new Error(`fund catalogue fetch failed: HTTP ${res.status} for ${url}`)
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
export async function syncFundCatalogue(
  baseUrl: string,
  sync: (csv: string, db: DB) => Promise<{ total: number }>,
  db?: DB,
): Promise<number> {
  const csv = await fetchFundCatalogue(baseUrl)
  const rows = countCsvRows(csv)
  if (rows < MIN_EXPECTED_ROWS) {
    throw new Error(
      `fund catalogue too small: ${rows} rows (< ${MIN_EXPECTED_ROWS}) — refusing to sync a truncated scrape`,
    )
  }
  const { total } = await sync(csv, db ?? getDb())
  return total
}

const isMain = process.argv[1]?.endsWith("fund-category-catalogue-sync.js") ?? false
if (isMain) {
  const { syncTickerReference } = await import("./tickerref-sync.js")
  const baseUrl = process.env.CACHEST_URL ?? process.env.OPENST_URL ?? "http://cachest:8080"
  const total = await syncFundCatalogue(baseUrl, (csv, db) => syncTickerReference(csv, db))
  console.log(`[fund-category-catalogue-sync] upserted ${total} fund rows into ticker_reference`)
  await closeDb()
  process.exit(0)
}
