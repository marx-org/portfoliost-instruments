/**
 * stock-news.md N4 — company news service (incremental sync + on-read purge).
 *
 * `getNewsForTicker` runs the read-through sync on every call:
 *
 *   1. purge rows with `expires_at < now()`                (NEWS_EXPIRY_DAYS)
 *   2. watermark = MAX(published_at) for the ticker
 *   3. round the watermark DOWN to the nearest hour bucket (NEWS_SYNC_GRANULARITY_HOURS;
 *      0 = exact timestamp)
 *   4. start_date = watermark hour, else now - 10 days (first fetch)
 *   5. GET cachest /news/company/{ticker}?start_date=…&limit=…
 *   6. UPSERT on url — refresh symbols (union) + expires_at
 *   7. return stored rows for the ticker, newest first, capped by limit
 *
 * Freshness authority is cachest (1h TTL + stale fallback); the DB is the
 * long-term store (default 90 days). Provider dates are day-granular, so the
 * rounded watermark keeps the re-fetch window small while the url-PK dedup
 * absorbs the overlap.
 */
import { arrayContains, desc, lt, sql } from "drizzle-orm"
import type { DB } from "../db/index.js"
import { newsArticles } from "../db/schema.js"
import {
  fetchCompanyNews,
  translateCompanyNewsList,
  type NewsArticleInput,
} from "../adapters/cachest.js"
import { providerSymbol } from "../adapters/symbol.js"

const DEFAULT_EXPIRY_DAYS = 90
const DEFAULT_FETCH_LIMIT = 50
const DEFAULT_GRANULARITY_HOURS = 1
const FIRST_FETCH_WINDOW_DAYS = 10

function envInt(name: string, fallback: number): number {
  const v = Number(process.env[name])
  return Number.isFinite(v) && v >= 0 ? v : fallback
}

export const newsExpiryDays = () => envInt("NEWS_EXPIRY_DAYS", DEFAULT_EXPIRY_DAYS)
export const newsFetchLimit = () => envInt("NEWS_FETCH_LIMIT", DEFAULT_FETCH_LIMIT)
export const newsGranularityHours = () => envInt("NEWS_SYNC_GRANULARITY_HOURS", DEFAULT_GRANULARITY_HOURS)

/** Ticker used against the provider + stored rows (strip .US for US venues). */
export function newsTicker(routeSymbol: string): string {
  return providerSymbol(routeSymbol)
}

/**
 * Round a timestamp DOWN to the start of its `granularityHours` bucket.
 * `0` (or null) means the exact timestamp passes through untouched.
 */
export function floorWatermark(
  value: Date | null,
  granularityHours: number,
): Date | null {
  if (!value) return null
  if (!granularityHours) return value
  const bucketMs = granularityHours * 3_600_000
  return new Date(Math.floor(value.getTime() / bucketMs) * bucketMs)
}

/** Sync window start: the rounded watermark's date, else now − 10 days. */
export function syncStartDate(watermark: Date | null, now = new Date()): string {
  const anchor = watermark ?? new Date(now.getTime() - FIRST_FETCH_WINDOW_DAYS * 86_400_000)
  return anchor.toISOString().slice(0, 10)
}

/** `fetch_at + NEWS_EXPIRY_DAYS` — the row's fresh horizon. */
function expiresAtSql() {
  return sql`now() + ${newsExpiryDays()} * interval '1 day'`
}

/** Union existing + incoming symbols (portable across PG16+ prod and PGlite). */
function unionSymbolsSql() {
  return sql`(
    select array_agg(distinct s)::text[]
    from unnest(${newsArticles.symbols} || excluded.symbols) as s
  )`
}

/**
 * Persist fetched records, deduped by url (ON CONFLICT refreshes the symbols
 * union + expiry so overlap restores freshness). `summary`/`title`/etc. keep
 * their first-seen values; only symbols + expiry advance.
 */
async function upsertNewsRows(
  db: DB,
  rows: NewsArticleInput[],
): Promise<void> {
  if (rows.length === 0) return
  for (const r of rows) {
    await db
      .insert(newsArticles)
      .values({
        url: r.url,
        title: r.title,
        summary: r.summary,
        source: r.source,
        publishedAt: r.publishedAt,
        symbols: r.symbols,
        expiresAt: expiresAtSql(),
      })
      .onConflictDoUpdate({
        target: newsArticles.url,
        set: {
          symbols: unionSymbolsSql(),
          expiresAt: expiresAtSql(),
        },
      })
  }
}

/** One read-through sync + read for a ticker. */
export async function getNewsForTicker(
  db: DB,
  routeSymbol: string,
  limit = 50,
  now = new Date(),
): Promise<Array<typeof newsArticles.$inferSelect>> {
  const ticker = newsTicker(routeSymbol)

  // 1. on-read purge — only expired rows leave.
  await db.delete(newsArticles).where(lt(newsArticles.expiresAt, now))

  // 2. watermark — newest article we already know for this ticker.
  const rows = await db
    .select({ wm: newsArticles.publishedAt })
    .from(newsArticles)
    .where(arrayContains(newsArticles.symbols, [ticker]))
    .orderBy(desc(newsArticles.publishedAt))
    .limit(1)
  const watermark = floorWatermark(rows[0]?.wm ?? null, newsGranularityHours())

  // 5. refresh from cachest (only the URL/date-pruned records matter on write).
  let fetched: Array<Record<string, unknown>> = []
  try {
    fetched = await fetchCompanyNews(ticker, syncStartDate(watermark, now), newsFetchLimit())
  } catch {
    // cachest down / rate-limited → serve what we have (freshness authority).
  }
  const mapped = translateCompanyNewsList(fetched, ticker)
  await upsertNewsRows(db, mapped)

  // 7. return stored rows newest-first.
  return db
    .select()
    .from(newsArticles)
    .where(arrayContains(newsArticles.symbols, [ticker]))
    .orderBy(desc(newsArticles.publishedAt))
    .limit(limit)
}

/** Most recent stored rows across all tickers (ticker-less /news/articles).
 * On-read purge + no provider fan-out. */
export async function getRecentNews(
  db: DB,
  limit = 50,
  now = new Date(),
): Promise<Array<typeof newsArticles.$inferSelect>> {
  await db.delete(newsArticles).where(lt(newsArticles.expiresAt, now))
  return db
    .select()
    .from(newsArticles)
    .orderBy(desc(newsArticles.publishedAt))
    .limit(limit)
}