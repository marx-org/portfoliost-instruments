import type {
  OpenstProfile,
  OpenstQuote,
  OpenstOhlcvRow,
  OpenstConsensus,
} from "./openst-types.js"

type Row = Record<string, unknown>

function num(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return v
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v)
    if (Number.isFinite(n)) return n
  }
  return undefined
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined
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

export function toInstrumentDetail(symbol: string, profile: OpenstProfile): Record<string, unknown> {
  return {
    id: `${symbol.toUpperCase()}.US`,
    symbol: symbol.toUpperCase(),
    name: str(profile.name) ?? symbol.toUpperCase(),
    exchange: str(pick(profile as Row, "stock_exchange", "exchange")) ?? "US",
    type: "STOCK",
    currency: str(profile.currency) ?? "USD",
  }
}

export function toInstrumentProfile(symbol: string, p: OpenstProfile): Record<string, unknown> {
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

export function toQuote(q: OpenstQuote): Record<string, unknown> {
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
): Record<string, unknown> {
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
): Record<string, unknown> {
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

export function toOverviewMetrics(symbol: string, metrics: Row, profile?: OpenstProfile): Record<string, unknown> {
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

export function toSearchResponse(rows: Array<Record<string, unknown>>): Record<string, unknown> {
  const results = rows
    .map((r) => ({
      symbol: str(r.symbol),
      name: str(r.name),
      type: "STOCK",
      exchange: "US",
      source: "SEC",
    }))
    .filter((r) => r.symbol !== undefined || r.name !== undefined)
  return { count: results.length, results }
}
