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
