import { readFile } from "node:fs/promises"
import { sql } from "drizzle-orm"
import { closeDb, getDb, type DB } from "../db/index.js"
import { tickerReference } from "../db/schema.js"

// Syncs ticker reference data from adanos/free-ticker-database into the
// ticker_reference table. Designed to run as a one-shot job (k8s CronJob,
// docker compose run) — exits non-zero on failure.

const DEFAULT_SOURCE_URL =
  "https://raw.githubusercontent.com/adanos-software/free-ticker-database/main/data/core_listings.csv"

const BATCH_SIZE = 500

/** Minimal RFC4180 CSV row parser (quoted fields, escaped quotes, CRLF). */
export function parseCsvLine(line: string): string[] {
  const out: string[] = []
  let cur = ""
  let inQuotes = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"'
          i++
        } else {
          inQuotes = false
        }
      } else {
        cur += ch
      }
    } else if (ch === '"') {
      inQuotes = true
    } else if (ch === ",") {
      out.push(cur)
      cur = ""
    } else {
      cur += ch
    }
  }
  out.push(cur)
  return out
}

export function parseCsv(csv: string): Array<Record<string, string>> {
  const lines = csv.split(/\r?\n/).filter((l) => l.length > 0)
  if (lines.length === 0) return []
  const header = parseCsvLine(lines[0])
  return lines.slice(1).map((line) => {
    const values = parseCsvLine(line)
    const row: Record<string, string> = {}
    header.forEach((h, i) => {
      row[h] = values[i] ?? ""
    })
    return row
  })
}

export async function syncTickerReference(csv: string, db: DB = getDb()): Promise<{ total: number }> {
  const rows = parseCsv(csv)
  let total = 0
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE).filter((r) => r.listing_key && r.ticker)
    if (batch.length === 0) continue
    await db
      .insert(tickerReference)
      .values(
        batch.map((r) => ({
          listingKey: r.listing_key,
          ticker: r.ticker.toUpperCase(),
          exchange: r.exchange,
          name: r.name,
          assetType: r.asset_type,
          stockSector: r.stock_sector || null,
          etfCategory: r.etf_category || null,
          country: r.country || null,
          countryCode: r.country_code || null,
          isin: r.isin || null,
          aliases: r.aliases || null,
        })),
      )
      .onConflictDoUpdate({
        target: tickerReference.listingKey,
        set: {
          ticker: sqlExcluded("ticker"),
          exchange: sqlExcluded("exchange"),
          name: sqlExcluded("name"),
          assetType: sqlExcluded("asset_type"),
          stockSector: sqlExcluded("stock_sector"),
          etfCategory: sqlExcluded("etf_category"),
          country: sqlExcluded("country"),
          countryCode: sqlExcluded("country_code"),
          isin: sqlExcluded("isin"),
          aliases: sqlExcluded("aliases"),
          updatedAt: new Date(),
        },
      })
    total += batch.length
  }
  return { total }
}

function sqlExcluded(column: string) {
  return sql.raw(`excluded.${column}`)
}

async function main() {
  const fileArgIdx = process.argv.indexOf("--file")
  const urlArgIdx = process.argv.indexOf("--url")
  const fileArg = fileArgIdx > -1 ? process.argv[fileArgIdx + 1] : undefined
  const urlArg = urlArgIdx > -1 ? process.argv[urlArgIdx + 1] : undefined
  const ifEmpty = process.argv.includes("--if-empty")
  const sourceUrl = urlArg || process.env.TICKERREF_SOURCE_URL || DEFAULT_SOURCE_URL

  const db = getDb()
  if (ifEmpty) {
    const [{ count }] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(tickerReference)
    if (count > 0) {
      console.log(`[tickerref] table already has ${count} rows — skipping seed (--if-empty)`)
      return
    }
  }

  let csv: string
  if (fileArg) {
    console.log(`[tickerref] reading ${fileArg}`)
    csv = await readFile(fileArg, "utf8")
  } else {
    console.log(`[tickerref] fetching ${sourceUrl}`)
    const res = await fetch(sourceUrl)
    if (!res.ok) {
      throw new Error(`source fetch failed: HTTP ${res.status}`)
    }
    csv = await res.text()
  }
  console.log(`[tickerref] ${(csv.length / 1e6).toFixed(1)} MB loaded, syncing`)
  const { total } = await syncTickerReference(csv, db)
  console.log(`[tickerref] synced ${total} tickers`)
}

if (process.argv[1] && process.argv[1].endsWith("tickerref-sync.js")) {
  main()
    .then(() => closeDb())
    .then(() => process.exit(0))
    .catch((e) => {
      console.error("[tickerref] sync failed:", e)
      process.exit(1)
    })
}
