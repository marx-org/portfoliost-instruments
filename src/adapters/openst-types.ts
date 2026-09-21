export interface OpenstProfile {
  symbol?: string
  name?: string
  currency?: string
  stock_exchange?: string
  exchange?: string
  hq_country?: string
  country?: string
  hq_address1?: string
  hq_address_city?: string
  hq_state?: string
  hq_address_postal_code?: string
  industry_category?: string
  sector?: string
  long_description?: string
  company_url?: string
  website?: string
  business_phone_no?: string
  phone?: string
  employees?: number
  employee_total?: number
  ceo?: string | null
  cik?: string
  cusip?: string
  isin?: string
  beta?: number
  market_cap?: number
  ipo_date?: string
  first_stock_price_date?: string
  annualized_dividend_amount?: number
  dividend_yield?: number
  [key: string]: unknown
}

export interface OpenstQuote {
  symbol?: string
  name?: string
  exchange?: string
  currency?: string
  last_price?: number
  close?: number
  last_timestamp?: string
  open?: number
  high?: number
  low?: number
  prev_close?: number
  volume?: number
  change?: number
  change_percent?: number
  year_high?: number
  year_low?: number
  ma50?: number
  ma200?: number
  bid?: number
  ask?: number
  bid_size?: number
  ask_size?: number
  market_cap?: number
  [key: string]: unknown
}

export interface OpenstOhlcvRow {
  date: string
  open: number
  high: number
  low: number
  close: number
  volume: number
}

export type OpenstStatement = "income" | "balance" | "cash"
export type OpenstPeriod = "annual" | "quarter"

export interface OpenstCalendarEntry {
  report_date?: string
  ex_dividend_date?: string
  symbol?: string
  [key: string]: unknown
}

export interface OpenstSearchResult {
  cik?: number | string
  name?: string
  symbol?: string
}

export interface OpenstConsensus {
  symbol?: string
  target_high?: number
  target_low?: number
  target_median?: number
  target_consensus?: number
  current_price?: number
  recommendation?:
    | string
    | {
        mean?: number | null
        rating?: string | null
        analysts?: number | null
      }
    | null
  recommendation_mean?: number
  number_of_analysts?: number
}

/**
 * Company news record as mapped by openst's `get_company_news()`
 * (stock-news.md N1): `{date, title, text, url, symbols, source}`.
 * `symbols` is always a list ([] when the provider omits it); `source` is the
 * outlet (publisher name, else author).
 */
export interface OpenstNewsArticle {
  date?: string
  title?: string
  text?: string
  url?: string
  symbols?: string[]
  source?: string
}
