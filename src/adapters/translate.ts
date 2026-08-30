import type {
  OpenstProfile,
  OpenstQuote,
  OpenstOhlcvRow,
  OpenstConsensus,
} from "./openst-types.js"
import type { components } from "../generated/api-types.js"

type S = components["schemas"]

export type Row = Record<string, unknown>

function num(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return v
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v)
    if (Number.isFinite(n)) return n
  }
  return undefined
}

export function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined
}

function round(n: number, digits = 2): number {
  const f = 10 ** digits
  return Math.round(n * f) / f
}

function pick(row: Row, ...keys: string[]): unknown {
  for (const k of keys) {
    if (row[k] !== undefined && row[k] !== null) return row[k]
  }
  return undefined
}

function epochSeconds(value: string | undefined, fallback = Date.now()): number {
  if (!value) return Math.floor(fallback / 1000)
  const ms = Date.parse(value.includes("T") ? value : value.replace(" ", "T") + "Z")
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : Math.floor(fallback / 1000)
}

const NY_TZ = "America/New_York"

export function marketPhase(now = new Date()): { session: string; phase: string } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: NY_TZ,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(now)
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? ""
  const weekday = get("weekday")
  const minutes = parseInt(get("hour"), 10) * 60 + parseInt(get("minute"), 10)
  if (weekday === "Sat" || weekday === "Sun") return { session: "closed", phase: "closed" }
  if (minutes < 9 * 60 + 30) return { session: "pre-market", phase: "pre-market" }
  if (minutes < 16 * 60) return { session: "regular", phase: "regular" }
  if (minutes < 20 * 60) return { session: "post-market", phase: "post-market" }
  return { session: "closed", phase: "closed" }
}

export function toInstrumentDetail(symbol: string, profile: OpenstProfile): S["InstrumentDetail"] {
  return {
    id: `${symbol.toUpperCase()}.US`,
    symbol: symbol.toUpperCase(),
    name: str(profile.name) ?? symbol.toUpperCase(),
    exchange: str(pick(profile as Row, "stock_exchange", "exchange")) ?? "US",
    type: "STOCK",
    currency: str(profile.currency) ?? "USD",
  }
}

export function toInstrumentProfile(symbol: string, p: OpenstProfile): S["InstrumentProfile"] {
  const marketCap = num(pick(p as Row, "market_cap"))
  const currency = str(p.currency) ?? "USD"
  return {
    ticker: symbol.toUpperCase(),
    name: str(p.name),
    country: str(pick(p as Row, "hq_country", "country")),
    currency,
    exchange: str(pick(p as Row, "stock_exchange", "exchange")),
    finnhubIndustry: str(pick(p as Row, "industry_category", "sector")) ?? null,
    ipo: str(pick(p as Row, "ipo_date", "first_stock_price_date")) ?? null,
    logo: null,
    marketCapitalization: marketCap !== undefined ? marketCap / 1e6 : null,
    marketCapCurrency: marketCap !== undefined ? currency : null,
    marketcapUSD: marketCap ?? null,
    phone: str(pick(p as Row, "business_phone_no", "phone")) ?? null,
    shareOutstanding: num(p.shares_outstanding) ?? null,
    weburl: str(pick(p as Row, "company_url", "website")) ?? null,
    description: str(p.long_description) ?? null,
    gicsSector: null,
    gicsIndustryGroup: null,
    gicsIndustry: null,
    gicsSubIndustry: null,
    address: str(p.hq_address1) ?? null,
    city: str(p.hq_address_city) ?? null,
    state: str(p.hq_state) ?? null,
    employeeTotal: num(pick(p as Row, "employees", "employee_total")) ?? null,
    ceo: str(p.ceo) ?? null,
  }
}

export function toQuote(q: OpenstQuote): S["Quote"] {
  const lastPrice = num(pick(q as Row, "last_price")) ?? 0
  const prevClose = num(pick(q as Row, "prev_close")) ?? lastPrice
  let percentChange = num(q.change_percent)
  if (percentChange !== undefined && Math.abs(percentChange) < 1) percentChange *= 100
  const change = num(q.change) ?? (lastPrice - prevClose)
  const fallbackPercent = prevClose !== 0 ? (change / prevClose) * 100 : 0
  const timestamp = epochSeconds(str(q.last_timestamp))
  const { session, phase } = marketPhase()
  return {
    symbol: (str(q.symbol) ?? "").toUpperCase(),
    currentPrice: lastPrice,
    highPrice: num(q.high) ?? lastPrice,
    lowPrice: num(q.low) ?? lastPrice,
    openPrice: num(q.open) ?? lastPrice,
    previousClose: prevClose,
    change,
    percentChange: percentChange ?? fallbackPercent,
    timestamp,
    marketSession: session,
    timezone: NY_TZ,
    bid: num(q.bid) ?? 0,
    ask: num(q.ask) ?? 0,
    bidSize: num(q.bid_size) ?? 0,
    askSize: num(q.ask_size) ?? 0,
    currency: str(q.currency) ?? "USD",
    regularMarketPrice: lastPrice,
    extendedHoursChange: 0,
    extendedHoursChangePercent: 0,
    marketSessionPhase: phase,
    source: "openst",
    asOf: timestamp * 1000,
  }
}

function dayStartEpoch(date: string): number {
  return Math.floor(Date.parse(date + "T00:00:00Z") / 1000)
}

export function toPriceHistory(
  rows: OpenstOhlcvRow[],
  resolution: "daily" | "monthly",
): S["PriceHistory"] {
  if (resolution === "monthly") {
    const buckets = new Map<string, OpenstOhlcvRow[]>()
    for (const r of rows) {
      const key = r.date.slice(0, 7)
      const list = buckets.get(key) ?? []
      list.push(r)
      buckets.set(key, list)
    }
    rows = [...buckets.values()].map((list) => ({
      date: list[0].date,
      open: list[0].open,
      high: Math.max(...list.map((r) => r.high)),
      low: Math.min(...list.map((r) => r.low)),
      close: list[list.length - 1].close,
      volume: list.reduce((acc, r) => acc + r.volume, 0),
    }))
  }
  return {
    symbol: "",
    closePrices: rows.map((r) => r.close),
    highPrices: rows.map((r) => r.high),
    lowPrices: rows.map((r) => r.low),
    openPrices: rows.map((r) => r.open),
    volumes: rows.map((r) => r.volume),
    timestamps: rows.map((r) => dayStartEpoch(r.date)),
    status: "ok",
    currency: "USD",
  }
}

export function toInstrumentMetrics(
  symbol: string,
  metrics: Row,
  consensus?: OpenstConsensus,
): S["InstrumentMetrics"] {
  const n = (k: string) => num(metrics[k])
  const targetMean =
    consensus?.target_consensus ?? consensus?.target_median
  return {
    metrics: {
      symbol: symbol.toUpperCase(),
      metricType: "all",
      metric: metrics,
    },
    priceTarget: consensus
      ? {
          symbol: symbol.toUpperCase(),
          targetHigh: num(consensus.target_high) ?? 0,
          targetLow: num(consensus.target_low) ?? 0,
          targetMean: targetMean ?? 0,
          targetMedian: num(consensus.target_median) ?? 0,
          numberAnalysts: num(consensus.number_of_analysts) ?? 0,
          lastUpdated: new Date().toISOString().slice(0, 19),
        }
      : undefined,
    trailingValuation: {
      marketCap: n("market_cap"),
      enterpriseValue: n("enterprise_value"),
      peRatio: n("pe_ratio"),
      psRatio: n("ps_ratio"),
      pbRatio: n("pb_ratio"),
      evToSales: n("ev_to_sales"),
      evToEBITDA: n("ev_to_ebitda"),
      dividendYield: n("dividend_yield"),
      dividendPerShare: n("dividend_per_share"),
      payoutRatio: n("payout_ratio"),
      pegRatio: n("peg_ratio"),
      priceTarget: targetMean,
    },
    margins: {
      grossMargin: n("gross_margin"),
      operatingMargin: n("operating_margin"),
      ebitdaMargin: n("ebitda_margin"),
      netProfitMargin: n("net_profit_margin"),
    },
    capitalEfficiency: {
      returnOnAssets: n("return_on_assets"),
      returnOnTotalAssets: n("return_on_total_assets"),
      returnOnEquity: n("return_on_equity"),
      assetTurnover: n("asset_turnover"),
    },
    financialHealth: {
      currentRatio: n("current_ratio"),
      quickRatio: n("quick_ratio"),
    },
    perShare: {
      revenuePerShare: n("revenue_per_share"),
      eps: n("eps_diluted") ?? n("diluted_eps_ttm"),
      bookValuePerShare: n("book_value_per_share"),
      cashPerShare: n("cash_per_share"),
    },
  }
}

export function toOverviewMetrics(symbol: string, metrics: Row, profile?: OpenstProfile): S["InstrumentOverviewMetrics"] {
  const n = (k: string) => num(metrics[k])
  return {
    symbol: symbol.toUpperCase(),
    marketCap: n("market_cap"),
    enterpriseValue: n("enterprise_value"),
    sharesOutstanding: n("shares_outstanding"),
    revenue: n("revenue"),
    employees: num(profile?.employees) ?? null,
    cash: n("cash"),
    netDebt: n("net_debt"),
  }
}

export const SEARCH_RESULT_LIMIT = 50

export interface TickerReferenceRow {
  ticker: string
  exchange: string
  name: string
  assetType: string
  yahooSuffix?: string | null
}

export function toReferenceSearchResponse(rows: TickerReferenceRow[]): S["InstrumentSearchResponse"] {
  return {
    count: rows.length,
    results: rows.map((r) => ({
      // Non-US listings carry their Yahoo venue suffix (SNT.WA) so ticker
      // collisions stay apart; US listings keep the bare ticker — the SPA
      // appends the legacy ".US" route suffix itself.
      symbol: r.yahooSuffix ? `${r.ticker}.${r.yahooSuffix}` : r.ticker,
      name: r.name,
      type: r.assetType === "ETF" ? "ETF" : "STOCK",
      exchange: r.exchange,
      source: "TICKERDB",
    })),
  }
}

export function toSearchResponse(rows: Array<Record<string, unknown>>): S["InstrumentSearchResponse"] {
  const results = rows
    .map((r) => ({
      symbol: str(r.symbol),
      name: str(r.name),
      type: "STOCK",
      exchange: "US",
      source: "SEC",
    }))
    .filter((r) => r.symbol !== undefined || r.name !== undefined)
  // Broad queries (single letters) match thousands of instruments in the SEC
  // universe — cap the payload so clients never render unbounded lists.
  return { count: Math.min(results.length, SEARCH_RESULT_LIMIT), results: results.slice(0, SEARCH_RESULT_LIMIT) }
}

// ---------------------------------------------------------------------------
// pt2: fundamentals / calendar / dividends / projections / compare /
// historical price
// ---------------------------------------------------------------------------

function n(v: unknown): number | undefined {
  return num(v)
}

function growth(current: number | undefined, previous: number | undefined): number | null {
  if (current === undefined || previous === undefined || previous === 0) return null
  return Math.round(((current - previous) / Math.abs(previous)) * 100 * 100) / 100
}

export function toFundamentals(
  income: Row[],
  balance: Row[],
  cash: Row[],
): S["FundamentalsData"] {
  const year = (r: Row): number | undefined => {
    const fy = num(pick(r, "fiscal_year", "calendar_year"))
    if (fy !== undefined) return fy
    const pe = str(pick(r, "period_ending", "date"))
    return pe ? Number(pe.slice(0, 4)) || undefined : undefined
  }

  const incomeStatement = income.map((r, i) => ({
    year: year(r),
    revenue: num(r.revenue),
    ebit: num(pick(r, "ebit", "operating_income")),
    netIncome: num(pick(r, "net_income", "bottom_line_net_income")),
    netIncomeGrowth: growth(num(r.net_income), num(income[i + 1]?.net_income)),
    netIncomeMargin:
      num(r.net_income) !== undefined && num(r.revenue)
        ? Math.round((num(r.net_income)! / num(r.revenue)!) * 10000) / 100
        : undefined,
    earningsPerShare: num(pick(r, "diluted_earnings_per_share", "basic_earnings_per_share", "eps")),
    earningsPerShareGrowth: growth(
      num(pick(r, "diluted_earnings_per_share", "eps")),
      num(pick(income[i + 1] ?? {}, "diluted_earnings_per_share", "eps")),
    ),
    dilutedSharesOutstanding: num(pick(r, "diluted_average_shares", "weighted_average_shares_diluted")),
    ebitda: num(r.ebitda),
  }))

  const balanceSheet = balance.map((r) => ({
    year: year(r),
    totalAssets: num(r.total_assets),
    totalLiabilities: num(r.total_liabilities),
    shareholdersEquity: num(pick(r, "shareholders_equity", "total_equity")),
    cash: num(pick(r, "cash_and_equivalents", "cash_n_equivalents", "cash_and_short_term_investments")),
    cashAndShortTermInvestments: num(
      pick(r, "cash_and_short_term_investments", "cash_and_equivalents"),
    ),
    totalDebt: num(pick(r, "total_debt", "long_term_debt")),
    netDebt: num(r.net_debt),
    workingCapital:
      num(r.total_current_assets) !== undefined && num(r.total_current_liabilities) !== undefined
        ? num(r.total_current_assets)! - num(r.total_current_liabilities)!
        : undefined,
    retainedEarnings: num(r.retained_earnings),
    debtEquityRatio:
      num(pick(r, "total_debt")) !== undefined && num(r.shareholders_equity)
        ? Math.round((num(r.total_debt)! / num(r.shareholders_equity)!) * 100) / 100
        : undefined,
  }))

  const cashFlow = cash.map((r, i) => {
    const op = num(pick(r, "operating_cash_flow", "cash_flow_from_operating_activities", "net_cash_from_operating_activities"))
    const capexRaw = num(pick(r, "capital_expenditure", "capex"))
    const fcf = op !== undefined && capexRaw !== undefined ? op - capexRaw : undefined
    const prevOp = num(pick(cash[i + 1] ?? {}, "operating_cash_flow", "net_cash_from_operating_activities"))
    const prevCapex = num(pick(cash[i + 1] ?? {}, "capital_expenditure"))
    const prevFcf = prevOp !== undefined && prevCapex !== undefined ? prevOp - prevCapex : undefined
    return {
      year: year(r),
      cashFlowFromOperatingActivities: op,
      cashFlowFromFinancingActivities: num(pick(r, "financing_cash_flow", "net_cash_from_financing_activities")),
      cashFlowFromInvestingActivities: num(pick(r, "investing_cash_flow", "net_cash_from_investing_activities")),
      freeCashFlow: fcf,
      freeCashFlowGrowth: growth(fcf, prevFcf),
      cashFlowFromOperatingActivitiesGrowth: growth(op, prevOp),
      capitalExpenditures: capexRaw,
      depreciation: num(pick(r, "depreciation_and_amortization", "depreciation")),
      dividendPayment: num(pick(r, "dividends_paid", "dividend_payment")),
    }
  })

  return { financialHighlights: { incomeStatement, balanceSheet, cashFlow } }
}

function quarterFromDate(date: string): number {
  const month = Number(date.slice(5, 7))
  return month >= 1 && month <= 12 ? Math.floor((month - 1) / 3) + 1 : 0
}

export function toCalendar(symbol: string, earningsRows: Row[], dividendRows: Row[], currency = "USD"): S["CalendarData"] {
  const sym = symbol.toUpperCase()
  const earnings = earningsRows
    .filter((r) => str(r.symbol)?.toUpperCase() === sym && str(r.report_date))
    .map((r) => {
      const date = str(r.report_date)!
      return {
        date,
        title: `Earnings Report`,
        year: Number(date.slice(0, 4)),
        quarter: quarterFromDate(date),
      }
    })
    .sort((a, b) => a.date.localeCompare(b.date))

  const exDividend = dividendRows
    .filter((r) => str(r.symbol)?.toUpperCase() === sym && str(r.ex_dividend_date))
    .map((r) => {
      const date = str(r.ex_dividend_date)!
      const amount = num(r.amount)
      return {
        date,
        title: "Ex-Dividend",
        year: Number(date.slice(0, 4)),
        amount: amount ?? undefined,
      }
    })
    .sort((a, b) => a.date.localeCompare(b.date))

  return { earnings, exDividend, currency }
}

export function toDividends(rows: Row[], currencyFallback = "USD"): S["DividendsData"] {
  type DividendRow = {
    date: string
    year: number
    amount: number
    currency: string
    type: string
  }
  const history = rows
    .map((r) => {
      const date = str(r.date) ?? str(r.ex_dividend_date)
      const amount = num(r.amount)
      if (!date || amount === undefined) return null
      const row: DividendRow = {
        date,
        year: Number(date.slice(0, 4)),
        amount,
        currency: str(r.currency) ?? currencyFallback,
        type: str(r.type) ?? "regular",
      }
      return row
    })
    .filter((r): r is DividendRow => r !== null)
  return { history }
}

type ProjectionsResult = S["ProjectionsData"]

export function toProjections(
  symbol: string,
  consensus: OpenstConsensus | undefined,
  quote: OpenstQuote | undefined,
  quarterly: EpsQuarter[] = [],
): ProjectionsResult {
  const current = quote?.last_price !== undefined ? num(quote.last_price) : num(quote?.current_price)
  const currency = str(quote?.currency) ?? "USD"
  return {
    currency,
    priceTarget: consensus
      ? {
          lastUpdated: new Date().toISOString().slice(0, 19),
          low: num(consensus.target_low) ?? null,
          mean: num(consensus.target_consensus) ?? num(consensus.target_median) ?? null,
          current: current ?? null,
          high: num(consensus.target_high) ?? null,
        }
      : { lastUpdated: new Date().toISOString().slice(0, 19), low: null, mean: null, current: current ?? null, high: null },
    recommendation: toRecommendationBuckets(consensus?.recommendation),
    // No free analyst-estimate provider exists in the tier (FMP forward_eps
    // is premium), so the estimate blocks show a real historical baseline:
    // distribution of actual EPS/revenue over the reported quarters.
    earnings: toEstimateBlock(quarterly.map((q) => num(q.diluted_earnings_per_share))),
    revenue: toEstimateBlock(quarterly.map(quarterRevenue)),
  }
}

const RATING_BUCKETS = ["strongBuy", "buy", "hold", "sell", "strongSell"] as const

/** yfinance exposes only the mean rating (1=strong buy … 5=strong sell) and
 * the analyst count; place all analysts in the bucket matching the rounded
 * mean rather than inventing a fake distribution. */
function toRecommendationBuckets(rec: OpenstConsensus["recommendation"]): Record<string, unknown> {
  const buckets = Object.fromEntries(RATING_BUCKETS.map((k) => [k, 0])) as Record<(typeof RATING_BUCKETS)[number], number>
  const period = new Date().toISOString().slice(0, 10)
  const mean = typeof rec === "object" && rec !== null ? rec.mean : undefined
  const analysts = typeof rec === "object" && rec !== null ? rec.analysts : null
  if (typeof mean !== "number" || !Number.isFinite(mean)) return { period, ...buckets, analysts: analysts ?? null }
  const idx = Math.min(4, Math.max(0, Math.round(mean) - 1))
  buckets[RATING_BUCKETS[idx]] = typeof analysts === "number" ? analysts : 0
  return { period, strongBuy: buckets.strongBuy, buy: buckets.buy, hold: buckets.hold, sell: buckets.sell, strongSell: buckets.strongSell, analysts: analysts ?? null }
}

function toEstimateBlock(values: Array<number | undefined>): Record<string, unknown> {
  const clean = values.filter((v): v is number => typeof v === "number" && Number.isFinite(v))
  const periods = nextQuarterLabels(4)
  if (clean.length === 0) return { avg: null, high: null, low: null, mean: null, periods }
  const avg = clean.reduce((a, b) => a + b, 0) / clean.length
  return {
    avg: round(avg, avg < 100 ? 2 : 0),
    high: round(Math.max(...clean), Math.max(...clean) < 100 ? 2 : 0),
    low: round(Math.min(...clean), Math.min(...clean) < 100 ? 2 : 0),
    mean: round(avg, avg < 100 ? 2 : 0),
    periods,
  }
}

function nextQuarterLabels(count: number): string[] {
  const labels: string[] = []
  const now = new Date()
  let y = now.getUTCFullYear()
  let q = Math.floor(now.getUTCMonth() / 3) + 1
  for (let i = 0; i < count; i++) {
    labels.push(`Q${q} ${y}`)
    q += 1
    if (q > 4) {
      q = 1
      y += 1
    }
  }
  return labels
}

export function toCompare(
  profile: OpenstProfile,
  quote: OpenstQuote | undefined,
  metrics: Row,
): S["ResearchCompare"] {
  const price = quote?.last_price !== undefined ? num(quote.last_price) : num(metrics.market_cap)
  return {
    symbol: (str(profile.symbol) ?? "").toUpperCase(),
    name: str(profile.name) ?? "",
    price: price ?? undefined,
    marketCap: num(metrics.market_cap) ?? num(profile.market_cap),
    peRatio: num(metrics.pe_ratio),
    forwardPe: num(metrics.forward_pe),
    pbRatio: num(metrics.pb_ratio),
    psRatio: num(metrics.ps_ratio),
    dividendYield: num(metrics.dividend_yield),
    revenueGrowth: num(pick(metrics, "revenue_growth", "revenue_growth_annual")),
    netMargin: num(pick(metrics, "net_profit_margin", "net_margin")),
    roe: num(metrics.return_on_equity),
    grossMargin: num(metrics.gross_margin),
    operatingMargin: num(metrics.operating_margin),
    evToEbitda: num(metrics.ev_to_ebitda),
    evToSales: num(metrics.ev_to_sales),
    fcfMargin: num(pick(metrics, "fcf_margin", "fcfMargin")),
    netIncome: num(metrics.net_income),
    revenue: num(metrics.revenue),
    sharesOutstanding: num(pick(metrics, "shares_outstanding", "sharesOutstanding")),
    currency: str(profile.currency) ?? "USD",
  }
}

export function toHistoricalPrice(
  symbol: string,
  date: string,
  rows: OpenstOhlcvRow[],
  currencyFallback = "USD",
): S["HistoricalPrice"] {
  const target = date.slice(0, 10)
  const candidates = rows.filter((r) => r.date <= target).sort((a, b) => b.date.localeCompare(a.date))
  const row = candidates[0]
  return {
    symbol: symbol.toUpperCase(),
    date: row?.date ?? target,
    price: row?.close,
    currency: currencyFallback,
  }
}

// ─── pt2b: seasonality, eps-surprises, peers, investor relations ──────────

const MONTH_LABELS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]

type SeasonalityResult = S["SeasonalityData"]

export function toSeasonality(
  symbol: string,
  years: number,
  metric: "avg" | "median" | "min" | "max",
  rows: OpenstOhlcvRow[],
): SeasonalityResult {
  // Group month-end closes by calendar month across the window, then reduce.
  const monthly: number[][] = Array.from({ length: 12 }, () => [])
  const byMonth = new Map<string, OpenstOhlcvRow>()
  const sorted = [...rows].sort((a, b) => a.date.localeCompare(b.date))
  for (const row of sorted) {
    const key = row.date.slice(0, 7)
    byMonth.set(key, row) // last close of the month wins
  }
  const keys = [...byMonth.keys()].sort()
  for (let i = 1; i < keys.length; i++) {
    const prev = byMonth.get(keys[i - 1])!
    const cur = byMonth.get(keys[i])!
    if (!prev.close || !cur.close || prev.close === 0) continue
    const month = Number(cur.date.slice(5, 7)) - 1
    monthly[month].push(((cur.close - prev.close) / prev.close) * 100)
  }
  const reduce = (values: number[]) => {
    if (values.length === 0) return null
    switch (metric) {
      case "median": {
        const s = [...values].sort((a, b) => a - b)
        const mid = Math.floor(s.length / 2)
        return round(s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2)
      }
      case "min":
        return round(Math.min(...values))
      case "max":
        return round(Math.max(...values))
      default:
        return round(values.reduce((a, b) => a + b, 0) / values.length)
    }
  }
  return {
    symbol: symbol.toUpperCase(),
    years,
    metric,
    monthly_returns: MONTH_LABELS.map((month, i) => ({ month, return_pct: reduce(monthly[i]) })),
  }
}

export interface EpsQuarter {
  fiscal_year?: number | string | null
  period_ending?: string | null
  diluted_earnings_per_share?: number | string | null
  revenue?: number | string | null
  total_revenue?: number | string | null
  operating_revenue?: number | string | null
}

/** Quarterly statements name revenue differently across providers/periods. */
export function quarterRevenue(q: EpsQuarter): number | undefined {
  return num(q.revenue) ?? num((q as Row).total_revenue) ?? num((q as Row).operating_revenue)
}

/** Derive EPS surprise rows from quarterly income statements. With no analyst
 * estimates available from the provider tier, the estimate is the prior-year
 * quarter's actual (a YoY baseline); surprise fields follow from that. */
export function toEpsSurprises(symbol: string, quarters: EpsQuarter[]): S["EPSSurprises"] {
  const sorted = [...quarters].sort((a, b) => str(a.period_ending)!.localeCompare(str(b.period_ending)!))
  const rows = sorted.map((q, i): Row => {
    const eps = num(q.diluted_earnings_per_share)
    const revenue = quarterRevenue(q)
    const date = (str(q.period_ending) ?? "").slice(0, 10)
    const priorYear = sorted.find(
      (p) => p !== q && (str(p.period_ending) ?? "").slice(0, 10) === shiftYear(date, -1),
    )
    const epsEstimate = num(priorYear?.diluted_earnings_per_share)
    const revenueEstimate = num(priorYear?.revenue)
    return {
      date,
      year: date ? Number(date.slice(0, 4)) : null,
      quarter: date ? Math.ceil(Number(date.slice(5, 7)) / 3) : null,
      eps: eps ?? null,
      epsEstimate: epsEstimate ?? null,
      epsDifference: eps !== undefined && epsEstimate !== undefined ? round(eps - epsEstimate) : null,
      revenue: revenue ?? null,
      revenueEstimate: revenueEstimate ?? null,
      revenueDifference:
        revenue !== undefined && revenueEstimate !== undefined && revenueEstimate !== 0
          ? round(((revenue - revenueEstimate) / revenueEstimate) * 100)
          : null,
      surprise: eps !== undefined && epsEstimate !== undefined ? round(eps - epsEstimate) : null,
      surprisePercent:
        eps !== undefined && epsEstimate !== undefined && epsEstimate !== 0
          ? round(((eps - epsEstimate) / Math.abs(epsEstimate)) * 100)
          : null,
      time: i < sorted.length - 1 ? "after-hours" : null,
    }
  })
  void symbol
  const annual = rows.filter((r) => typeof r.date === "string" && !r.date.endsWith("-09-30"))
  return { annual: annual.slice(-4), quarterly: rows.slice(-12) }
}

function shiftYear(date: string, delta: number): string {
  const y = Number(date.slice(0, 4)) + delta
  return `${y}${date.slice(4)}`
}

/** IR events derived from real reported quarters — no transcript/audio
 * providers exist in the tier, so events carry no audioUrl. */
export function toInvestorRelations(symbol: string, quarters: EpsQuarter[]): Array<S["InvestorRelationEvent"]> {
  const sym = symbol.toUpperCase()
  return [...quarters]
    .sort((a, b) => str(b.period_ending)!.localeCompare(str(a.period_ending)!))
    .slice(0, 24)
    .map((q): Row => {
      const date = (str(q.period_ending) ?? "").slice(0, 10)
      const year = date ? Number(date.slice(0, 4)) : null
      const quarter = date ? Math.ceil(Number(date.slice(5, 7)) / 3) : null
      return {
        type: "transcript",
        id: `${sym}_${date}`,
        title: `${sym} - Earnings call Q${quarter} ${year}`,
        date: `${date} 21:01:04`,
        year,
        quarter,
        symbol: sym,
        audioUrl: null,
      }
    })
}

type IrTranscriptResult = S["IRTranscript"]

export function toIrTranscript(eventId: string, symbol: string): IrTranscriptResult {
  const m = eventId.match(/_(\d{4})-(\d{2})/)
  const year = m ? Number(m[1]) : null
  const quarter = m ? Math.ceil(Number(m[2]) / 3) : null
  return {
    id: eventId,
    symbol: symbol.toUpperCase(),
    year,
    quarter,
    title: `${symbol.toUpperCase()} - Earnings call Q${quarter} ${year}`,
    time: null,
    participant: [],
    audio: null,
    transcript: [],
  }
}
