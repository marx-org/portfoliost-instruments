import { Hono } from "hono"
import type { Context } from "hono"
import { z } from "zod"
import { openApi } from "hono-zod-openapi"
import { convert } from "@marx2/contracts/fx"
import { serviceOrUserMiddleware } from "../auth.js"
import { getDb, type DB } from "../db/index.js"
import { fxWindow, latestFxRates } from "../db/fx-rates.js"
import { getPriceBarSeries, backgroundUpsertBars, queryView } from "../services/price-bars.js"
import { resolveCurrency, resolveInstrumentCurrency } from "../services/instrument-currency.js"
import { TRACKED_CURRENCIES } from "../services/fx-import.js"
import { convertSeries, rateTablesByDate } from "../services/fx-convert.js"
import { fetchQuoteByAssetClass } from "../services/quote-dispatch.js"
import { getNewsForTicker, getRecentNews, getNewsStats } from "../services/news.js"
import { isSavingsBond, providerSymbol, symbolSuffix, venueFreeSymbol } from "../adapters/symbol.js"
import { getExchangeBySuffix } from "../db/tickerref-queries.js"
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
  fetchCryptoSearch,
  fetchBondSearch,
  fetchFundSearch,
  fetchBondProfile,
  fetchBondOhlcv,
  fetchDividendHistory,
  fetchFilings,
  fetchMda,
  fetchInsiderTrading,
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
  toCryptoSearchResponse,
  toBondSearchResponse,
  toReferenceSearchResponse,
  mergeSearchResults,
  toFundSearchResponse,
  toFundamentals,
  toCalendar,
  toDividends,
  toProjections,
  toCompare,
  toInstrumentType,
  toHistoricalPrice,
  toSeasonality,
  toEpsSurprises,
  toInvestorRelations,
  toIrTranscript,
  toOwnershipData,
  toNewsArticleList,
  str,
  type Row,
  UNRESOLVED_CURRENCY,
} from "../adapters/translate.js"
import { curatedPairFromQuery } from "../adapters/crypto.js"
import type { OpenstProfile, OpenstQuote, OpenstOhlcvRow, OpenstConsensus } from "../adapters/openst-types.js"
import type { components } from "../generated/api-types.js"
import {
  ErrorResponseSchema,
  InstrumentSearchResponseSchema,
  InstrumentDetailSchema,
  InstrumentProfileSchema,
  QuoteSchema,
  PriceHistorySchema,
  InstrumentMetricsSchema,
  InstrumentOverviewMetricsSchema,
  ResearchCompareSchema,
  PeersResponseSchema,
  OwnershipDataSchema,
  NewsArticleListSchema,
} from "../schemas/instruments.js"

/** Crypto search leg: FMP rows normalized to yfinance pairs, typed "CRYPTO".
 * Additive with the equity/reference legs — a curated base-coin query always
 * suggests its exact pair (BTC → BTC-USD), so typing ETH surfaces ETH-USD
 * even when the upstream search itself degrades (FMP rejects the eth row with
 * a NaN ico_date). Upstream failures are swallowed: crypto is never the sole
 * cause of a 502. */
async function cryptoSearchLeg(q: string): Promise<components["schemas"]["SearchResult"][]> {
  let results: components["schemas"]["SearchResult"][] = []
  try {
    const rows = (await fetchCryptoSearch(q)) ?? []
    results = toCryptoSearchResponse(rows).results ?? []
  } catch {
    /* crypto is additive — fall through to the curated suggestion below */
  }
  const curated = curatedPairFromQuery(q)
  if (curated) {
    const existing = results.find((r) => r.symbol === curated.symbol)
    results = [
      {
        symbol: curated.symbol,
        name: existing?.name ?? curated.name,
        type: "CRYPTO",
        exchange: "CRYPTO",
        countryCode: null,
        source: "CRYPTO",
      },
      ...results.filter((r) => r.symbol !== curated.symbol),
    ]
  }
  return results
}

/** Fund-category search leg (§78): analytic categories from the catalogue
 * snapshot openst serves. A 404 means "no category matches" — never a 502 — and
 * an upstream failure degrades to empty so the reference-table results, which
 * already carry the same rows once the catalogue has synced, still render. */
async function fundSearchLeg(q: string): Promise<components["schemas"]["SearchResult"][]> {
  try {
    const rows = (await fetchFundSearch(venueFreeSymbol(q))) ?? []
    return toFundSearchResponse(rows).results ?? []
  } catch {
    return []
  }
}

/** Bond search leg (D79): savings-bond emissions from the openbb_obligacje
 * catalogue (symbol prefix or name substring), additive with the equity and
 * crypto legs. A venue suffix on the query (ROD1033.WA) is stripped first —
 * the catalogue keys on the bare symbol only (venue-free). A 404 means simply
 * "no bond matches" — never a 502. */
async function bondSearchLeg(q: string): Promise<components["schemas"]["SearchResult"][]> {
  try {
    const rows = (await fetchBondSearch(venueFreeSymbol(q))) ?? []
    return toBondSearchResponse(rows).results ?? []
  } catch {
    return []
  }
}

/** Equity search leg: SEC/equity rows typed "STOCK". A 404 means "not an
 * equity" (e.g. a bond or crypto symbol) — empty, not fatal, so the additive
 * bond/crypto legs still get served. Real upstream failures still surface. */
async function equitySearchLeg(q: string): Promise<components["schemas"]["SearchResult"][]> {
  try {
    const rows = (await fetchSearch(q)) ?? []
    return toSearchResponse(rows).results ?? []
  } catch (e) {
    if (e instanceof UpstreamError && e.status === 404) return []
    throw e
  }
}

const UNAUTHORIZED = {
  description: "Unauthorized",
  content: { "application/json": { schema: ErrorResponseSchema } },
} as const

const BAD_REQUEST = {
  description: "Bad request",
  content: { "application/json": { schema: ErrorResponseSchema } },
} as const

const UPSTREAM_ERROR = {
  description: "Upstream provider error",
  content: { "application/json": { schema: ErrorResponseSchema } },
} as const

function todayRange(days = 365, futureDays = 0): { start: string; end: string } {
  const now = Date.now()
  const start = new Date(now - days * 86400_000)
  const end = new Date(now + futureDays * 86400_000)
  const fmt = (d: Date) => d.toISOString().slice(0, 10)
  return { start: fmt(start), end: fmt(end) }
}

function dateRange(date: string, days = 30): { start: string; end: string } {
  const end = new Date(`${date}T00:00:00Z`)
  const start = new Date(end.getTime() - days * 86400_000)
  const fmt = (d: Date) => d.toISOString().slice(0, 10)
  return { start: fmt(start), end: date }
}

/** §48.2 — currencies the fx_rates table can convert to (tracker set + the
 * implicit EUR base). Anything else is a 400, never a silent no-op. */
const CONVERSION_CURRENCIES = new Set<string>([...TRACKED_CURRENCIES, "EUR"])

function targetCurrencyParam(c: Context): { value: string | null } | { status: 400; message: string } {
  const raw = c.req.query("currency")
  if (!raw) return { value: null }
  const v = raw.trim().toUpperCase()
  if (!/^[A-Z]{3}$/.test(v) || !CONVERSION_CURRENCIES.has(v)) {
    return { status: 400, message: `currency not supported: ${raw}` }
  }
  return { value: v }
}

function upstreamErrorResponse(c: any, e: unknown) {
  if (e instanceof UpstreamError) {
    const status = e.status === 404 ? 404 : 502
    return c.json({ error: status === 404 ? "NotFound" : "BadGateway", message: e.message }, status as any)
  }
  return c.json({ error: "BadGateway", message: String(e) }, 502 as any)
}

/**
 * OHLCV with D79 bond fallback: a savings-bond symbol 404s (or times out —
 * the equity tier spins through three OpenBB providers) the equity history
 * leg, so fall back to the bond-pricing leg (`fixedincome/ohlcv`) for any
 * upstream failure before surfacing the original error.
 */
async function fetchOhlcvWithBondFallback(
  symbol: string,
  start: string,
  end: string,
): Promise<OpenstOhlcvRow[]> {
  // Plan §37.2 — an emission's only OHLCV source is the obligacje engine;
  // go straight there instead of paying the equity provider walk first.
  // A miss in the bond engine is surfaced as-is (no equity retry — for a
  // real emission code the equity tier is guaranteed dead weight, §37).
  if (isSavingsBond(symbol)) {
    return (await fetchBondOhlcv(symbol, start, end)) as unknown as OpenstOhlcvRow[]
  }
  try {
    return (await fetchOhlcv(symbol, start, end)) as unknown as OpenstOhlcvRow[]
  } catch (e) {
    if (e instanceof UpstreamError) {
      try {
        return (await fetchBondOhlcv(symbol, start, end)) as unknown as OpenstOhlcvRow[]
      } catch {
        /* not a bond either — fall through to the original error */
      }
    }
    throw e
  }
}

/**
 * Plan §48.4a — the read-through fallback for /history: when the provider
 * leg fails (502 bursts under parallel load) or returns an empty series,
 * serve the local `price_bars_all` instead, so a failed /history never
 * wipes the series the SPA already rendered from the price-bars leg.
 *
 * Close-only rows (OHLC synthesized from close); (symbol,date) duplicates
 * from stooq/overflow overlap are dropped, stooq-first (view ordering).
 */
async function localHistoryRows(
  db: DB,
  symbol: string,
  start: string,
  end: string,
): Promise<OpenstOhlcvRow[]> {
  const rows = await queryView(db, symbol, start, end)
  const seen = new Set<string>()
  const out: OpenstOhlcvRow[] = []
  for (const r of rows) {
    if (seen.has(r.date)) continue
    seen.add(r.date)
    const close = Number(r.close)
    out.push({ date: r.date, open: close, high: close, low: close, close, volume: 0 })
  }
  return out
}

export function createInstrumentsRoutes() {
  const instruments = new Hono()
  // §63.10 — a service token (the scheduled wallets sweep) or a user JWT.
  instruments.use("*", serviceOrUserMiddleware)


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
      if (!q) return c.json({ count: 0, results: [] } satisfies components["schemas"]["InstrumentSearchResponse"])

      // Primary source: local ticker reference table (synced from
      // adanos/free-ticker-database). Falls back to the provider tier when
      // the table is empty or unavailable (e.g. pre-seed environments). The
      // crypto leg runs alongside whichever tier answers (additive — equity
      // "btc" already returns BTCS Inc., so crypto must not be last-only).
      try {
        const rows = await searchTickerReference(getDb(), q)
        if (rows.length > 0) {
          return c.json(
            // Crypto leg first so the curated exact-pair suggestion
            // (BTC-USD when typing "btc") is never occluded by the reference
            // tier's name-match flood under the 50-result cap. Bonds are
            // additive too (D79) — ROD/EDO emissions from the obligacje
            // catalogue always surface alongside the reference rows.
            mergeSearchResults(
              await cryptoSearchLeg(q),
              await bondSearchLeg(q),
              await fundSearchLeg(q),
              toReferenceSearchResponse(rows).results ?? [],
            ),
          )
        }
      } catch {
        /* reference table unavailable — use the provider tier */
      }

      try {
        const [eqRows, cryptoRows, bondRows, fundRows] = await Promise.all([
          equitySearchLeg(q),
          cryptoSearchLeg(q),
          bondSearchLeg(q),
          fundSearchLeg(q),
        ])
        return c.json(mergeSearchResults(cryptoRows, fundRows, bondRows, eqRows))
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
      const routeSymbol = c.req.param("symbol").toUpperCase()
      const symbol = providerSymbol(routeSymbol)
      if (isSavingsBond(symbol)) {
        // Plan §37.2 — savings-bond emissions have no equity profile; go
        // straight to the obligacje bond profile (no equity 404 round-trip).
        try {
          const bondProfile = (await fetchBondProfile(symbol)) as OpenstProfile
          const resolution = await resolveCurrency(getDb(), routeSymbol, bondProfile.currency)
          return c.json(toInstrumentDetail(symbol, bondProfile, resolution))
        } catch (e) {
          return upstreamErrorResponse(c, e)
        }
      }
      try {
        const profile = (await fetchProfile(symbol)) as OpenstProfile
        const resolution = await resolveCurrency(getDb(), routeSymbol, profile.currency)
        return c.json(toInstrumentDetail(symbol, profile, resolution))
      } catch (e) {
        // D79 — savings-bond emissions (ROD0938, EDO0936, …) have no equity
        // profile: a bond symbol either 404s the equity tier (no match, fast)
        // or — because the equity fallback spins through three OpenBB
        // providers — times out cachest's fetch window (502/504). Try the
        // bond catalogue before surfacing the upstream error either way.
        if (e instanceof UpstreamError) {
          try {
            const bondProfile = (await fetchBondProfile(symbol)) as OpenstProfile
            const resolution = await resolveCurrency(getDb(), routeSymbol, bondProfile.currency)
            return c.json(toInstrumentDetail(symbol, bondProfile, resolution))
          } catch {
            /* not a bond either — fall through to the original error */
          }
        }
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
      const routeSymbol = c.req.param("symbol").toUpperCase()
      const symbol = providerSymbol(routeSymbol)
      if (isSavingsBond(symbol)) {
        // Plan §37.2 — the obligacje bond profile is the only profile source
        // for an emission; never probe the equity tier for it.
        try {
          const bondProfile = (await fetchBondProfile(symbol)) as OpenstProfile
          const resolution = await resolveCurrency(getDb(), routeSymbol, bondProfile.currency)
          return c.json(toInstrumentProfile(symbol, bondProfile, resolution))
        } catch (e) {
          return upstreamErrorResponse(c, e)
        }
      }
      try {
        const profile = (await fetchProfile(symbol)) as OpenstProfile
        const resolution = await resolveCurrency(getDb(), routeSymbol, profile.currency)
        const out: ReturnType<typeof toInstrumentProfile> = toInstrumentProfile(
          symbol,
          profile,
          resolution,
        )
        // Fill identity gaps (ISIN, sector, country, exchange) from the
        // local reference table when the provider profile lacks them.
        try {
          const suffix = symbolSuffix(routeSymbol)
          const venueExchange = suffix ? await getExchangeBySuffix(getDb(), suffix) : null
          const [ref] = await searchTickerReference(getDb(), symbol, 1, venueExchange)
          const baseTicker = symbol.split(".")[0]
          if (ref && ref.ticker === baseTicker) {
            out.name = out.name ?? ref.name
            // §61.8 — asset class for the shared identity block, from the same
            // reference row and under the same guard as countryCode.
            out.assetType = toInstrumentType(ref.assetType)
            out.isin = ref.isin ?? out.isin ?? null
            out.country = out.country ?? ref.country
            out.countryCode = out.countryCode ?? ref.countryCode
            // "YHD" is Yahoo's placeholder for delisted/unknown exchanges —
            // the reference table is more trustworthy there.
            const exchangePlaceholder = !out.exchange || out.exchange === "YHD"
            out.exchange = exchangePlaceholder && ref.exchange ? ref.exchange : out.exchange
            out.finnhubIndustry = out.finnhubIndustry ?? ref.stockSector ?? ref.etfCategory
            out.gicsSector = out.gicsSector ?? ref.stockSector
          }
        } catch {
          /* reference table unavailable — provider profile is enough */
        }
        return c.json(out)
      } catch (e) {
        if (e instanceof UpstreamError) {
          try {
            const bondProfile = (await fetchBondProfile(symbol)) as OpenstProfile
            const resolution = await resolveCurrency(getDb(), routeSymbol, bondProfile.currency)
            const out = toInstrumentProfile(symbol, bondProfile, resolution)
            return c.json(out)
          } catch {
            /* not a bond either — fall through to the original error */
          }
        }
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
      const symbol = providerSymbol(c.req.param("symbol").toUpperCase())
      if (isSavingsBond(symbol)) {
        // Plan §37.2 — fundamental metrics don't exist for a savings-bond
        // emission; answer without probing the equity tier (the 7-provider
        // walk behind every probe was the load that OOMed openst §37).
        return c.json({ error: "NotFound", message: "Not applicable for savings bonds" }, 404)
      }
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
      const symbol = providerSymbol(c.req.param("symbol").toUpperCase())
      if (isSavingsBond(symbol)) {
        // Plan §37.2 — same as /metrics: no equity probe for an emission.
        return c.json({ error: "NotFound", message: "Not applicable for savings bonds" }, 404)
      }
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
      const routeSymbol = c.req.param("symbol").toUpperCase()
      const symbol = providerSymbol(routeSymbol)
      try {
        // 34 — dispatch by ticker_reference.asset_type: bond → fixedincome
        // quote, crypto → crypto quote (pair-normalized), everything else
        // (incl. corp_bond/fund, verified in 34.1) stays on the equity quote.
        const q = (await fetchQuoteByAssetClass(getDb(), routeSymbol)) as OpenstQuote
        const resolution = await resolveCurrency(getDb(), routeSymbol, q.currency)
        return c.json(toQuote({ symbol, ...q }, resolution))
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
      const symbol = providerSymbol(c.req.param("symbol").toUpperCase())
      const resolutionParam = c.req.query("resolution") === "monthly" ? "monthly" : "daily"
      const compareParam = c.req.query("compare")
      const target = targetCurrencyParam(c)
      if ("status" in target) {
        return c.json({ error: "BadRequest", message: target.message }, 400)
      }
      // §48.2 / plan §56.3 — conversion needs a known base; an unresolvable
      // base currency (a multi-exchange ticker collision that the resolver
      // leaves silent per §47) is a 400, never a silently unconverted series.
      // The price-bars leg already guards; this is the /history leg of
      // PriceChart, which previously returned 200 with currency:null + USD
      // closes while the title selector still read the chosen display ccy.
      if (
        target.value &&
        !(await resolveInstrumentCurrency(getDb(), c.req.param("symbol").toUpperCase()))
      ) {
        return c.json({ error: "BadRequest", message: "base currency unknown; cannot convert" }, 400)
      }
      try {
        // Serve deep history so client-side timeframe slicing (3Y/5Y/10Y/MAX)
        // has data: 11 years of daily bars, 20 years of monthly bars.
        const { start, end } = resolutionParam === "monthly" ? todayRange(7300) : todayRange(4018)
        const systemSymbol = c.req.param("symbol").toUpperCase()
        // Plan §48.4a — provider leg first; on upstream failure OR an empty
        // series, fall back to the local read-through cache (price_bars_all)
        // so a 502 burst never wipes the chart the SPA already rendered.
        let rows: OpenstOhlcvRow[] | null = null
        let providerError: unknown = null
        try {
          rows = await fetchOhlcvWithBondFallback(symbol, start, end)
        } catch (e) {
          providerError = e
        }
        let fromLocal = false
        if (!rows || rows.length === 0) {
          const db = getDb()
          if (db) {
            const local = await localHistoryRows(db, systemSymbol, start, end)
            if (local.length > 0) {
              rows = local
              fromLocal = true
            }
          }
        }
        if (rows === null) {
          // No local data: old semantics — the original upstream error
          // (404/502), or an empty 200 when the provider simply had no data.
          if (providerError !== null) throw providerError
          rows = []
        }
        // H4: background write-through — accumulates price_bars organically
        // (provider rows only; local rows are already in the view).
        if (!fromLocal) backgroundUpsertBars(getDb(), systemSymbol, rows)
        // §36 — the series is denominated in the instrument's trading currency.
        // 47.4 — no USD guess: the resolution may legitimately be null, which is
        // reported via currencySource="unknown".
        const resolution = await resolveCurrency(getDb(), c.req.param("symbol"), null)
        const base = toPriceHistory(rows, resolutionParam, resolution.currency, resolution.currencySource)

        // §48.2 — server-side conversion to ?currency=: one fx_rates window
        // read, D27 crossRate per dated table. Bars without a rate row stay
        // in the base currency (floor semantics, no carry-forward).
        let history = base
        let fxFrom: string | null = null
        const targetCcy = target.value
        const baseCcy = resolution.currency
        const tables =
          targetCcy && baseCcy && targetCcy !== baseCcy
            ? rateTablesByDate(await fxWindow(getDb(), [baseCcy, targetCcy], start, end))
            : null
        if (tables && targetCcy && baseCcy) {
          const dates = base.timestamps.map((ts) => new Date(ts * 1000).toISOString().slice(0, 10))
          const cc = convertSeries(dates, base.closePrices, baseCcy, targetCcy, tables)
          const ch = convertSeries(dates, base.highPrices, baseCcy, targetCcy, tables)
          const cl = convertSeries(dates, base.lowPrices, baseCcy, targetCcy, tables)
          const co = convertSeries(dates, base.openPrices, baseCcy, targetCcy, tables)
          fxFrom = cc.fxFrom
          // §72.17 — drop the bars that could not be converted, from EVERY
          // parallel array and the timestamps, so the series really is in
          // `targetCcy`. Keeping them (the old floor semantics) meant a base
          // currency number was served under the target's label; see
          // services/fx-convert.ts for the portfolio-total arithmetic it caused.
          const keep = cc.convertedMask
            .map((ok, i) => (ok ? i : -1))
            .filter((i) => i >= 0)
          const pick = (a: readonly number[]): number[] => keep.map((i) => a[i] as number)
          history = {
            ...base,
            timestamps: keep.map((i) => base.timestamps[i] as number),
            closePrices: pick(cc.converted),
            highPrices: pick(ch.converted),
            lowPrices: pick(cl.converted),
            openPrices: pick(co.converted),
            volumes: keep.map((i) => base.volumes[i] as number),
            currency: targetCcy,
          }
        }

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
            // Plan §48.4a — the overlay is deterministic on the compose stack:
            // read the ETF from local price_bars_all first (pricebars-sim
            // seeds SPY/QQQ/IWM); fall back to the live provider only when no
            // local bars exist (e.g. a fresh prod overflow table).
            let benchRows: Array<{ date: string; close: number }> = []
            const db = getDb()
            if (db) {
              const local = await localHistoryRows(db, bench.etf, start, end)
              if (local.length > 0) benchRows = local
            }
            if (benchRows.length === 0) {
              benchRows = (await fetchOhlcv(bench.etf, start, end)) as unknown as Array<{ date: string; close: number }>
            }
            const byDate = new Map(benchRows.map((r) => [r.date, Number(r.close)]))
            let last: number | null = null
            const dates = (history.timestamps as number[]).map((ts) => new Date(ts * 1000).toISOString().slice(0, 10))
            let closePrices = dates.map((date) => {
              const v = byDate.get(date)
              if (v !== undefined && Number.isFinite(v) && v > 0) last = v
              return last ?? 0
            })
            // §48.2 — the overlay shares the selected currency (benchmarks are USD).
            if (tables && targetCcy) {
              closePrices = convertSeries(dates, closePrices, "USD", targetCcy, tables).converted
            }
            compare = { name: bench.name, closePrices, timestamps: history.timestamps, currency: tables && targetCcy ? targetCcy : "USD" }
          } catch {
            compare = undefined
          }
        }
        return c.json({
          ...history,
          symbol,
          baseCurrency: resolution.currency,
          fxFrom,
          ...(compare ? { compare } : {}),
        })
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
              schema: z.object({
                symbol: z.string(),
                price: z.number(),
                currency: z.string().optional(),
                baseCurrency: z.string().nullish(),
                fxFrom: z.string().nullish(),
              }),
            },
          },
        },
        401: UNAUTHORIZED,
        502: UPSTREAM_ERROR,
      },
    }),
    async (c) => {
      const symbol = providerSymbol(c.req.param("symbol").toUpperCase())
      const date = c.req.query("date")
      const target = targetCurrencyParam(c)
      if ("status" in target) {
        return c.json({ error: "BadRequest", message: target.message }, 400)
      }
      try {
        if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
          return c.json({ error: "BadRequest", message: "date must be YYYY-MM-DD" }, 400)
        }
        if (date) {
          const { start, end } = dateRange(date)
          const rows = await fetchOhlcvWithBondFallback(symbol, start, end)
          // H4: background write-through
          backgroundUpsertBars(getDb(), c.req.param("symbol").toUpperCase(), rows)
          const last = rows[rows.length - 1]
          if (!last) {
            return c.json({ error: "NotFound", message: `No price found for ${symbol} on or before ${date}` }, 404)
          }
          const baseCcy = await resolveInstrumentCurrency(getDb(), c.req.param("symbol"))
          let price = Number(last.close)
          let currency: string | null = null
          let fxFrom: string | null = null
          // §48.2 — convert against the newest rate table on/before the bar date.
          if (target.value && baseCcy && target.value !== baseCcy) {
            const rates = await latestFxRates(getDb(), [baseCcy, target.value], last.date)
            const table: Record<string, number> = {}
            for (const r of rates) table[r.currency] = Number(r.rate)
            const conv = convert(price, baseCcy, target.value, table)
            if (conv === undefined) {
              return c.json(
                { error: "BadRequest", message: `no FX rate for ${baseCcy} to ${target.value} on or before ${last.date}` },
                400,
              )
            }
            price = conv
            currency = target.value
            fxFrom = rates.map((r) => r.rateDate).sort()[0] ?? null
          }
          return c.json({ symbol, price, currency, baseCurrency: baseCcy, fxFrom, date: last.date })
        }
        // 34 — asset-class-aware dispatch (bond/crypto/equity), same as /quote.
        const routeSymbol = c.req.param("symbol").toUpperCase()
        const q = (await fetchQuoteByAssetClass(getDb(), routeSymbol)) as OpenstQuote
        const resolution = await resolveCurrency(getDb(), routeSymbol, q.currency)
        let price = Number(q.last_price ?? 0)
        let currency = resolution.currency
        let fxFrom: string | null = null
        // §48.2 — convert the live quote against the newest rate table.
        if (target.value && resolution.currency && target.value !== resolution.currency) {
          const today = new Date().toISOString().slice(0, 10)
          const rates = await latestFxRates(getDb(), [resolution.currency, target.value], today)
          const table: Record<string, number> = {}
          for (const r of rates) table[r.currency] = Number(r.rate)
          const conv = convert(price, resolution.currency, target.value, table)
          if (conv === undefined) {
            return c.json(
              { error: "BadRequest", message: `no FX rate for ${resolution.currency} to ${target.value}` },
              400,
            )
          }
          price = conv
          currency = target.value
          fxFrom = rates.map((r) => r.rateDate).sort()[0] ?? null
        }
        return c.json({ symbol, price, currency, baseCurrency: resolution.currency, fxFrom })
      } catch (e) {
        return upstreamErrorResponse(c, e)
      }
    },
  )

  instruments.get(
    "/:symbol/price-bars",
    openApi({
      tags: ["Instruments"],
      summary: "Daily close-price series over a date range (stooq + overflow)",
      operationId: "getPriceBars",
      parameters: [
        { name: "from", in: "query", required: true, schema: { type: "string", format: "date" } },
        { name: "to", in: "query", required: true, schema: { type: "string", format: "date" } },
        {
          name: "currency",
          in: "query",
          schema: { type: "string" },
          description: "Optional ISO-4217 target currency — closes are converted server-side (plan §48.2)",
        },
        {
          name: "baseCurrency",
          in: "query",
          schema: { type: "string" },
          description:
            "Optional ISO-4217 base currency the CALLER believes the closes are denominated in " +
            "(e.g. wallets' position `instrumentCurrency`). Used only where the local resolver is " +
            "silent — a locally resolved base is never overridden (§47 'never guess'). Without it a " +
            "ticker listed on several venues in different currencies cannot be converted at all, " +
            "which used to 400 and take the caller's whole request with it (§63.10.5).",
        },
      ],
      responses: {
        200: {
          description: "Daily close-price series",
          content: {
            "application/json": {
              schema: z.object({
                symbol: z.string(),
                timeframe: z.string(),
                stale: z.boolean(),
                currency: z.string(),
                baseCurrency: z.string().nullish(),
                fxFrom: z.string().nullish(),
                dates: z.array(z.string()),
                closes: z.array(z.number()),
              }),
            },
          },
        },
        400: BAD_REQUEST,
        401: UNAUTHORIZED,
        502: UPSTREAM_ERROR,
      },
    }),
    async (c) => {
      const symbol = c.req.param("symbol").toUpperCase()
      const from = c.req.query("from")
      const to = c.req.query("to")
      if (!from || !to || !/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
        return c.json({ error: "BadRequest", message: "from and to must be YYYY-MM-DD" }, 400)
      }
      const target = targetCurrencyParam(c)
      if ("status" in target) {
        return c.json({ error: "BadRequest", message: target.message }, 400)
      }
      // §48.2 — conversion needs a known base; an unresolvable base currency
      // is a 400, never a silently unconverted series. §63.10.5 — unless the
      // caller declared one (the base it already knows, e.g. the position's
      // instrumentCurrency), which is only honoured when the local resolver is
      // silent.
      const declaredBase = c.req.query("baseCurrency")?.trim().toUpperCase() ?? null
      if (declaredBase && !CONVERSION_CURRENCIES.has(declaredBase)) {
        return c.json({ error: "BadRequest", message: `base currency not supported: ${declaredBase}` }, 400)
      }
      if (
        target.value &&
        !(await resolveInstrumentCurrency(getDb(), symbol)) &&
        !declaredBase
      ) {
        return c.json({ error: "BadRequest", message: "base currency unknown; cannot convert" }, 400)
      }
      const series = await getPriceBarSeries(getDb(), symbol, from, to, new Date(), {
        targetCcy: target.value,
        baseCcy: declaredBase,
      })
      return c.json({
        symbol: series.symbol,
        timeframe: "daily",
        stale: series.stale,
        currency: series.currency,
        baseCurrency: series.baseCurrency,
        fxFrom: series.fxFrom,
        dates: series.dates,
        closes: series.closes,
      })
    },
  )

  registerPt2Routes(instruments)
  instruments.get(
    "/:symbol/ownership",
    openApi({
      tags: ["Instruments"],
      summary: "Ownership — SEC Form 4 insider transactions; aggregated 13F holder groups pending a provider",
      operationId: "getOwnership",
      responses: {
        200: { description: "Ownership", content: { "application/json": { schema: OwnershipDataSchema } } },
        401: UNAUTHORIZED,
      },
    }),
    async (c) => {
      const symbol = providerSymbol(c.req.param("symbol").toUpperCase())
      try {
        // SEC Form 4 insider transactions (openst). Aggregated 13F holder groups
        // (institutional/mutual-fund/insider) have no provider in this tier yet —
        // they degrade to empty arrays; upstream 404 also degrades to empty.
        const insider = await fetchInsiderTrading(symbol)
        return c.json({ symbol, ...toOwnershipData(symbol, insider) })
      } catch (e) {
        return upstreamErrorResponse(c, e)
      }
    },
  )
  return instruments
}

// ── News routes (stock-news.md N5) ────────────────────────────────────────
// Mounted at /api/news in index.ts via createNewsRoutes(); JWT-protected
// like the rest of instruments, returning contract NewsArticleList.
export function createNewsRoutes() {
  const news = new Hono()
  news.use("*", serviceOrUserMiddleware)

  news.get(
    "/articles",
    openApi({
      tags: ["News"],
      summary: "News articles for a ticker (or recent stored articles)",
      operationId: "getNewsArticles",
      parameters: [
        { name: "ticker", in: "query", schema: { type: "string" } },
        { name: "limit", in: "query", schema: { type: "integer", default: 20 } },
      ],
      responses: {
        200: {
          description: "Articles",
          content: { "application/json": { schema: NewsArticleListSchema } },
        },
        401: UNAUTHORIZED,
        502: UPSTREAM_ERROR,
      },
    }),
    async (c) => {
      const limitParam = Number(c.req.query("limit"))
      const limit = Number.isFinite(limitParam) && limitParam > 0 ? Math.min(Math.floor(limitParam), 100) : 20
      const ticker = (c.req.query("ticker") ?? "").trim()
      try {
        const rows = ticker
          ? await getNewsForTicker(getDb(), ticker, limit)
          : await getRecentNews(getDb(), limit)
        return c.json(toNewsArticleList(rows, ticker || undefined))
      } catch (e) {
        return upstreamErrorResponse(c, e)
      }
    },
  )

  news.get(
    "/stats",
    openApi({
      tags: ["News"],
      summary: "News stats for a ticker (stored rows; legacy wire shape)",
      operationId: "getNewsStats",
      parameters: [{ name: "ticker", in: "query", schema: { type: "string" } }],
      responses: {
        200: {
          description: "Stats",
          content: { "application/json": { schema: z.looseObject({}) } },
        },
        401: UNAUTHORIZED,
        502: UPSTREAM_ERROR,
      },
    }),
    async (c) => {
      const ticker = (c.req.query("ticker") ?? "AAPL").trim()
      try {
        const stats = await getNewsStats(getDb(), ticker)
        return c.json({ error: null, data: stats as unknown as Record<string, unknown> } satisfies components["schemas"]["NewsStats"])
      } catch (e) {
        return upstreamErrorResponse(c, e)
      }
    },
  )

  return news
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
      const symbol = providerSymbol(c.req.param("symbol").toUpperCase())
      if (isSavingsBond(symbol)) {
        // Plan §37.2 — no financial statements exist for a savings-bond
        // emission; answer without probing the equity tier (§37).
        return c.json({ error: "NotFound", message: "Not applicable for savings bonds" }, 404)
      }
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
      const routeSymbol = c.req.param("symbol").toUpperCase()
      const symbol = providerSymbol(routeSymbol)
      // §49.9 follow-up — the calendar must (a) reach the future: quarterly
      // dividends/earnings (ex-date and payment date) otherwise never qualify
      // as "upcoming"; and (b) keep the past lookback ≤ 30d: the fmp free tier
      // rejects a deeper `from` with 402 (premium) → openst blocks fmp for 24h
      // and nasdaq's calendar API is bot-blocked (403) — empty calendar.
      const { start, end } = todayRange(30, 120)
      if (isSavingsBond(symbol)) {
        // Plan §37.2 — no earnings/dividend calendar for an emission; skip
        // the equity calendar probes and the fetchProfile call.
        return c.json(toCalendar(symbol, [], [], "PLN"))
      }
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
        // §49.6 — the resolved instrument currency replaces the §36 profile
        // fallback; the contract requires a non-null currency.
        // §66.4 — resolver silence used to silently grant "USD". It is now the
        // named placeholder and the route logs it, so a research page can show
        // an unresolved currency instead of a plausible-looking wrong one.
        const resolvedCcy = await resolveInstrumentCurrency(getDb(), routeSymbol)
        if (!resolvedCcy) {
          console.warn(`[instruments] resolver silence for ${routeSymbol}; reporting the unresolved-currency placeholder`)
        }
        const currency = resolvedCcy ?? UNRESOLVED_CURRENCY
        return c.json(toCalendar(symbol, earningsRows as any[], dividendRows as any[], currency))
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
      const routeSymbol = c.req.param("symbol").toUpperCase()
      const symbol = providerSymbol(routeSymbol)
      try {
        const rows = await fetchDividendHistory(symbol)
        // §49.6 — thread the §47.4 currencySource treatment: the first
        // provider-declared row currency is the declaration; the single
        // resolver fills the silence. The response carries non-null `currency`
        // (fallback "USD" only when nothing is known) + `currencySource`.
        const providerCurrency =
          (rows as unknown as Array<{ currency?: string | null }>).find((r) => (r?.currency ?? "").trim())?.currency ?? null
        const resolution = await resolveCurrency(getDb(), routeSymbol, providerCurrency)
        return c.json(toDividends(rows as any[], resolution))
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
      const symbol = providerSymbol(c.req.param("symbol").toUpperCase())
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
          content: { "application/json": { schema: ResearchCompareSchema } },
        },
        401: UNAUTHORIZED,
        502: UPSTREAM_ERROR,
      },
    }),
    async (c) => {
      const symbol = providerSymbol(c.req.param("symbol").toUpperCase())
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
      const symbol = providerSymbol(c.req.param("symbol").toUpperCase())
      const date = c.req.query("date")
      if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        return c.json({ error: "BadRequest", message: "date query parameter must be YYYY-MM-DD" }, 400 as any)
      }
      const startD = new Date(Date.parse(date + "T00:00:00Z") - 10 * 86400_000)
      const { start, end } = { start: startD.toISOString().slice(0, 10), end: date }
      try {
        const rows = await fetchOhlcvWithBondFallback(symbol, start, end)
        // §66.4 — this route used to inherit toHistoricalPrice's `= "USD"`
        // default, so every historical price was labelled USD. Resolve the real
        // currency (the parameter is now required, so the compiler forces this).
        const histCcy = await resolveInstrumentCurrency(getDb(), symbol)
        if (!histCcy) {
          console.warn(`[instruments] resolver silence for ${symbol}; historical price reports the unresolved-currency placeholder`)
        }
        return c.json(toHistoricalPrice(symbol, date, rows, histCcy ?? UNRESOLVED_CURRENCY))
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
      const symbol = providerSymbol(c.req.param("symbol").toUpperCase())
      const years = [3, 5, 10, 20].includes(Number(c.req.query("years"))) ? Number(c.req.query("years")) : 5
      const metricParam = c.req.query("metric")
      const metric = ["avg", "median", "min", "max"].includes(metricParam ?? "")
        ? (metricParam as "avg" | "median" | "min" | "max")
        : "avg"
      const start = new Date(Date.now() - (years + 1) * 365 * 86400_000).toISOString().slice(0, 10)
      const end = new Date().toISOString().slice(0, 10)
      try {
        const rows = await fetchOhlcvWithBondFallback(symbol, start, end)
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
      const symbol = providerSymbol(c.req.param("symbol").toUpperCase())
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
      summary: "IR events derived from reported quarters + SEC filings",
      operationId: "getInvestorRelations",
      responses: {
        200: { description: "Events", content: { "application/json": { schema: z.array(z.looseObject({})) } } },
        401: UNAUTHORIZED,
        502: UPSTREAM_ERROR,
      },
    }),
    async (c) => {
      const symbol = providerSymbol(c.req.param("symbol").toUpperCase())
      try {
        const rows = await fetchFundamentals(symbol, "income", "quarter")
        let filings: Array<Record<string, unknown>> | null = null
        try {
          filings = await fetchFilings(symbol)
        } catch {
          // filings may be missing for some tickers — degrade to quarters only
        }
        return c.json(toInvestorRelations(symbol, rows, filings))
      } catch (e) {
        return upstreamErrorResponse(c, e)
      }
    },
  )

  instruments.get(
    "/:symbol/investor-relations/:eventId/transcript",
    openApi({
      tags: ["Instruments"],
      summary: "Transcript / MD&A text for an investor relations event",
      operationId: "getIrTranscript",
      responses: {
        200: { description: "Transcript", content: { "application/json": { schema: z.looseObject({}) } } },
        401: UNAUTHORIZED,
        502: UPSTREAM_ERROR,
      },
    }),
    async (c) => {
      const symbol = providerSymbol(c.req.param("symbol").toUpperCase())
      const eventId = c.req.param("eventId")
      try {
        let mda: Record<string, unknown> | null = null
        try {
          mda = await fetchMda(symbol)
        } catch {
          // MD&A unavailable — return structured empty transcript
        }
        return c.json(toIrTranscript(eventId, symbol, mda))
      } catch (e) {
        return upstreamErrorResponse(c, e)
      }
    },
  )

  instruments.get(
    "/:symbol/peers",
    openApi({
      tags: ["Instruments"],
      summary: "Same-sector peers composed into compare rows",
      operationId: "getPeers",
      responses: {
        200: { description: "Peers", content: { "application/json": { schema: PeersResponseSchema } } },
        401: UNAUTHORIZED,
        502: UPSTREAM_ERROR,
      },
    }),
    async (c) => {
      const symbol = providerSymbol(c.req.param("symbol").toUpperCase())
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
        // §61.4 — the shared identity block needs a country and an asset class,
        // and the provider's compare rows carry neither. Enrich from the local
        // ticker reference with the same `ref.ticker === baseTicker` guard the
        // profile route uses, so a suffix-only match cannot attribute one
        // listing's country to another. `toCompare` stays pure — the lookup
        // is the route's job, because the reference is a local table.
        await Promise.all(
          items.map(async (item) => {
            const sym = item.symbol
            if (!sym) return
            try {
              const suffix = symbolSuffix(sym)
              const venueExchange = suffix ? await getExchangeBySuffix(getDb(), suffix) : null
              const [ref] = await searchTickerReference(getDb(), sym, 1, venueExchange)
              if (!ref || ref.ticker !== sym.split(".")[0]) return
              item.countryCode = ref.countryCode ?? null
              item.assetType = toInstrumentType(ref.assetType)
            } catch {
              /* reference table unavailable — the row degrades to symbol + name */
            }
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
