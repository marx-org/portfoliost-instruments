import { readFile } from "node:fs/promises"
import { sql } from "drizzle-orm"
import { closeDb, getDb, type DB } from "../db/index.js"
import { exchangeReference, tickerReference } from "../db/schema.js"

// Syncs ticker reference data from adanos/free-ticker-database into the
// ticker_reference table. Designed to run as a one-shot job (k8s CronJob,
// docker compose run) — exits non-zero on failure.

const DEFAULT_SOURCE_URL =
  "https://raw.githubusercontent.com/adanos-software/free-ticker-database/main/data/core_listings.csv"
const DEFAULT_VENUES_URL =
  "https://raw.githubusercontent.com/adanos-software/free-ticker-database/main/data/canonical_v4/venues.csv"
const DEFAULT_MIC_URL =
  "https://raw.githubusercontent.com/wnjoon/go-yfinance/main/pkg/utils/mic.go"

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

/** Extract MIC → Yahoo-suffix pairs. Accepts go-yfinance's mic.go source
 * (live sync) or the bundled seed/mic_yahoo_suffixes.csv (seed mode). */
export function parseMicSuffixes(input: string): Array<{ operatingMic: string; yahooSuffix: string | null }> {
  if (input.includes("operating_mic")) {
    return parseCsv(input)
      .filter((r) => r.operating_mic)
      .map((r) => ({ operatingMic: r.operating_mic, yahooSuffix: r.yahoo_suffix || null }))
  }
  const pairs = input.match(/"([A-Z0-9]{4})":\s*"([A-Za-z]*)"/g) ?? []
  const seen = new Map<string, string | null>()
  for (const pair of pairs) {
    const m = pair.match(/"([A-Z0-9]{4})":\s*"([A-Za-z]*)"/)!
    seen.set(m[1], m[2] || null)
  }
  return [...seen.entries()].map(([operatingMic, yahooSuffix]) => ({ operatingMic, yahooSuffix }))
}

/** Upsert venue metadata (adanos canonical_v4/venues.csv) enriched with
 * Yahoo suffixes via the MIC mapping. */
export async function syncExchangeReference(venuesCsv: string, micGoSource: string, db: DB = getDb()): Promise<{ total: number }> {
  const suffixByMic = new Map(parseMicSuffixes(micGoSource).map((r) => [r.operatingMic, r.yahooSuffix]))
  const venues = parseCsv(venuesCsv).filter((v) => v.exchange_code)
  if (venues.length === 0) return { total: 0 }
  await db
    .insert(exchangeReference)
    .values(
      venues.map((v) => ({
        exchangeCode: v.exchange_code.toUpperCase(),
        operatingMic: v.operating_mic || null,
        canonicalName: v.canonical_name || null,
        countryCode: v.country_code || null,
        yahooSuffix: suffixByMic.get((v.operating_mic || "").toUpperCase()) ?? null,
      })),
    )
    .onConflictDoUpdate({
      target: exchangeReference.exchangeCode,
      set: {
        operatingMic: sqlExcluded("operating_mic"),
        canonicalName: sqlExcluded("canonical_name"),
        countryCode: sqlExcluded("country_code"),
        yahooSuffix: sqlExcluded("yahoo_suffix"),
        updatedAt: new Date(),
      },
    })
  return { total: venues.length }
}

async function fetchOrRead(url: string, file: string): Promise<string> {
  if (file) {
    console.log(`[tickerref] reading ${file}`)
    return readFile(file, "utf8")
  }
  console.log(`[tickerref] fetching ${url}`)
  const res = await fetch(url)
  if (!res.ok) {
    throw new Error(`source fetch failed: HTTP ${res.status}`)
  }
  return res.text()
}

async function main() {
  const fileArgIdx = process.argv.indexOf("--file")
  const urlArgIdx = process.argv.indexOf("--url")
  const fileBase = fileArgIdx > -1 ? process.argv[fileArgIdx + 1] : undefined
  const urlBase = urlArgIdx > -1 ? process.argv[urlArgIdx + 1] : undefined
  const ifEmpty = process.argv.includes("--if-empty")
  const sourceUrl = urlBase || process.env.TICKERREF_SOURCE_URL || DEFAULT_SOURCE_URL

  const db = getDb()

  // Tickers: seed mode reads the bundled snapshot; live mode fetches from
  // adanos GitHub. fileBase/urlBase act as path-prefix / URL-override.
  let skipTickers = false
  if (ifEmpty) {
    const [{ count }] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(tickerReference)
    if (count > 0) {
      console.log(`[tickerref] ticker_reference already has ${count} rows — skipping (--if-empty)`)
      skipTickers = true
    }
  }
  if (!skipTickers) {
    const tickersCsv = await fetchOrRead(sourceUrl, fileBase ? `${fileBase}/ticker_reference.csv` : "")
    console.log(`[tickerref] ${(tickersCsv.length / 1e6).toFixed(1)} MB loaded, syncing`)
    const { total } = await syncTickerReference(tickersCsv, db)
    console.log(`[tickerref] synced ${total} tickers`)
  }

  // Venues + MIC→Yahoo-suffix map: failure is non-fatal — identity search
  // still works, only suffix→exchange resolution degrades. --if-empty gates
  // this dataset independently of the ticker seed.
  try {
    if (ifEmpty) {
      const [{ count }] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(exchangeReference)
      if (count > 0) {
        console.log(`[tickerref] exchange_reference already has ${count} rows — skipping (--if-empty)`)
        return
      }
    }
    const venuesCsv = await fetchOrRead(DEFAULT_VENUES_URL, fileBase ? `${fileBase}/venues.csv` : "")
    const micData = await fetchOrRead(
      DEFAULT_MIC_URL,
      fileBase ? `${fileBase}/mic_yahoo_suffixes.csv` : "",
    )
    const { total: venueCount } = await syncExchangeReference(venuesCsv, micData, db)
    console.log(`[tickerref] synced ${venueCount} exchanges`)
  } catch (e) {
    console.error(`[tickerref] exchange reference sync skipped: ${e}`)
  }
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
