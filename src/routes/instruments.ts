import { Hono } from "hono"
import { z } from "zod"
import { openApi } from "hono-zod-openapi"
import { userIdentityMiddleware } from "../auth.js"
import {
  fetchProfile,
  fetchQuote,
  fetchMetrics,
  fetchProjections,
  fetchOhlcv,
  fetchSearch,
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

function todayRange(): { start: string; end: string } {
  const end = new Date()
  const start = new Date(end.getTime() - 365 * 86400_000)
  const fmt = (d: Date) => d.toISOString().slice(0, 10)
  return { start: fmt(start), end: fmt(end) }
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
      try {
        const q = (c.req.query("q") ?? c.req.query("query") ?? "").trim()
        if (!q) return c.json({ count: 0, results: [] })
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
      try {
        const { start, end } = todayRange()
        const rows = (await fetchOhlcv(symbol, start, end)) as unknown as OpenstOhlcvRow[]
        const history = toPriceHistory(rows, resolutionParam)
        return c.json({ ...history, symbol })
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
      try {
        const q = (await fetchQuote(symbol)) as OpenstQuote
        return c.json({ symbol, price: Number(q.last_price ?? 0), currency: q.currency ?? "USD" })
      } catch (e) {
        return upstreamErrorResponse(c, e)
      }
    },
  )

  return instruments
}
