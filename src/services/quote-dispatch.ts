/**
 * Plan 34 — asset-class-aware quote dispatch.
 *
 * D81 already routes price-bars OHLCV by `ticker_reference.asset_type`; this
 * extends the same dispatch to the current-price path (`/:symbol/quote` and
 * `/:symbol/price`). Per class (34.1 probe results):
 *
 *   crypto    → cachest /crypto/quote/{pair}          (pair form, e.g. BTC-USD)
 *   bond      → cachest /fixedincome/quote/{symbol}   (obligacje computed close)
 *   everything else (stock/etf/corp_bond/fund) → the existing equity
 *   /equity/quote — verified in 34.1 to serve corp_bond (BST0327 bare or .WA)
 *   and fund (.TFI) symbols through the openst biznesradar dispatch.
 *
 * The asset-type lookup degrades to `stock` (today's behavior) when the DB is
 * unavailable or the symbol is unlisted — a dispatch hiccup must never break
 * the quote.
 */
import type { DB } from "../db/index.js"
import { assetTypeForSymbol, normalizeAssetType } from "../db/tickerref-queries.js"
import { fetchQuote, fetchCryptoQuote, fetchFixedincomeQuote } from "../adapters/cachest.js"
import { UpstreamError } from "../adapters/cachest.js"
import { providerSymbol, venueFreeSymbol } from "../adapters/symbol.js"

/** Retail savings-bond emission codes (ROD/EDO + 4 digits). These are never
 * exchange-listed, so the equity tier 404s for them and the obligacje engine
 * is their price source (D79 precedent: fetchOhlcvWithBondFallback). */
const SAVINGS_BOND = /^(ROD|EDO)\d{4}$/

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
