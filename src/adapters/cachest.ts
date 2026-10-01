export class UpstreamError extends Error {
  constructor(
    public readonly url: string,
    public readonly status: number,
  ) {
    super(`upstream ${status} for ${url}`)
  }
}

const BASE_URL =
  process.env.CACHEST_URL ?? process.env.OPENST_URL ?? "http://cachest:8080"

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url)
  if (!res.ok) throw new UpstreamError(url, res.status)
  return (await res.json()) as T
}

export function fetchProfile(symbol: string): Promise<Record<string, unknown>> {
  return fetchJson(`${BASE_URL}/equity/profile/${encodeURIComponent(symbol)}`)
}

export function fetchQuote(symbol: string): Promise<Record<string, unknown>> {
  return fetchJson(`${BASE_URL}/equity/quote/${encodeURIComponent(symbol)}`)
}

export function fetchFixedincomeQuote(symbol: string): Promise<Record<string, unknown>> {
  return fetchJson(`${BASE_URL}/fixedincome/quote/${encodeURIComponent(symbol)}`)
}

export function fetchCryptoQuote(pair: string): Promise<Record<string, unknown>> {
  return fetchJson(`${BASE_URL}/crypto/quote/${encodeURIComponent(pair)}`)
}

export function fetchMetrics(symbol: string): Promise<Record<string, unknown>> {
  return fetchJson(`${BASE_URL}/equity/metrics/${encodeURIComponent(symbol)}`)
}

export function fetchProjections(symbol: string): Promise<Record<string, unknown>> {
  return fetchJson(`${BASE_URL}/equity/projections/${encodeURIComponent(symbol)}`)
}

export function fetchOhlcv(
  symbol: string,
  start: string,
  end: string,
): Promise<Array<Record<string, unknown>>> {
  const q = new URLSearchParams({ start, end })
  return fetchJson(`${BASE_URL}/ohlcv/${encodeURIComponent(symbol)}?${q}`)
}

/** Search fund categories by code or name (§78). Returns [] rather than throwing
 * on 404 — a miss is an answer, and the caller merges this leg additively. */
export function fetchFundSearch(query: string): Promise<Array<Record<string, unknown>>> {
  const rows: Array<Record<string, unknown>> = []
  return fetchJson<Array<Record<string, unknown>>>(
    `${BASE_URL}/fund/search/${encodeURIComponent(query)}`,
  ).catch((e) => {
    if (e instanceof UpstreamError && e.status === 404) return rows
    throw e
  })
}

export function fetchFundCategoryHistory(
  code: string,
  start: string,
  end: string,
): Promise<Array<Record<string, unknown>>> {
  // `code` is the provider's own category code (ING01W), not a .TFI symbol.
  // A code upstream does not know is a 404, which fetchJson turns into an
  // UpstreamError — deliberately not an empty array, so "cannot serve" stays
  // distinguishable from "no history in window" (plan §72.39 step 2, stage 5).
  const q = new URLSearchParams({ start, end })
  return fetchJson(`${BASE_URL}/fund/history/${encodeURIComponent(code)}?${q}`)
}

export function fetchCryptoOhlcv(
  pair: string,
  start: string,
  end: string,
): Promise<Array<Record<string, unknown>>> {
  const q = new URLSearchParams({ start, end })
  return fetchJson(`${BASE_URL}/crypto/ohlcv/${encodeURIComponent(pair)}?${q}`)
}

export function fetchFundamentals(
  symbol: string,
  statement: "income" | "balance" | "cash",
  period: "annual" | "quarter",
): Promise<Array<Record<string, unknown>>> {
  const q = new URLSearchParams({ statement, period })
  return fetchJson(`${BASE_URL}/fundamentals/${encodeURIComponent(symbol)}?${q}`)
}

export function fetchCalendarEarnings(start: string, end: string): Promise<Array<Record<string, unknown>>> {
  const q = new URLSearchParams({ start, end })
  return fetchJson(`${BASE_URL}/calendar/earnings?${q}`)
}

export function fetchCalendarDividends(start: string, end: string): Promise<Array<Record<string, unknown>>> {
  const q = new URLSearchParams({ start, end })
  return fetchJson(`${BASE_URL}/calendar/dividend?${q}`)
}

export function fetchSearch(query: string): Promise<Array<Record<string, unknown>>> {
  return fetchJson(`${BASE_URL}/equity/search/${encodeURIComponent(query.trim().toLowerCase())}`)
}

export function fetchCryptoSearch(query: string): Promise<Array<Record<string, unknown>>> {
  return fetchJson(`${BASE_URL}/crypto/search/${encodeURIComponent(query.trim().toLowerCase())}`)
}

export function fetchBondSearch(query: string): Promise<Array<Record<string, unknown>>> {
  return fetchJson(`${BASE_URL}/fixedincome/search/${encodeURIComponent(query.trim().toLowerCase())}`)
}

export function fetchBondProfile(symbol: string): Promise<Record<string, unknown>> {
  return fetchJson(`${BASE_URL}/fixedincome/profile/${encodeURIComponent(symbol)}`)
}

export function fetchBondOhlcv(
  symbol: string,
  start: string,
  end: string,
): Promise<Array<Record<string, unknown>>> {
  const q = new URLSearchParams({ start, end })
  return fetchJson(`${BASE_URL}/fixedincome/ohlcv/${encodeURIComponent(symbol)}?${q}`)
}

export function fetchDividendHistory(symbol: string): Promise<Array<Record<string, unknown>>> {
  return fetchJson(`${BASE_URL}/dividends/${encodeURIComponent(symbol)}`)
}

export interface LogoResolution {
  source: string
  remote_url: string
}

export function fetchLogo(symbol: string): Promise<LogoResolution> {
  return fetchJson(`${BASE_URL}/logo/${encodeURIComponent(symbol)}`)
}

export function fetchInsiderTrading(symbol: string): Promise<Array<Record<string, unknown>>> {
  return fetchJson(`${BASE_URL}/ownership/${encodeURIComponent(symbol)}`)
}

export function fetchInstitutionalOwnership(symbol: string): Promise<Array<Record<string, unknown>>> {
  return fetchJson(`${BASE_URL}/ownership/institutional/${encodeURIComponent(symbol)}`)
}

export function fetchFilings(symbol: string): Promise<Array<Record<string, unknown>>> {
  return fetchJson(`${BASE_URL}/filings/${encodeURIComponent(symbol)}`)
}

export function fetchMda(symbol: string): Promise<Record<string, unknown> | null> {
  return fetchJson(`${BASE_URL}/fundamentals/${encodeURIComponent(symbol)}/mda`)
}

/**
 * DB-facing translation of a company-news record (stock-news.md N4). Persists
 * what `news_articles` stores: `text` becomes `summary`, `date` becomes
 * `published_at`, and a provider-omitted `symbols` falls back to the ticker it
 * was fetched under (keeps the row queryable + `symbols` NOT NULL). Returns
 * null for records missing the url/title/published_at trio.
 */
export interface NewsArticleInput {
  url: string
  title: string
  summary: string | null
  source: string | null
  publishedAt: Date
  symbols: string[]
}

export function translateCompanyNews(
  raw: Record<string, unknown>,
  fallbackTicker: string,
): NewsArticleInput | null {
  const url = typeof raw.url === "string" ? raw.url : undefined
  const title = typeof raw.title === "string" ? raw.title : undefined
  if (!url || !title) return null

  const publishedAt = new Date(typeof raw.date === "string" ? raw.date : "")
  if (Number.isNaN(publishedAt.getTime())) return null

  const summary = typeof raw.text === "string" && raw.text ? raw.text : null
  const source = typeof raw.source === "string" && raw.source ? raw.source : null
  const rawSymbols = Array.isArray(raw.symbols)
    ? raw.symbols.map((s) => String(s).trim().toUpperCase()).filter(Boolean)
    : []
  const symbols = rawSymbols.length > 0 ? rawSymbols : [fallbackTicker.toUpperCase()]

  return { url, title, summary, source, publishedAt, symbols }
}

/** Filter openst company-news records into DB-ready rows ([] skips bad ones). */
export function translateCompanyNewsList(
  raw: Array<Record<string, unknown>>,
  fallbackTicker: string,
): NewsArticleInput[] {
  const out: NewsArticleInput[] = []
  for (const r of raw) {
    const mapped = translateCompanyNews(r, fallbackTicker)
    if (mapped && !out.some((a) => a.url === mapped.url)) out.push(mapped)
  }
  return out
}

/**
 * Company news via cachest (stock-news.md N4). `start_date` is day-granular at
 * the provider (OpenBB `CompanyNewsQueryParams`), so overlapping re-fetch
 * windows are absorbed by the url-PK dedup in the news service.
 */
export function fetchCompanyNews(
  ticker: string,
  startDate?: string,
  limit = 50,
): Promise<Array<Record<string, unknown>>> {
  const q = new URLSearchParams({ limit: String(limit) })
  if (startDate) q.set("start_date", startDate)
  return fetchJson(`${BASE_URL}/news/company/${encodeURIComponent(ticker)}?${q}`)
}
