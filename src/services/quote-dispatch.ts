/**
 * Plan 34 — asset-class-aware quote dispatch.
 *
 * D81 already routes price-bars OHLCV by `ticker_reference.asset_type`; this
 * extends the same dispatch to the current-price path (`/:symbol/quote` and
 * `/:symbol/price`). Per class (34.1 probe results):
 *
 *   crypto    → cachest /crypto/quote/{pair}          (pair form, e.g. BTC-USD)
 *   bond      → cachest /fixedincome/quote/{symbol}   (obligacje computed close)
 *   fund (category) → the latest two bars of /fund/history/{code} (plan §78.1)
 *   everything else (stock/etf/corp_bond/fund .TFI) → the existing equity
 *   /equity/quote — verified in 34.1 to serve corp_bond (BST0327 bare or .WA)
 *   and fund (.TFI) symbols through the openst biznesradar dispatch.
 *
 * §78.1 — the fund *category* case is the one the provider work missed. History
 * was built (§72.39) but the current-price path was not, so a category code fell
 * through to /equity/quote and 404'd. That is invisible in the bars and very
 * visible in the product: `positions.price_source` stayed at its `manual`
 * default with a NULL current_price, so the holding was silently excluded from
 * the portfolio value. PROD, 2026-10-01: ING01W unpriced while NNEP65.TFI was
 * priced from the same rebuild. A fund NAV has no intraday session, so its
 * "quote" is the latest valuation — which is exactly what the history route has.
 *
 * The asset-type lookup degrades to `stock` (today's behavior) when the DB is
 * unavailable or the symbol is unlisted — a dispatch hiccup must never break
 * the quote.
 */
import type { DB } from "../db/index.js"
import { assetTypeForSymbol, normalizeAssetType, priceTierForSymbol } from "../db/tickerref-queries.js"
import {
  fetchQuote,
  fetchCryptoQuote,
  fetchFixedincomeQuote,
  fetchFundCategoryHistory,
} from "../adapters/cachest.js"
import { UpstreamError } from "../adapters/cachest.js"
import { providerSymbol, venueFreeSymbol } from "../adapters/symbol.js"

/** Retail savings-bond emission codes (ROD/EDO + 4 digits). These are never
 * exchange-listed, so the equity tier 404s for them and the obligacje engine
 * is their price source (D79 precedent: fetchOhlcvWithBondFallback). */
const SAVINGS_BOND = /^(ROD|EDO)\d{4}$/

/** Look up a fund category's display name from the catalogue row (§78.1).
 *  Returns null when the row is absent — the quote is still valid without it,
 *  and toQuote falls back to the symbol. */
async function fundCategoryName(db: DB | null, symbol: string): Promise<string | null> {
  if (!db) return null
  try {
    const { searchTickerReference } = await import("../db/tickerref-queries.js")
    const rows = await searchTickerReference(db, symbol, 1)
    const hit = rows.find((r) => r.ticker.toUpperCase() === symbol)
    return hit?.name ?? null
  } catch {
    return null
  }
}

/**
 * Build a quote row from a fund category's latest two NAVs (§78.1).
 *
 * A PPO/PPI fund publishes one valuation per business day, so open/high/low are
 * the same figure as the last close — which is exactly what biznesradar reports
 * for `.TFI` funds (verified in PROD: NNEP65.TFI returns open=high=low=last=
 * 19.81), so the two fund tiers stay shaped alike and the SPA needs no special
 * case. `prev_close` is the preceding valuation, giving a real day-over-day
 * change instead of a hardcoded zero.
 *
 * The window is 14 days, not 1: a long weekend plus a single missing valuation
 * must not read as "no price", which is the failure this whole route exists to
 * stop. Throws when the category serves nothing, so the caller degrades loudly
 * rather than pricing a holding at zero.
 */
async function fundCategoryQuote(db: DB | null, symbol: string): Promise<Record<string, unknown>> {
  const end = new Date()
  const start = new Date(end.getTime() - 14 * 864e5)
  const iso = (d: Date) => d.toISOString().slice(0, 10)
  const bars = (await fetchFundCategoryHistory(symbol, iso(start), iso(end))) ?? []
  if (bars.length === 0) {
    throw new UpstreamError(`${symbol} fund category history`, 404)
  }
  const last = bars[bars.length - 1]
  const prev = bars.length > 1 ? bars[bars.length - 2] : undefined
  const close = Number(last.close)
  const prevClose = prev ? Number(prev.close) : close
  return {
    symbol,
    name: (await fundCategoryName(db, symbol)) ?? symbol,
    last_price: close,
    prev_close: prevClose,
    open: close,
    high: close,
    low: close,
    // §72.39 asserts PLN on the quotation route; every category in this universe
    // is PLN, and stating it keeps the quote from defaulting to a no-guess null.
    currency: "PLN",
    last_timestamp: String(last.date),
  }
}

/**
 * Fetch a quote row for a route symbol, dispatching by asset class. Returns
 * the raw upstream row (equity-shaped: `last_price` etc.) — `toQuote` / the
 * price route read that shape unchanged.
 */
export async function fetchQuoteByAssetClass(
  db: DB | null,
  routeSymbol: string,
): Promise<Record<string, unknown>> {
  const symbol = routeSymbol.toUpperCase()
  let assetType = "stock"
  if (db) {
    try {
      assetType = normalizeAssetType(await assetTypeForSymbol(db, symbol))
    } catch {
      assetType = "stock"
    }
  }

  switch (assetType) {
    case "crypto": {
      // The crypto tier keys on the -USD pair; a bare stored ticker (BTC)
      // normalizes to BTC-USD (34.1: bare `BTC` 404s, `BTC-USD` 200).
      const base = venueFreeSymbol(symbol)
      const pair = base.includes("-") ? base : `${base}-USD`
      const row = await fetchCryptoQuote(pair)
      // The crypto tier reports the price under `price` (equity uses
      // `last_price`) and the bar day under `date` — normalize so toQuote
      // reuses unchanged. 45.3: the quote currency is declared from the pair
      // form (the tier only serves -USD pairs) instead of relying on toQuote's
      // no-guess null default.
      return {
        ...row,
        currency: row.currency ?? "USD",
        last_price: row.price ?? row.last_price,
        last_timestamp: row.last_timestamp ?? (typeof row.date === "string" ? row.date : undefined),
      }
    }
    case "bond":
      return fetchFixedincomeQuote(venueFreeSymbol(symbol))
    case "fund": {
      // `.TFI` funds keep the equity quote — biznesradar serves their default
      // category and NNEP65 prices correctly through it. Only the provider's own
      // (fund, category) keys divert, decided by the reference row's venue rather
      // than by a symbol shape, exactly as the history routing does.
      const tier = db ? await priceTierForSymbol(db, symbol) : "standard"
      if (tier !== "fund_category") return fetchQuote(providerSymbol(symbol))
      return fundCategoryQuote(db, symbol)
    }
    default: {
      try {
        return await fetchQuote(providerSymbol(symbol))
      } catch (e) {
        // Savings bonds have no ticker_reference row in prod (34.1: the §24.1
        // seed additions never landed) — the equity tier 404s for them. Fall
        // back to the obligacje computed close, D79-style, instead of erroring.
        if (e instanceof UpstreamError && e.status === 404 && SAVINGS_BOND.test(venueFreeSymbol(symbol))) {
          return fetchFixedincomeQuote(venueFreeSymbol(symbol))
        }
        throw e
      }
    }
  }
}
