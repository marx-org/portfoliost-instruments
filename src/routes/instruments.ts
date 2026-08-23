import { Hono } from "hono"
import { z } from "zod"
import { openApi } from "hono-zod-openapi"
import { userIdentityMiddleware } from "../auth.js"
import { getDb } from "../db/index.js"
import { searchTickerReference } from "../db/tickerref-queries.js"
import {
  fetchProfile,
  fetchQuote,
  fetchMetrics,
  fetchProjections,
  fetchOhlcv,
  fetchFundamentals,
  fetchCalendarEarnings,
  fetchCalendarDividends,
  fetchSearch,
  fetchDividendHistory,
} from "../adapters/cachest.js"
import { UpstreamError } from "../adapters/cachest.js"
import {
  toInstrumentDetail,
  toInstrumentProfile,
  toQuote,
  toPriceHistory,
  toInstrumentMetrics,
  toOverviewMetrics,
  toSearchResponse,
  toReferenceSearchResponse,
  toFundamentals,
  toCalendar,
  toDividends,
  toProjections,
  toCompare,
  toHistoricalPrice,
  toSeasonality,
  toEpsSurprises,
  toInvestorRelations,
  toIrTranscript,
  str,
  type Row,
} from "../adapters/translate.js"
import type { OpenstProfile, OpenstQuote, OpenstOhlcvRow, OpenstConsensus } from "../adapters/openst-types.js"
import {
  ErrorResponseSchema,
  InstrumentSearchResponseSchema,
  InstrumentDetailSchema,
  InstrumentProfileSchema,
  QuoteSchema,
  PriceHistorySchema,
  InstrumentMetricsSchema,
  InstrumentOverviewMetricsSchema,
} from "../schemas/instruments.js"

const UNAUTHORIZED = {
  description: "Unauthorized",
  content: { "application/json": { schema: ErrorResponseSchema } },
} as const

const UPSTREAM_ERROR = {
  description: "Upstream provider error",
  content: { "application/json": { schema: ErrorResponseSchema } },
} as const

function todayRange(days = 365): { start: string; end: string } {
  const end = new Date()
  const start = new Date(end.getTime() - days * 86400_000)
  const fmt = (d: Date) => d.toISOString().slice(0, 10)
  return { start: fmt(start), end: fmt(end) }
}

function dateRange(date: string, days = 30): { start: string; end: string } {
  const end = new Date(`${date}T00:00:00Z`)
  const start = new Date(end.getTime() - days * 86400_000)
  const fmt = (d: Date) => d.toISOString().slice(0, 10)
  return { start: fmt(start), end: date }
}

function upstreamErrorResponse(c: any, e: unknown) {
  if (e instanceof UpstreamError) {
    const status = e.status === 404 ? 404 : 502
    return c.json({ error: status === 404 ? "NotFound" : "BadGateway", message: e.message }, status as any)
  }
  return c.json({ error: "BadGateway", message: String(e) }, 502 as any)
}

export function createInstrumentsRoutes() {
  const instruments = new Hono()
  instruments.use("*", userIdentityMiddleware)


  instruments.get(
    "/search",
    openApi({
      tags: ["Instruments"],
      summary: "Search instruments",
      operationId: "searchInstruments",
      responses: {
        200: {
          description: "Search results",
          content: { "application/json": { schema: InstrumentSearchResponseSchema } },
        },
        401: UNAUTHORIZED,
        502: UPSTREAM_ERROR,
      },
    }),
    async (c) => {
      const q = (c.req.query("q") ?? c.req.query("query") ?? "").trim()
      if (!q) return c.json({ count: 0, results: [] })

      // Primary source: local ticker reference table (synced from
      // adanos/free-ticker-database). Falls back to the provider tier when
      // the table is empty or unavailable (e.g. pre-seed environments).
      try {
        const rows = await searchTickerReference(getDb(), q)
        if (rows.length > 0) {
          return c.json(
            toReferenceSearchResponse(rows),
          )
        }
      } catch {
        /* reference table unavailable — use the provider tier */
      }

      try {
        const rows = await fetchSearch(q)
        return c.json(toSearchResponse(rows))
      } catch (e) {
        return upstreamErrorResponse(c, e)
      }
    },
  )

  instruments.get(
    "/:symbol",
    openApi({
      tags: ["Instruments"],
      summary: "Get instrument detail",
      operationId: "getInstrumentDetail",
      responses: {
        200: {
          description: "Instrument detail",
          content: { "application/json": { schema: InstrumentDetailSchema } },
        },
        401: UNAUTHORIZED,
        502: UPSTREAM_ERROR,
      },
    }),
    async (c) => {
      const symbol = c.req.param("symbol").toUpperCase()
      try {
        const profile = (await fetchProfile(symbol)) as OpenstProfile
        return c.json(toInstrumentDetail(symbol, profile))
      } catch (e) {
        return upstreamErrorResponse(c, e)
      }
    },
  )

  instruments.get(
    "/:symbol/profile",
    openApi({
      tags: ["Instruments"],
      summary: "Get instrument profile",
      operationId: "getInstrumentProfile",
      responses: {
        200: {
          description: "Instrument profile",
          content: { "application/json": { schema: InstrumentProfileSchema } },
        },
        401: UNAUTHORIZED,
        502: UPSTREAM_ERROR,
      },
    }),
    async (c) => {
      const symbol = c.req.param("symbol").toUpperCase()
      try {
        const profile = (await fetchProfile(symbol)) as OpenstProfile
        return c.json(toInstrumentProfile(symbol, profile))
      } catch (e) {
        return upstreamErrorResponse(c, e)
      }
    },
  )

  instruments.get(
    "/:symbol/metrics",
    openApi({
      tags: ["Instruments"],
      summary: "Get instrument metrics",
      operationId: "getInstrumentMetrics",
      responses: {
        200: {
          description: "Instrument metrics",
          content: { "application/json": { schema: InstrumentMetricsSchema } },
        },
        401: UNAUTHORIZED,
        502: UPSTREAM_ERROR,
      },
    }),
    async (c) => {
      const symbol = c.req.param("symbol").toUpperCase()
      try {
        const metrics = await fetchMetrics(symbol)
        let consensus: OpenstConsensus | undefined
        try {
          consensus = (await fetchProjections(symbol)) as OpenstConsensus
        } catch {
          consensus = undefined
        }
        return c.json(toInstrumentMetrics(symbol, metrics, consensus))
      } catch (e) {
        return upstreamErrorResponse(c, e)
      }
    },
  )

  instruments.get(
    "/:symbol/overview-metrics",
    openApi({
      tags: ["Instruments"],
      summary: "Get overview metrics",
      operationId: "getInstrumentOverviewMetrics",
      responses: {
        200: {
          description: "Overview metrics",
          content: { "application/json": { schema: InstrumentOverviewMetricsSchema } },
        },
        401: UNAUTHORIZED,
        502: UPSTREAM_ERROR,
      },
    }),
    async (c) => {
      const symbol = c.req.param("symbol").toUpperCase()
      try {
        const metrics = await fetchMetrics(symbol)
        let profile: OpenstProfile | undefined
        try {
          profile = (await fetchProfile(symbol)) as OpenstProfile
        } catch {
          profile = undefined
        }
        return c.json(toOverviewMetrics(symbol, metrics, profile))
      } catch (e) {
        return upstreamErrorResponse(c, e)
      }
    },
  )

  instruments.get(
    "/:symbol/quote",
    openApi({
      tags: ["Instruments"],
      summary: "Get quote",
      operationId: "getQuote",
      responses: {
        200: {
          description: "Quote",
          content: { "application/json": { schema: QuoteSchema } },
        },
        401: UNAUTHORIZED,
        502: UPSTREAM_ERROR,
      },
    }),
    async (c) => {
      const symbol = c.req.param("symbol").toUpperCase()
      try {
        const q = (await fetchQuote(symbol)) as OpenstQuote
        return c.json(toQuote({ symbol, ...q }))
      } catch (e) {
        return upstreamErrorResponse(c, e)
      }
    },
  )

  instruments.get(
    "/:symbol/history",
    openApi({
      tags: ["Instruments"],
      summary: "Get price history",
      operationId: "getHistory",
      responses: {
        200: {
          description: "Price history",
          content: { "application/json": { schema: PriceHistorySchema } },
        },
        401: UNAUTHORIZED,
        502: UPSTREAM_ERROR,
      },
    }),
    async (c) => {
      const symbol = c.req.param("symbol").toUpperCase()
      const resolutionParam = c.req.query("resolution") === "monthly" ? "monthly" : "daily"
      const compareParam = c.req.query("compare")
      try {
        // Serve deep history so client-side timeframe slicing (3Y/5Y/10Y/MAX)
        // has data: 11 years of daily bars, 20 years of monthly bars.
        const { start, end } = resolutionParam === "monthly" ? todayRange(7300) : todayRange(4018)
        const rows = (await fetchOhlcv(symbol, start, end)) as unknown as OpenstOhlcvRow[]
        const history = toPriceHistory(rows, resolutionParam)

        // Benchmarks are liquid ETF proxies fetched over the same window and
        // aligned to the symbol's trading days (carry-forward on gaps).
        const BENCHMARKS: Record<string, { etf: string; name: string }> = {
          spy: { etf: "SPY", name: "S&P 500 (SPY)" },
          qqq: { etf: "QQQ", name: "Invesco QQQ" },
          iwm: { etf: "IWM", name: "iShares Russell 2000" },
        }
        const bench = compareParam && BENCHMARKS[compareParam.toLowerCase()] ? BENCHMARKS[compareParam.toLowerCase()] : null
        let compare: Record<string, unknown> | undefined
        if (bench && resolutionParam === "daily" && (history.timestamps as number[]).length) {
          try {
            const benchRows = (await fetchOhlcv(bench.etf, start, end)) as unknown as OpenstOhlcvRow[]
            const byDate = new Map(benchRows.map((r) => [r.date, Number(r.close)]))
            let last: number | null = null
            const closePrices = (history.timestamps as number[]).map((ts) => {
              const date = new Date(ts * 1000).toISOString().slice(0, 10)
              const v = byDate.get(date)
              if (v !== undefined && Number.isFinite(v) && v > 0) last = v
              return last ?? 0
            })
            compare = { name: bench.name, closePrices, timestamps: history.timestamps }
          } catch {
            compare = undefined
          }
        }
        return c.json({ ...history, symbol, ...(compare ? { compare } : {}) })
      } catch (e) {
        return upstreamErrorResponse(c, e)
      }
    },
  )

  instruments.get(
    "/:symbol/price",
    openApi({
      tags: ["Instruments"],
      summary: "Get current price for a symbol",
      operationId: "getSymbolPrice",
      responses: {
        200: {
          description: "Current price",
          content: {
            "application/json": {
              schema: z.object({ symbol: z.string(), price: z.number(), currency: z.string().optional() }),
            },
          },
        },
        401: UNAUTHORIZED,
        502: UPSTREAM_ERROR,
      },
    }),
    async (c) => {
      const symbol = c.req.param("symbol").toUpperCase()
      const date = c.req.query("date")
      try {
        if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
          return c.json({ error: "BadRequest", message: "date must be YYYY-MM-DD" }, 400)
        }
        if (date) {
          const { start, end } = dateRange(date)
          const rows = (await fetchOhlcv(symbol, start, end)) as unknown as OpenstOhlcvRow[]
          const last = rows[rows.length - 1]
          if (!last) {
            return c.json({ error: "NotFound", message: `No price found for ${symbol} on or before ${date}` }, 404)
          }
          return c.json({ symbol, price: Number(last.close), currency: null, date: last.date })
        }
        const q = (await fetchQuote(symbol)) as OpenstQuote
        return c.json({ symbol, price: Number(q.last_price ?? 0), currency: q.currency ?? "USD" })
      } catch (e) {
        return upstreamErrorResponse(c, e)
      }
    },
  )

  registerPt2Routes(instruments)
  instruments.get(
    "/:symbol/ownership",
    openApi({
      tags: ["Instruments"],
      summary: "Ownership (empty until a provider covers it — FMP premium)",
      operationId: "getOwnership",
      responses: {
        200: { description: "Ownership", content: { "application/json": { schema: z.looseObject({}) } } },
        401: UNAUTHORIZED,
      },
    }),
    async (c) => {
      const symbol = c.req.param("symbol").toUpperCase()
      return c.json({ symbol, institutional: [], mutualFund: [], insider: [], insiderTransactions: [] })
    },
  )
  return instruments
}

// The route factories below are appended via createInstrumentsRoutes extension:
export function registerPt2Routes(instruments: Hono) {
  instruments.get(
    "/:symbol/fundamentals",
    openApi({
      tags: ["Instruments"],
      summary: "Get fundamentals",
      operationId: "getFundamentals",
      responses: {
        200: {
          description: "Fundamentals data",
          content: { "application/json": { schema: z.looseObject({ financialHighlights: z.unknown() }) } },
        },
        401: UNAUTHORIZED,
        502: UPSTREAM_ERROR,
      },
    }),
    async (c) => {
      const symbol = c.req.param("symbol").toUpperCase()
      try {
        const [income, balance, cash] = await Promise.all([
          fetchFundamentals(symbol, "income", "annual"),
          fetchFundamentals(symbol, "balance", "annual"),
          fetchFundamentals(symbol, "cash", "annual"),
        ])
        return c.json(toFundamentals(income as any[], balance as any[], cash as any[]))
      } catch (e) {
        return upstreamErrorResponse(c, e)
      }
    },
  )

  instruments.get(
    "/:symbol/calendar",
    openApi({
      tags: ["Instruments"],
      summary: "Get earnings and dividend calendar for a symbol",
      operationId: "getInstrumentCalendar",
      responses: {
        200: {
          description: "Calendar entries near today",
          content: { "application/json": { schema: z.looseObject({ earnings: z.array(z.unknown()).optional(), exDividend: z.array(z.unknown()).optional() }) } },
        },
        401: UNAUTHORIZED,
        502: UPSTREAM_ERROR,
      },
    }),
    async (c) => {
      const symbol = c.req.param("symbol").toUpperCase()
      const { start, end } = todayRange(45)
      // A missing calendar window (upstream 404) degrades to empty lists.
      const orEmpty = async (p: Promise<unknown>) => {
        try {
          return await p
        } catch (e) {
          if (e instanceof UpstreamError && e.status === 404) return []
          throw e
        }
      }
      try {
        const [earningsRows, dividendRows] = await Promise.all([
          orEmpty(fetchCalendarEarnings(start, end)),
          orEmpty(fetchCalendarDividends(start, end)),
        ])
        return c.json(toCalendar(symbol, earningsRows as any[], dividendRows as any[]))
      } catch (e) {
        return upstreamErrorResponse(c, e)
      }
    },
  )

  instruments.get(
    "/:symbol/dividends",
    openApi({
      tags: ["Instruments"],
      summary: "Get dividend history",
      operationId: "getDividends",
      responses: {
        200: {
          description: "Dividend history",
          content: { "application/json": { schema: z.looseObject({ history: z.array(z.unknown()).optional() }) } },
        },
        401: UNAUTHORIZED,
        502: UPSTREAM_ERROR,
      },
    }),
    async (c) => {
      const symbol = c.req.param("symbol").toUpperCase()
      try {
        const rows = await fetchDividendHistory(symbol)
        return c.json(toDividends(rows as any[]))
      } catch (e) {
        return upstreamErrorResponse(c, e)
      }
    },
  )

  instruments.get(
    "/:symbol/projections",
    openApi({
      tags: ["Instruments"],
      summary: "Analyst projections and price targets",
      operationId: "getProjections",
      responses: {
        200: {
          description: "Projections data",
          content: { "application/json": { schema: z.looseObject({ priceTarget: z.unknown().optional() }) } },
        },
        401: UNAUTHORIZED,
        502: UPSTREAM_ERROR,
      },
    }),
    async (c) => {
      const symbol = c.req.param("symbol").toUpperCase()
      try {
        let consensus: Record<string, unknown> | undefined
        try {
          consensus = await fetchProjections(symbol)
        } catch {
          consensus = undefined
        }
        let quote: Record<string, unknown> | undefined
        try {
          quote = await fetchQuote(symbol)
        } catch {
          quote = undefined
        }
        // Baseline for the earnings/revenue estimate blocks: real reported
        // quarters (analyst forward estimates are FMP-premium).
        let quarterly: any[] = []
        try {
          quarterly = (await fetchFundamentals(symbol, "income", "quarter")) as any[]
        } catch {
          quarterly = []
        }
        return c.json(toProjections(symbol, consensus as any, quote as any, quarterly))
      } catch (e) {
        return upstreamErrorResponse(c, e)
      }
    },
  )

  instruments.get(
    "/:symbol/compare",
    openApi({
      tags: ["Instruments"],
      summary: "Comparable metrics snapshot for a symbol",
      operationId: "getCompare",
      responses: {
        200: {
          description: "Comparison snapshot",
          content: { "application/json": { schema: z.looseObject({}) } },
        },
        401: UNAUTHORIZED,
        502: UPSTREAM_ERROR,
      },
    }),
    async (c) => {
      const symbol = c.req.param("symbol").toUpperCase()
      try {
        const [profile, quote, metrics] = await Promise.all([
          fetchProfile(symbol),
          fetchQuote(symbol).catch(() => undefined),
          fetchMetrics(symbol),
        ])
        return c.json(toCompare(profile as any, quote as any, metrics))
      } catch (e) {
        return upstreamErrorResponse(c, e)
      }
    },
  )

  instruments.get(
    "/:symbol/price",
    openApi({
      tags: ["Instruments"],
      summary: "Historical price for a specific date",
      operationId: "getHistoricalPriceRoute",
      responses: {
        200: {
          description: "Historical price",
          content: { "application/json": { schema: z.looseObject({ symbol: z.string().optional(), date: z.string().optional(), price: z.number().nullish(), currency: z.string().optional() }) } },
        },
        400: UNAUTHORIZED,
        401: UNAUTHORIZED,
        502: UPSTREAM_ERROR,
      },
    }),
    async (c) => {
      const symbol = c.req.param("symbol").toUpperCase()
      const date = c.req.query("date")
      if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        return c.json({ error: "BadRequest", message: "date query parameter must be YYYY-MM-DD" }, 400 as any)
      }
      const startD = new Date(Date.parse(date + "T00:00:00Z") - 10 * 86400_000)
      const { start, end } = { start: startD.toISOString().slice(0, 10), end: date }
      try {
        const rows = (await fetchOhlcv(symbol, start, end)) as unknown as OpenstOhlcvRow[]
        return c.json(toHistoricalPrice(symbol, date, rows))
      } catch (e) {
        return upstreamErrorResponse(c, e)
      }
    },
  )

  instruments.get(
    "/:symbol/seasonality",
    openApi({
      tags: ["Instruments"],
      summary: "Average monthly returns over a lookback window",
      operationId: "getSeasonality",
      responses: {
        200: { description: "Seasonality", content: { "application/json": { schema: z.looseObject({}) } } },
        401: UNAUTHORIZED,
        502: UPSTREAM_ERROR,
      },
    }),
    async (c) => {
      const symbol = c.req.param("symbol").toUpperCase()
      const years = [3, 5, 10, 20].includes(Number(c.req.query("years"))) ? Number(c.req.query("years")) : 5
      const metricParam = c.req.query("metric")
      const metric = ["avg", "median", "min", "max"].includes(metricParam ?? "")
        ? (metricParam as "avg" | "median" | "min" | "max")
        : "avg"
      const start = new Date(Date.now() - (years + 1) * 365 * 86400_000).toISOString().slice(0, 10)
      const end = new Date().toISOString().slice(0, 10)
      try {
        const rows = (await fetchOhlcv(symbol, start, end)) as unknown as OpenstOhlcvRow[]
        return c.json(toSeasonality(symbol, years, metric, rows))
      } catch (e) {
        return upstreamErrorResponse(c, e)
      }
    },
  )

  instruments.get(
    "/:symbol/eps-surprises",
    openApi({
      tags: ["Instruments"],
      summary: "EPS surprise history derived from quarterly statements",
      operationId: "getEpsSurprises",
      responses: {
        200: { description: "EPS surprises", content: { "application/json": { schema: z.looseObject({}) } } },
        401: UNAUTHORIZED,
        502: UPSTREAM_ERROR,
      },
    }),
    async (c) => {
      const symbol = c.req.param("symbol").toUpperCase()
      const quartersParam = Number(c.req.query("quarters"))
      const quarters = [5, 8, 12].includes(quartersParam) ? quartersParam : 8
      try {
        const rows = await fetchFundamentals(symbol, "income", "quarter")
        const all = toEpsSurprises(symbol, rows)
        return c.json({ ...all, quarterly: (all.quarterly as unknown[]).slice(-quarters) })
      } catch (e) {
        return upstreamErrorResponse(c, e)
      }
    },
  )

  instruments.get(
    "/:symbol/investor-relations",
    openApi({
      tags: ["Instruments"],
      summary: "IR events derived from reported quarters",
      operationId: "getInvestorRelations",
      responses: {
        200: { description: "Events", content: { "application/json": { schema: z.array(z.looseObject({})) } } },
        401: UNAUTHORIZED,
        502: UPSTREAM_ERROR,
      },
    }),
    async (c) => {
      const symbol = c.req.param("symbol").toUpperCase()
      try {
        const rows = await fetchFundamentals(symbol, "income", "quarter")
        return c.json(toInvestorRelations(symbol, rows))
      } catch (e) {
        return upstreamErrorResponse(c, e)
      }
    },
  )

  instruments.get(
    "/:symbol/investor-relations/:eventId/transcript",
    openApi({
      tags: ["Instruments"],
      summary: "Transcript placeholder for an IR event (no provider in tier)",
      operationId: "getIrTranscript",
      responses: {
        200: { description: "Transcript", content: { "application/json": { schema: z.looseObject({}) } } },
        401: UNAUTHORIZED,
      },
    }),
    async (c) => {
      const symbol = c.req.param("symbol").toUpperCase()
      const eventId = c.req.param("eventId")
      return c.json(toIrTranscript(eventId, symbol))
    },
  )

  instruments.get(
    "/:symbol/peers",
    openApi({
      tags: ["Instruments"],
      summary: "Same-sector peers composed into compare rows",
      operationId: "getPeers",
      responses: {
        200: { description: "Peers", content: { "application/json": { schema: z.looseObject({}) } } },
        401: UNAUTHORIZED,
        502: UPSTREAM_ERROR,
      },
    }),
    async (c) => {
      const symbol = c.req.param("symbol").toUpperCase()
      try {
        const profile = (await fetchProfile(symbol)) as OpenstProfile
        // Curated liquid large-cap candidate universe; peers are filtered by
        // live sector data from the provider tier.
        const candidates = PEER_UNIVERSE.filter((s) => s !== symbol).slice(0, 24)
        const profiles = await Promise.all(
          candidates.map(async (s) => {
            try {
              return { s, p: (await fetchProfile(s)) as OpenstProfile }
            } catch {
              return null
            }
          }),
        )
        const sector = str(profile.sector ?? profile.sector_long)
        const peerSymbols = profiles
          .filter((x): x is { s: string; p: OpenstProfile } =>
            Boolean(x && sector && str(x.p.sector ?? x.p.sector_long) === sector),
          )
          .slice(0, 4)
          .map((x) => x.s)
        const items = await Promise.all(
          [symbol, ...peerSymbols].map(async (sym) => {
            const prof = sym === symbol ? profile : ((await fetchProfile(sym)) as OpenstProfile)
            let quote: OpenstQuote | undefined
            let metrics: Row = {}
            try {
              quote = (await fetchQuote(sym)) as OpenstQuote
            } catch {
              /* price/metrics optional for peers */
            }
            try {
              metrics = (await fetchMetrics(sym)) as Row
            } catch {
              /* optional */
            }
            return toCompare(prof, quote, metrics)
          }),
        )
        return c.json({ symbol, items })
      } catch (e) {
        return upstreamErrorResponse(c, e)
      }
    },
  )
}

// Liquid US large caps spanning major sectors used as the peer-candidate pool.
const PEER_UNIVERSE = [
  "AAPL", "MSFT", "GOOGL", "AMZN", "NVDA", "META", "TSLA", "AVGO", "ORCL", "CRM",
  "AMD", "ADBE", "CSCO", "INTC", "QCOM", "TXN", "IBM", "NOW", "UBER", "SHOP",
  "JPM", "BAC", "WFC", "GS", "MS", "C", "V", "MA", "BRK.B", "BLK",
  "JNJ", "PFE", "MRK", "UNH", "ABBV", "TMO", "LLY", "NKE", "MCD", "SBUX",
  "WMT", "COST", "HD", "TGT", "KO", "PEP", "PG", "XOM", "CVX", "BA",
]
