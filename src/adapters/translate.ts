import type {
  OpenstProfile,
  OpenstQuote,
  OpenstOhlcvRow,
  OpenstConsensus,
} from "./openst-types.js"
import { normalizeCryptoRows } from "./crypto.js"
import type { CurrencyResolution } from "../services/instrument-currency.js"
import type { components } from "../generated/api-types.js"

type S = components["schemas"]

/** §66.4 — the placeholder used ONLY where a contract field is non-nullable and
 * the currency genuinely could not be resolved. It is named so it is greppable
 * and countable, it is always paired with `currencySource: "unknown"`, and it is
 * never used where the value is an input (those parameters are now required, so
 * the compiler forces the caller to pass a real one). */
export const UNRESOLVED_CURRENCY = "USD"

/** CurrencySource for a provider-declared code when no resolution is passed. */
function sourceFor(
  resolution: CurrencyResolution | undefined,
  providerCcy: string | null,
  estimated: boolean,
): S["CurrencySource"] {
  if (resolution) return resolution.currencySource
  if (providerCcy) return "provider"
  return estimated ? "estimated" : "unknown"
}

/**
 * §47.4 — a provided resolution wins verbatim, including a null currency
 * ("unknown" must not be masked by a provider-declared fallback). Without a
 * resolution, fall back to the provider declaration then the local heuristic.
 */
function resolutionCurrency(
  resolution: CurrencyResolution | undefined,
  providerCcy: string | null,
  estimatedCcy: string | null,
): string | null {
  if (resolution) return resolution.currency
  return providerCcy ?? estimatedCcy
}

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

function _safeYear(v: unknown): number | undefined {
  const n = num(v)
  return n !== undefined && n > 0 ? n : undefined
}

function _safeQuarter(v: unknown): number | undefined {
  const n = num(v)
  return n !== undefined && n >= 1 && n <= 4 ? n : undefined
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

/** D82 — map a stored/provider asset type onto the contract InstrumentType.
 * Accepts the mixed-case forms the tiers emit ("Stock", "ETF", "CRYPTO",
 * "corp_bond", …); unknown values default to STOCK so a new class never
 * degrades a search row. */
export function toInstrumentType(
  raw: string | null | undefined,
): S["InstrumentDetail"]["type"] {
  const v = (raw ?? "").trim().toLowerCase()
  switch (v) {
    case "etf":
      return "ETF"
    case "bond":
      return "BOND"
    case "crypto":
    case "cryptocurrency":
      return "CRYPTO"
    case "fund":
    case "tfi":
      return "FUND"
    case "corp_bond":
    case "corporate_bond":
    case "corporate bond":
      return "CORP_BOND"
    default:
      return "STOCK"
  }
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

/**
 * Provider pricing-unit normalization (plan §39).
 *
 * Biznesradar prices LSE equities in **pence** and labels the currency `GBp`
 * (non-ISO-4217). The contract wire types require ISO codes, so the adapter
 * boundary divides all price fields by 100 and re-issues the code as `GBP`.
 */
export const PENCE_UNIT = "GBp"

function isPence(currency: string | undefined | null): boolean {
  const c = (currency ?? "").trim()
  // "GBp" and "GBP" collide once lowercased, so the ISO code must be excluded
  // case-sensitively; any other casing of gb* (GBp, gbP, gbp) is pence.
  return c !== "GBP" && c.toLowerCase() === "gbp"
}

function toIsoCurrency(currency: string | null | undefined): string | null | undefined {
  return currency != null && isPence(currency) ? "GBP" : currency
}

function fromPence(value: number | undefined | null, pence: boolean): number | undefined | null {
  return value != null && pence ? value / 100 : value
}

export function toInstrumentDetail(
  symbol: string,
  profile: OpenstProfile,
  resolution?: CurrencyResolution,
): S["InstrumentDetail"] {
  const row = profile as Row
  const isBond = row.rate_rule !== undefined || row.series_code !== undefined
  // D82 — honour the provider's asset_type when it carries one (corp_bond/fund
  // profiles from openst); otherwise keep the bond/stock heuristic so savings
  // bonds still surface as BOND and plain equities as STOCK.
  const type = str(row.asset_type)
    ? toInstrumentType(str(row.asset_type))
    : isBond
      ? "BOND"
      : "STOCK"
  const providerCcy = toIsoCurrency(str(profile.currency)) ?? null
  return {
    id: symbol.toUpperCase(),
    symbol: symbol.toUpperCase(),
    name: str(profile.name) ?? symbol.toUpperCase(),
    exchange: str(pick(row, "stock_exchange", "exchange")) ?? (isBond ? "PL" : "US"),
    type,
    // 45.3 — never guess the price currency (contract field nullable).
    // 47.4 — the route hands the compare-of-provider-vs-local resolution.
    currency: resolutionCurrency(resolution, providerCcy, isBond ? "PLN" : null),
    currencySource: sourceFor(resolution, providerCcy, isBond),
  }
}

/** §86 — a percentage that arrives as a string, e.g. Catalyst `current_rate`
 *  `"7.83%"`. The unit is stripped and the remainder parsed, so the value that
 *  reaches the card is the number 7.83 — keeping the `%` would render as
 *  `7.83%%` through the formatters. A value with no `%` is parsed as a plain
 *  decimal rather than dropped: this is the most useful number on a bond card
 *  and a missing suffix must not cost it. Anything unparseable is null, never
 *  NaN. */
function percentNumber(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null
  const s = str(v)
  if (s === undefined) return null
  return num(s.replace(/%/g, "").trim()) ?? null
}

/** §86 — Polish retail savings bond (obligacjekarbowe). `margin` is the
 *  overloaded column: under `rate_rule: "fixed"` it *is* the flat annual rate,
 *  under the two indexed rules it is the add-on. The value is passed through
 *  untranslated and the label is switched on `rateRule` by the card, because
 *  the same number means two different things depending on that field. */
export function toBondKeyFacts(row: Row): S["BondKeyFacts"] {
  return {
    kind: "bond",
    seriesCode: str(row.series_code) ?? null,
    issueDate: str(row.issue_date) ?? null,
    maturityDate: str(row.maturity_date) ?? null,
    // num() returns 0 for a real 0, and `?? null` does not eat it — a term of
    // 0 months is a fact, not a missing value. No truthiness filter here.
    termMonths: num(row.term_months) ?? null,
    rateRule: str(row.rate_rule) ?? null,
    margin: num(row.margin) ?? null,
    redemptionFee: num(row.fee_b) ?? null,
    nominal: num(row.nominal) ?? null,
  }
}

/** §86 — Catalyst corporate bond (obligacje.pl).
 *
 *  No `margin` key: the scraper never sets one (`obligacje.py` — the detail page
 *  embeds the margin in `coupon_type` for variable-rate bonds) and the recorded
 *  payload has no such key. Its absence is a decision, not an oversight.
 *
 *  `secured` and `status` stay the provider's strings — `"NIE"`, `"Notowane"` —
 *  verbatim and untranslated: mapping them to a boolean or to English would
 *  invent a vocabulary the rest of the app does not have. */
export function toCorpBondKeyFacts(row: Row): S["CorpBondKeyFacts"] {
  return {
    kind: "corp_bond",
    issuer: str(row.issuer) ?? null,
    series: str(row.series) ?? null,
    market: str(row.market) ?? null,
    status: str(row.status) ?? null,
    // "100.0" — a Decimal on the wire, stringified by the provider's frame.
    nominalValue: num(row.nominal_value) ?? null,
    nominalCurrency: str(row.nominal_currency) ?? null,
    secured: str(row.secured) ?? null,
    couponType: str(row.coupon_type) ?? null,
    currentRate: percentNumber(row.current_rate),
    maturityDate: str(row.maturity_date) ?? null,
  }
}

/** Which bond kind a provider row is, or null when it is not a bond at all.
 *
 *  `toInstrumentProfile`'s existing `isBond` test only recognises savings bonds
 *  (a Catalyst row carries `asset_type` and no `rate_rule`), so key facts need
 *  their own discriminator. `isBond` itself is left alone: it also drives the
 *  PLN currency estimate, and widening it is a currency decision, not a
 *  key-facts one. */
function bondKeyFactsKind(row: Row): "bond" | "corp_bond" | null {
  if ((str(row.asset_type) ?? "").toLowerCase() === "corp_bond") return "corp_bond"
  if (row.rate_rule !== undefined || row.series_code !== undefined) return "bond"
  return null
}

/** §86 — crypto. Exactly the fields the one configured search provider returns.
 *  No market cap, rank, ATH or ATL: those are *unavailable* from FMP rather than
 *  empty, and a permanently-null field is a permanent dash. The quote currency
 *  stays on the profile and is deliberately not duplicated here. */
export function toCryptoKeyFacts(row: Row): S["CryptoKeyFacts"] {
  return {
    kind: "crypto",
    name: str(row.name) ?? null,
    exchange: str(row.exchange) ?? null,
    icoDate: str(row.ico_date) ?? null,
    circulatingSupply: num(row.circulating_supply) ?? null,
    totalSupply: num(row.total_supply) ?? null,
  }
}

/** §86 — ETF. One field, and it is a row the backend already fills today and
 *  the UI discards: `ticker_reference.etf_category`. */
export function toEtfKeyFacts(etfCategory: string | null | undefined): S["EtfKeyFacts"] {
  return { kind: "etf", category: str(etfCategory) ?? null }
}

/** §86 — fund. One field, on purpose: the local reference carries name and
 *  aliases only, so there is no manager, OPL/TER or risk class to show and the
 *  page says so rather than implying coverage. Only an ANALIZY listing key
 *  carries a category code — a `TFI::` row's code is its own TFI number, which
 *  is not a category. */
export function toFundKeyFacts(listingKey: string | null | undefined): S["FundKeyFacts"] {
  const key = str(listingKey)
  const prefix = "ANALIZY::"
  return { kind: "fund", categoryCode: key?.startsWith(prefix) ? key.slice(prefix.length) : null }
}

/** §86 — equity. Pure relocation: every value is already on the profile and was
 *  already fetched, so this adds no upstream call.
 *
 *  It takes the **built profile**, not the provider row, and that is the whole
 *  point: `gicsSector`/`gicsIndustry` are hard-coded null in the raw
 *  translation and filled afterwards by the route's reference-table pass, so a
 *  version reading the provider row would return the dashes this exists to
 *  remove. */
export function toStockKeyFacts(profile: S["InstrumentProfile"]): S["StockKeyFacts"] {
  return {
    kind: "stock",
    sector: profile.gicsSector ?? null,
    industry: profile.gicsIndustry ?? null,
    employees: profile.employeeTotal ?? null,
    ceo: profile.ceo ?? null,
    ipo: profile.ipo ?? null,
    sharesOutstanding: profile.shareOutstanding ?? null,
    marketCap: profile.marketCapitalization ?? null,
  }
}

/** §86 — what the route already knows about the symbol before it fetches
 *  anything. `kind` is the reference table's answer, never inferred from the
 *  provider row's shape; the other two are the reference columns the four thin
 *  classes need and the provider never sends. */
export interface KeyFactsContext {
  kind?: "stock" | "etf" | "fund" | "crypto" | "bond" | "corp_bond" | null
  etfCategory?: string | null
  listingKey?: string | null
}

/** §86 — dispatch one profile's key facts.
 *
 *  Takes the provider row and the built profile because the six kinds do not
 *  read the same source: the bond and crypto kinds read provider fields, the
 *  equity kind reads the route's post-fill profile, and the ETF and fund kinds
 *  read reference columns neither of the other two carries. Returns null when
 *  the asset class is unknown, so an unsynced symbol gets no card rather than a
 *  card of dashes. */
export function toKeyFacts(
  row: Row,
  profile: S["InstrumentProfile"],
  ctx: KeyFactsContext = {},
): NonNullable<S["InstrumentProfile"]["keyFacts"]> | null {
  switch (ctx.kind) {
    case "stock":
      return toStockKeyFacts(profile)
    case "etf":
      return toEtfKeyFacts(ctx.etfCategory)
    case "fund":
      return toFundKeyFacts(ctx.listingKey)
    case "crypto":
      return toCryptoKeyFacts(row)
    case "bond":
      return toBondKeyFacts(row)
    case "corp_bond":
      return toCorpBondKeyFacts(row)
    default:
      // No class from the reference table: the bond kinds are still recognisable
      // from the row itself, which is how the translator worked before the route
      // learned to dispatch.
      const bondKind = bondKeyFactsKind(row)
      return bondKind === "corp_bond"
        ? toCorpBondKeyFacts(row)
        : bondKind === "bond"
          ? toBondKeyFacts(row)
          : null
  }
}

export function toInstrumentProfile(
  symbol: string,
  p: OpenstProfile,
  resolution?: CurrencyResolution,
  keyFactsContext?: KeyFactsContext,
): S["InstrumentProfile"] {
  const marketCap = num(pick(p as Row, "market_cap"))
  // 45.3 — same no-guess rule as toInstrumentDetail.
  const row = p as Row
  const isBond = row.rate_rule !== undefined || row.series_code !== undefined
  const providerCcy = toIsoCurrency(str(p.currency)) ?? null
  const currency = resolutionCurrency(resolution, providerCcy, isBond ? "PLN" : null)
  const profile: S["InstrumentProfile"] = {
    ticker: symbol.toUpperCase(),
    name: str(p.name),
    country: str(pick(p as Row, "hq_country", "country")),
    // §61.8 — the shared identity block needs an asset class; the pure
    // translator has no reference table, so the profile route fills it (and
    // leaves this null when the symbol is unknown there).
    assetType: null,
    currency,
    currencySource: sourceFor(resolution, providerCcy, isBond),
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
    // §86 — filled from the profile itself for an equity (the reference-table
    // pass has already run by the time this is reached), and from the provider
    // row for the classes that need provider fields. Null when the asset class
    // is unknown, so an unsynced symbol gets no card rather than six dashes.
    keyFacts: null,
  }
  // Assigned after the object exists because the stock kind reads the finished
  // profile — gicsSector/gicsIndustry are filled in by the route's
  // reference-table pass, which happens after this function returns.
  //
  // So an equity is deliberately left null here: emitting it now would put a
  // `sector: null` on the card directly under a profile that is about to be
  // given a sector. The route recomputes key facts once its fill has run, and
  // that call is the authoritative one.
  profile.keyFacts =
    keyFactsContext?.kind === "stock"
      ? null
      : toKeyFacts(row, profile, keyFactsContext ?? {})
  return profile
}

export function toQuote(q: OpenstQuote, resolution?: CurrencyResolution): S["Quote"] {
  // §39 — LSE rows arrive in pence with currency "GBp": divide every price
  // field by 100 and emit the ISO code so consumers (wallets quotes pass,
  // SPA pre-fills) never see sub-unit prices.
  const pence = isPence(str(q.currency))
  const providerCcy = toIsoCurrency(str(q.currency)) ?? null
  // §42 — CBOE-shaped rows for EU-listed ETFs (SP20.L, ETFSP500.WA, ETFBTCPL.WA,
  // EMIM.AS, …) carry NO `last_price`/`close` — only bid/ask and sometimes
  // open/prev_close. A 200 with `currentPrice: 0` is silently dropped by the
  // wallets quotes pass (`if (!price) return null`), leaving positions with
  // NULL current_price. Fallback chain: last_price → close → bid/ask midpoint
  // (only when BOTH sides are positive — a zero on one side is "no trade",
  // not a price) → open → high → low.
  const row = q as Row
  const priceField = (key: string): number | undefined =>
    fromPence(num(row[key]), pence) ?? undefined
  const bid = priceField("bid")
  const ask = priceField("ask")
  const midpoint =
    bid !== undefined && ask !== undefined && bid > 0 && ask > 0
      ? (bid + ask) / 2
      : undefined
  const lastPrice =
    priceField("last_price") ??
    priceField("close") ??
    midpoint ??
    priceField("open") ??
    priceField("high") ??
    priceField("low") ??
    0
  const prevClose = fromPence(num(pick(row, "prev_close")), pence) ?? lastPrice
  let percentChange = num(q.change_percent)
  if (percentChange !== undefined && Math.abs(percentChange) < 1) percentChange *= 100
  const change = fromPence(num(q.change), pence) ?? (lastPrice - prevClose)
  const fallbackPercent = prevClose !== 0 ? (change / prevClose) * 100 : 0
  const timestamp = epochSeconds(str(q.last_timestamp))
  const { session, phase } = marketPhase()
  return {
    symbol: (str(q.symbol) ?? "").toUpperCase(),
    currentPrice: lastPrice,
    highPrice: fromPence(num(q.high), pence) ?? lastPrice,
    lowPrice: fromPence(num(q.low), pence) ?? lastPrice,
    openPrice: fromPence(num(q.open), pence) ?? lastPrice,
    previousClose: prevClose,
    change,
    percentChange: percentChange ?? fallbackPercent,
    timestamp,
    marketSession: session,
    timezone: NY_TZ,
    bid: fromPence(num(q.bid), pence) ?? 0,
    ask: fromPence(num(q.ask), pence) ?? 0,
    bidSize: num(q.bid_size) ?? 0,
    askSize: num(q.ask_size) ?? 0,
    // 45.3 — null when the provider row declares no currency (plan §47: never a
    // USD guess). 47.4 — the route passes the provider-vs-local comparison;
    // the emit here is `currency` + `currencySource` from the same resolution.
    currency: resolutionCurrency(resolution, providerCcy, null),
    currencySource: sourceFor(resolution, providerCcy, false),
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
  currency: string | null = null,
  currencySource: S["CurrencySource"] = "unknown",
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
    currency,
    currencySource,
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
  countryCode?: string | null
}

export function toReferenceSearchResponse(rows: TickerReferenceRow[]): S["InstrumentSearchResponse"] {
  return {
    count: rows.length,
    results: rows.map((r) => ({
      // Non-US listings carry their Yahoo venue suffix (SNT.WA) so ticker
      // collisions stay apart; US listings keep the bare ticker. The SPA does
      // not append any raw-format suffix.
      symbol: r.yahooSuffix ? `${r.ticker}.${r.yahooSuffix}` : r.ticker,
      name: r.name,
      type: toInstrumentType(r.assetType),
      exchange: r.exchange,
      countryCode: r.countryCode ?? null,
      source: "TICKERDB",
    })),
  }
}

export function toSearchResponse(rows: Array<Record<string, unknown>>): S["InstrumentSearchResponse"] {
  const results = rows
    .map((r): S["SearchResult"] => ({
      symbol: str(r.symbol),
      name: str(r.name),
      type: "STOCK",
      exchange: "US",
      countryCode: "US",
      source: "SEC",
    }))
    .filter((r) => r.symbol !== undefined || r.name !== undefined)
  // Broad queries (single letters) match thousands of instruments in the SEC
  // universe — cap the payload so clients never render unbounded lists.
  return { count: Math.min(results.length, SEARCH_RESULT_LIMIT), results: results.slice(0, SEARCH_RESULT_LIMIT) }
}

export function toCryptoSearchResponse(rows: Array<Record<string, unknown>>): S["InstrumentSearchResponse"] {
  const results: S["SearchResult"][] = normalizeCryptoRows(rows).map(
    (r): S["SearchResult"] => ({
      symbol: r.symbol,
      name: r.name,
      type: "CRYPTO",
      exchange: "CRYPTO",
      countryCode: null,
      source: "CRYPTO",
    }),
  )
  return { count: Math.min(results.length, SEARCH_RESULT_LIMIT), results: results.slice(0, SEARCH_RESULT_LIMIT) }
}

export function toBondSearchResponse(rows: Array<Record<string, unknown>>): S["InstrumentSearchResponse"] {
  const results = rows.map(
    (r): S["SearchResult"] => ({
      symbol: str(r.symbol),
      name: str(r.name),
      type: "BOND",
      exchange: "PL",
      countryCode: "PL",
      source: "OBLIGACJE",
    }),
  )
  return { count: Math.min(results.length, SEARCH_RESULT_LIMIT), results: results.slice(0, SEARCH_RESULT_LIMIT) }
}

/** Fund-category search leg (§78): analizy.pl categories typed "FUND".
 *
 * Structurally identical to the bond leg, and for the same reason it exists:
 * savings bonds are absent from `ticker_reference` and are searchable only via
 * this kind of provider call. Fund categories are the mirror case — they *are*
 * synced into the table, but a category whose row the refresh has not caught up
 * with yet would otherwise be unfindable, so the leg is additive rather than
 * authoritative. `source` distinguishes the origin for the UI. */
export function toFundSearchResponse(rows: Array<Record<string, unknown>>): S["InstrumentSearchResponse"] {
  const results = rows.map(
    (r): S["SearchResult"] => ({
      symbol: str(r.symbol),
      name: str(r.name),
      type: "FUND",
      exchange: "PL",
      countryCode: "PL",
      source: "ANALIZY",
    }),
  )
  return { count: Math.min(results.length, SEARCH_RESULT_LIMIT), results: results.slice(0, SEARCH_RESULT_LIMIT) }
}

/** Merge per-tier search legs into one response, de-duplicating by symbol.
 * Equity/listed instruments win over crypto rows when a symbol collides. */
export function mergeSearchResults(
  ...groups: Array<S["SearchResult"][] | undefined>
): S["InstrumentSearchResponse"] {
  const seen = new Set<string>()
  const results: S["SearchResult"][] = []
  for (const group of groups) {
    for (const r of group ?? []) {
      if (!r.symbol || seen.has(r.symbol)) continue
      seen.add(r.symbol)
      results.push(r)
    }
  }
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

/** What the three statements are denominated in, and where each came from (§79.2).
 *
 *  `providerDeclared` is the currency the provider rows themselves carry
 *  (`reported_currency`), and only when ALL THREE statements declare the SAME one
 *  — a table whose income is in EUR and whose balance sheet is in USD has no
 *  single currency, and claiming one would be the exact defect this fixes. */
export interface FundamentalsProvenance {
  currency: string | null
  currencySource: S["CurrencySource"]
  sources: {
    incomeStatement: string | null
    balanceSheet: string | null
    cashFlow: string | null
  }
}

export function toFundamentals(
  income: Row[],
  balance: Row[],
  cash: Row[],
  provenance?: FundamentalsProvenance,
): S["FundamentalsData"] {
  const year = (r: Row): number | undefined => {
    const fy = num(pick(r, "fiscal_year", "calendar_year"))
    if (fy !== undefined) return fy
    const pe = str(pick(r, "period_ending", "date"))
    return pe ? Number(pe.slice(0, 4)) || undefined : undefined
  }

// -- §79.3 provider key vocabularies ------------------------------------
  //
  // There is no fixed statement schema to map onto. openbb's FMP models declare
  // typed fields, so FMP emits the same snake_case keys for every symbol, but
  // openbb's yfinance models declare only fiscal_period / fiscal_year /
  // period_ending — every line item is a passthrough extra whose name follows
  // yfinance, and that naming differs per listing. Measured 2026-10-02 against
  // openst on the live stack (statement=<x>&period=annual): AAPL, SAP.DE and
  // PKO.WA were ALL served by the yfinance passthrough, not FMP — FMP returns
  // 402 on every statement endpoint for a non-US symbol (§79.4). So the
  // candidates below are not an EU-only fallback; they are the main path.
  //
  // Two of them are NOT interchangeable and the order encodes which one wins,
  // because the column would otherwise mean different things per provider:
  //
  // - `totalLiabilities` prefers `total_liabilities_net_minority_interest`,
  //   because yfinance's bare `total_liabilities` is the excluding-minority
  //   figure on some listings and the including figure on others. The explicit
  //   name says which it is, and it is the one that reconciles with
  //   `total_assets` (SAP: 70,362 − 45,074 = 25,288).
  // - `shareholdersEquity` keeps FMP's semantics across every provider: FMP's
  //   `shareholders_equity` EXCLUDES non-controlling interests, so the EU
  //   candidates are ordered to exclude them too (`total_common_equity`,
  //   `common_stock_equity`) with the NCI-inclusive `total_equity` last
  //   (SAP: 45,074 − 488 = 44,586). Taking `total_equity` would silently change
  //   what `debtEquityRatio` means between a US row and an EU row.
  const netIncomeOf = (row: Row): number | undefined =>
    num(pick(row, "net_income", "bottom_line_net_income"))
  const revenueOf = (row: Row): number | undefined =>
    num(pick(row, "revenue", "total_revenue", "operating_revenue"))

  const incomeStatement = income.map((r, i) => {
    const revenue = revenueOf(r)
    const netIncome = netIncomeOf(r)
    return {
      year: year(r),
      revenue,
      // PKO.WA carries no EBIT or operating-income line on any provider, so this
      // stays blank there. Deriving it from revenue − operating expense would be
      // a different operation than reading a reported figure; §79.2 is about not
      // presenting numbers whose basis is unknown.
      ebit: num(pick(r, "ebit", "operating_income")),
      netIncome,
      netIncomeGrowth: growth(netIncome, netIncomeOf(income[i + 1] ?? {})),
      netIncomeMargin:
        netIncome !== undefined && revenue
          ? Math.round((netIncome / revenue) * 10000) / 100
          : undefined,
      earningsPerShare: num(pick(r, "diluted_earnings_per_share", "basic_earnings_per_share", "eps")),
      earningsPerShareGrowth: growth(
        num(pick(r, "diluted_earnings_per_share", "eps")),
        num(pick(income[i + 1] ?? {}, "diluted_earnings_per_share", "eps")),
      ),
      // `weighted_average_diluted_shares_outstanding` is yfinance's name and the
      // only one it emits; the FMP names are kept as fallbacks. This was empty
      // for every symbol before, which is what left freeCashFlowPerShare (§79.1)
      // with no denominator.
      dilutedSharesOutstanding: num(
        pick(
          r,
          "weighted_average_diluted_shares_outstanding",
          "diluted_average_shares",
          "weighted_average_shares_diluted",
        ),
      ),
      // Same for EBITDA: PKO.WA has no EBITDA line (only `normalized_income`),
      // so this one is a genuine provider gap, left blank on purpose.
      ebitda: num(r.ebitda),
    }
  })

  const balanceSheet = balance.map((r) => {
    const totalDebt = num(pick(r, "total_debt", "long_term_debt"))
    const shareholdersEquity = num(
      pick(
        r,
        "shareholders_equity",
        "stockholders_equity",
        "total_common_equity",
        "common_stock_equity",
        "total_equity",
      ),
    )
    const currentAssets = num(pick(r, "total_current_assets", "current_assets"))
    const currentLiabilities = num(pick(r, "total_current_liabilities", "current_liabilities"))
    return {
      year: year(r),
      totalAssets: num(r.total_assets),
      totalLiabilities: num(pick(r, "total_liabilities_net_minority_interest", "total_liabilities")),
      shareholdersEquity,
      // yfinance's "Cash And Cash Equivalents" is `cash_and_cash_equivalents`.
      // `cash_equivalents` is only the equivalents sub-line (SAP: 4,310 of
      // 8,220) and `cash_financial` is the wider aggregate (SAP: 3,910 — not
      // cash plus investments either), so both sit below the exact match.
      cash: num(
        pick(
          r,
          "cash_and_equivalents",
          "cash_n_equivalents",
          "cash_and_cash_equivalents",
          "cash_financial",
          "cash_equivalents",
        ),
      ),
      // `cash_cash_equivalents_and_short_term_investments` is yfinance's combined
      // line and is the one that reconciles (SAP: 8,220 + 1,552 = 9,772). The
      // plain-cash fallbacks stay because a lower bound beats a blank, and are
      // what an FMP row that omits the combined line already got.
      cashAndShortTermInvestments: num(
        pick(
          r,
          "cash_and_short_term_investments",
          "cash_cash_equivalents_and_short_term_investments",
          "cash_and_equivalents",
          "cash_and_cash_equivalents",
        ),
      ),
      totalDebt,
      netDebt: num(r.net_debt),
      // A provider-reported figure beats a subtraction, and where neither exists
      // the cell is deliberately blank: PKO.WA has no current-asset and no
      // current-liability line on any provider, so a number here would have to
      // be invented. A wrong working-capital figure is worse than a blank.
      workingCapital:
        num(pick(r, "working_capital")) ??
        (currentAssets !== undefined && currentLiabilities !== undefined
          ? currentAssets - currentLiabilities
          : undefined),
      retainedEarnings: num(r.retained_earnings),
      debtEquityRatio:
        totalDebt !== undefined && shareholdersEquity
          ? Math.round((totalDebt / shareholdersEquity) * 100) / 100
          : undefined,
    }
  })

  /** Free cash flow, as the provider reports it where it reports it.
   *
   *  §79.3 — the old `operating − capitalExpenditure` was a SIGN ERROR, not a
   *  naming gap: every provider in the chain reports capex as a negative
   *  outflow, so the subtraction added it back. AAPL FY2025 came out at
   *  124,197 against a true 98,767 — 26% overstated, on the one symbol whose
   *  numbers anyone checks. Verified 2026-10-02 that `operating − |capex|`
   *  reproduces the provider's own `free_cash_flow` exactly for all three
   *  symbols measured (AAPL 98,767 · SAP.DE 8,417 · PKO.WA 10,498), so the
   *  provider value is preferred and the corrected subtraction is the fallback
   *  for a provider that omits it. */
  const fcfOf = (row: Row): number | undefined => {
    const reported = num(pick(row, "free_cash_flow"))
    if (reported !== undefined) return reported
    const op = num(
      pick(row, "operating_cash_flow", "cash_flow_from_operating_activities", "net_cash_from_operating_activities"),
    )
    const capex = num(pick(row, "capital_expenditure", "capex"))
    return op !== undefined && capex !== undefined ? op - Math.abs(capex) : undefined
  }
  const opOf = (row: Row): number | undefined =>
    num(
      pick(row, "operating_cash_flow", "cash_flow_from_operating_activities", "net_cash_from_operating_activities"),
    )

  /** §79.1b — diluted shares by fiscal year, taken from the income statement.
   *
   *  A YEAR join, never a positional one. The three statements arrive from three
   *  independent provider calls with independent period coverage, so
   *  `income[i]` and `cash[i]` are not guaranteed to be the same fiscal year —
   *  measured 2026-10-02: SAP.DE serves 4 income rows and 5 cash rows. A
   *  positional zip would pair FY2024's cash flow with FY2025's share count
   *  and nothing downstream could tell, because both rows would still carry a
   *  plausible year. */
  const sharesByYear = new Map<number, number>()
  for (const row of incomeStatement) {
    if (row.year !== undefined && row.dilutedSharesOutstanding !== undefined) {
      sharesByYear.set(row.year, row.dilutedSharesOutstanding)
    }
  }

  const cashFlow = cash.map((r, i) => {
    const op = opOf(r)
    const capexRaw = num(pick(r, "capital_expenditure", "capex"))
    const fcf = fcfOf(r)
    const prevOp = opOf(cash[i + 1] ?? {})
    const prevFcf = fcfOf(cash[i + 1] ?? {})
    const fy = year(r)
    const shares = fy !== undefined ? sharesByYear.get(fy) : undefined
    return {
      year: fy,
      cashFlowFromOperatingActivities: op,
      cashFlowFromFinancingActivities: num(pick(r, "financing_cash_flow", "net_cash_from_financing_activities")),
      cashFlowFromInvestingActivities: num(pick(r, "investing_cash_flow", "net_cash_from_investing_activities")),
      freeCashFlow: fcf,
      freeCashFlowGrowth: growth(fcf, prevFcf),
      cashFlowFromOperatingActivitiesGrowth: growth(op, prevOp),
      // §79.1b — this column was declared in the contract and rendered by the
      // tab, and the mapper never emitted it, so against the real openst/cachest
      // stack it was permanently —. Guarded on a non-zero share count: an
      // undefined or zero denominator yields undefined, never NaN or Infinity,
      // because a blank cell is recoverable and NaN renders as "NaN".
      freeCashFlowPerShare:
        fcf !== undefined && shares !== undefined && shares !== 0 ? round(fcf / shares) : undefined,
      capitalExpenditures: capexRaw,
      depreciation: num(pick(r, "depreciation_and_amortization", "depreciation")),
      // yfinance's names: AAPL reports `common_dividends_paid`, the EU listings
      // `cash_dividends_paid` / `common_stock_dividend_paid` (SAP and PKO both
      // carry the latter two as the same figure). All are negative outflows and
      // are passed through unsign-flipped, like capitalExpenditures.
      dividendPayment: num(
        pick(
          r,
          "dividends_paid",
          "dividend_payment",
          "common_dividends_paid",
          "cash_dividends_paid",
          "common_stock_dividend_paid",
          "net_dividends_paid",
        ),
      ),
    }
  })

  // §79.2 — provenance is emitted alongside the numbers rather than inferred by
  // the reader. `undefined` (no provenance resolved) omits all three fields,
  // which is the contract's own answer for "we do not know".
  return {
    ...(provenance
      ? {
          currency: provenance.currency,
          currencySource: provenance.currencySource,
          sources: provenance.sources,
        }
      : {}),
    financialHighlights: { incomeStatement, balanceSheet, cashFlow },
  }
}

function quarterFromDate(date: string): number {
  const month = Number(date.slice(5, 7))
  return month >= 1 && month <= 12 ? Math.floor((month - 1) / 3) + 1 : 0
}

/** The currency every statement row in this walk declares, if they all agree.
 *
 *  §79.2 — `reported_currency` is FMP's declaration; the yfinance passthrough
 *  carries none (measured 2026-10-02: present on the AAPL row, absent on both
 *  SAP.DE and PKO.WA). A statement with no declaration is not evidence against
 *  the others, it is just silent, so only a real DISAGREEMENT suppresses the
 *  currency; otherwise the caller falls through to the local resolver. */
export function declaredStatementCurrency(rows: Row[]): string | null {
  const declared = new Set<string>()
  for (const r of rows) {
    const c = str(pick(r, "reported_currency"))
    if (c) declared.add(c.toUpperCase())
    if (declared.size > 1) return null
  }
  return declared.size === 1 ? [...declared][0] : null
}

export function toCalendar(
  symbol: string,
  earningsRows: Row[],
  dividendRows: Row[],
  currency: string,
): S["CalendarData"] {
  const sym = symbol.toUpperCase()
  // §52 follow-up — biznesradar calendar rows carry bare GPW tickers ("MBR")
  // while the route symbol is venue-qualified ("MBR.WA"); match the bare
  // ticker as a fallback for venue-qualified route symbols.
  const bare = sym.includes(".") ? sym.slice(0, sym.lastIndexOf(".")) : sym
  const matches = (rowSymbol: string | undefined) => {
    const s = rowSymbol?.toUpperCase()
    return s === sym || s === bare
  }
  const earnings = earningsRows
    .filter((r) => matches(str(r.symbol)) && str(r.report_date))
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
    .filter((r) => matches(str(r.symbol)) && str(r.ex_dividend_date))
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

  // §49.9 — payment dates ride on the same calendar rows that carry the
  // ex-dividend date; a row may feed both arrays (ex-date + pay-date).
  const dividend = dividendRows
    .filter((r) => matches(str(r.symbol)) && str(r.payment_date))
    .map((r) => {
      const date = str(r.payment_date)!
      const amount = num(r.amount)
      return {
        date,
        title: "Dividend Payment",
        year: Number(date.slice(0, 4)),
        amount: amount ?? undefined,
      }
    })
    .sort((a, b) => a.date.localeCompare(b.date))

  return { earnings, exDividend, dividend, currency }
}

export function toDividends(
  rows: Row[],
  resolution: CurrencyResolution = { currency: "USD", currencySource: "unknown" },
): S["DividendsData"] {
  type DividendRow = {
    date: string
    year: number
    amount: number
    currency: string
    type: string
    paymentDate: string | null
  }
  // §49.6 — the contract requires a non-null currency, so an unresolved one is
  // filled with the named placeholder and `currencySource` is set to "unknown"
  // (via sourceFor) so the consumer can see it was not resolved. §66.4: this used
  // to be an inline "USD" that read as a real answer.
  const fallback = resolution.currency ?? UNRESOLVED_CURRENCY
  if (!resolution?.currency) {
    console.warn(`[translate] unresolved currency for a research payload; reporting ${UNRESOLVED_CURRENCY} with currencySource=unknown`)
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
        currency: str(r.currency) ?? fallback,
        type: str(r.type) ?? "regular",
        paymentDate: str(r.payment_date) ?? null,
      }
      return row
    })
    .filter((r): r is DividendRow => r !== null)
  return { history, currency: fallback, currencySource: resolution.currencySource }
}

type ProjectionsResult = S["ProjectionsData"]

export function toProjections(
  symbol: string,
  consensus: OpenstConsensus | undefined,
  quote: OpenstQuote | undefined,
  quarterly: EpsQuarter[] = [],
): ProjectionsResult {
  const current = quote?.last_price !== undefined ? num(quote.last_price) : num(quote?.current_price)
  const currency = str(quote?.currency) ?? UNRESOLVED_CURRENCY
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
    // §61.4 — the provider carries neither, and the pure translator has no
    // reference table. Emitted as explicit nulls so the response shape is
    // stable and "no reference row" reads as unknown rather than absent.
    countryCode: null,
    assetType: null,
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
    currency: str(profile.currency) ?? UNRESOLVED_CURRENCY,
  }
}

export function toHistoricalPrice(
  symbol: string,
  date: string,
  rows: OpenstOhlcvRow[],
  currencyFallback: string,
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

/** SEC report forms surfaced as IR events — exclude insider-trade Form 4/5,
 * 144, etc. that would drown the investor-relations list. */
const IR_REPORT_FORMS = new Set(["10-K", "10-Q", "8-K", "20-F", "6-K"])

/** Normalise a raw SEC filing row into the docs needed for an IR event. Filings
 * arrive as OpenBB `company_filings` records shaped like
 * `{ symbol, form_type, filing_date, report_date, report_url, accession_number }`. */
function secFilingEvent(sym: string, f: Row): S["InvestorRelationEvent"] | undefined {
  const formType = (str(f.form_type) ?? str(f.report_type) ?? "").toUpperCase()
  if (!IR_REPORT_FORMS.has(formType)) return undefined
  let date = (str(f.filing_date) ?? str(f.report_date) ?? "").slice(0, 10)
  if (!date) date = (str(f.report_date) ?? "").slice(0, 10)
  if (!date) return undefined
  const yearNum = Number(date.slice(0, 4))
  const year = Number.isFinite(yearNum) && yearNum > 0 ? yearNum : undefined
  const month = date.slice(5, 7)
  const quarter = month ? Math.ceil(Number(month) / 3) : null
  const accn = str(f.accession_number) ?? ""
  const reportUrl = str(f.report_url) ?? str(f.document_url) ?? str(f.filing_url)
  return {
    type: "press-release",
    id: `${sym}_${formType}_${accn || date}`,
    title: `${sym} - SEC Form ${formType} (filed ${date})`,
    date: `${date} 00:00:00`,
    year,
    quarter,
    symbol: sym,
    audioUrl: null,
    reportUrl: reportUrl ?? null,
    formType,
  }
}

/** IR events derived from real reported quarters blended with SEC filings
 * (10-K/10-Q/8-K) exposed via cachest. Earnings-call events carry no audioUrl
 * (no audio transcript provider in the tier); SEC filing events carry the
 * report URL + form type. */
export function toInvestorRelations(
  symbol: string,
  quarters: EpsQuarter[],
  filings?: Row[] | null,
): Array<S["InvestorRelationEvent"]> {
  const sym = symbol.toUpperCase()
  const callEvents = [...quarters]
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
        reportUrl: null,
        formType: null,
      }
    })
  const secEvents = (filings ?? [])
    .map((f) => secFilingEvent(sym, f))
    .filter((e): e is S["InvestorRelationEvent"] => Boolean(e))
    .sort((a, b) => String(b.date).localeCompare(String(a.date)))
  return [...secEvents, ...callEvents].sort((a, b) => String(b.date).localeCompare(String(a.date))).slice(0, 48)
}

type IrTranscriptResult = S["IRTranscript"]

export function toIrTranscript(
  eventId: string,
  symbol: string,
  mda?: Row | null,
): IrTranscriptResult {
  const sym = symbol.toUpperCase()
  // Earnings-call ids look like `${SYM}_YYYY-MM-DD`; SEC filing ids look like
  // `${SYM}_FORM_<accession>` where no year is encoded. Only parse the former,
  // otherwise fall back to the MD&A record's calendar year/period.
  const m = eventId.match(/_(\d{4})-(\d{2})-\d{2}/)
  const year = m ? Number(m[1]) : _safeYear(mda?.calendar_year)
  const quarter = m ? Math.ceil(Number(m[2]) / 3) : (_safeQuarter(mda?.calendar_period) ?? null)
  const bodyText = str(mda?.content)
  return {
    id: eventId,
    symbol: sym,
    year,
    quarter,
    title: bodyText
      ? `${sym} - Management Discussion & Analysis`
      : `${sym} - Earnings call Q${quarter ?? "-"} ${year ?? ""}`.replace(/\s+/g, " ").trim(),
    time: str(mda?.period_ending) ?? null,
    participant: [],
    audio: null,
    transcript: [],
    body: bodyText ?? null,
  }
}

/** DB news row → SPA/Mock-compatible NewsArticle list item.
 * Rows come straight off `news_articles` (stock-news.md N4/N5); the contract
 * keeps items opaque, but the SPA consumes the mock's shape, so we reproduce
 * it: `id`, `type`, `ticker`, `article.{title,url,source,description,published_at}`
 * and a top-level `published_at`. */
export function toNewsArticleItem(
  row: { url: string; title: string; summary: string | null; source: string | null; publishedAt: Date; symbols: string[] },
  fallbackTicker?: string,
): Record<string, unknown> {
  const publishedAt = row.publishedAt.toISOString()
  // The REQUESTED ticker, not `symbols[0]`. `news_articles.symbols` is a text[]
  // because one article can cover several companies, and `getNewsForTicker`
  // filters with `arrayContains(symbols, [ticker])` — so every row we return is
  // guaranteed to contain the ticker that was asked for. `symbols[0]` is just
  // whichever company happened to be listed first.
  //
  // This was a real PROD bug, and it was invisible from the data: the portfolio
  // news tab asks for each held symbol in turn, gets back articles that contain
  // it, and then labels every one of them with `symbols[0]`. For a portfolio
  // holding NVDA that meant cards captioned MSFT / AAPL / META — names the
  // portfolio does not own. TickerBadge then enriched from open positions, found
  // no match, and degraded to a bare symbol: 37 of 50 cards, which read as
  // "mostly missing data" and got blamed on the badge's enrichment source. The
  // badge was fine. `PortfolioNewsTab.vue`'s comment that an unheld ticker is
  // "rare" was measuring its own bug.
  const ticker = fallbackTicker ?? row.symbols[0]
  return {
    id: row.url,
    type: "article",
    ...(ticker ? { ticker } : {}),
    metadata: row.source ? { source: row.source } : undefined,
    article: {
      title: row.title,
      url: row.url,
      source: row.source ?? undefined,
      description: row.summary ?? undefined,
      published_at: publishedAt,
    },
    published_at: publishedAt,
  }
}

/** `news_articles` rows → contract `NewsArticleList` ({data, pagination}).
 * Single page for now (no keyset cursor): count == data length, cursors null. */
export function toNewsArticleList(
  rows: Array<{ url: string; title: string; summary: string | null; source: string | null; publishedAt: Date; symbols: string[] }>,
  fallbackTicker?: string,
): S["NewsArticleList"] {
  const data = rows.map((r) => toNewsArticleItem(r, fallbackTicker))
  return {
    data,
    pagination: {
      count: data.length,
      total_count: data.length,
      has_next_page: false,
      has_previous_page: false,
      next_cursor: null,
      previous_cursor: null,
    },
  }
}

/** Normalise SEC Form 4 insider rows into the contract's ownership payload.
 * OpenBB `insider_trading` records carry per-transaction fields (owner, dates,
 * code, shares, price); aggregated holder groups (institutional / mutual-fund /
 * insider 13F) have no source in this tier yet, so those stay empty arrays. */
type OwnershipItem = NonNullable<S["OwnershipData"]["insiderTransactions"]>[number]

export function toOwnershipData(symbol: string, insiderRows?: Row[] | null): S["OwnershipData"] {
  const insiderTransactions = (insiderRows ?? [])
    .map((r): OwnershipItem | undefined => {
      const date = (str(r.transaction_date) ?? str(r.filing_date) ?? "").slice(0, 10)
      if (!date) return undefined
      const amount = num(r.securities_transacted)
      const price = num(r.transaction_price)
      const owner = str(r.owner_name)
      const code = str(r.acquisition_or_disposition) ?? str(r.transaction_code)
      const text = str(r.transaction_type) ?? str(r.security_type)
      if (!owner && !code && !text && amount === undefined) return undefined
      const value = amount !== undefined && price !== undefined ? round(amount * price, 2) : undefined
      return {
        title: owner ?? text ?? "Insider",
        transactionDate: date,
        transactionCode: code,
        transactionText: text,
        transactionAmount: amount,
        transactionValue: value,
        filingDate: (str(r.filing_date) ?? "").slice(0, 10) || undefined,
      }
    })
    .filter((t): t is OwnershipItem => Boolean(t))
    .sort((a, b) => String(b.transactionDate).localeCompare(String(a.transactionDate)))
  return { institutional: [], mutualFund: [], insider: [], insiderTransactions }
}
