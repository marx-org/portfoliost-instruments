/** FMP crypto-search rows → yfinance `BASE-USD` pairs (D78 gap-fix, step 20.5).
 *
 * openst's `/crypto/search` is FMP-only and returns coin-venue pairs such as
 * `BTCUSD`, `TBTCUSD`, `BTC.BUSD`, `BTC2X-FLIUSD`, … — *not* the yfinance
 * pairs (`BTC-USD`) that the OHLCV/quote routes accept (fmp rejects `-` pairs,
 * yfinance is the pair authority). This module maps an FMP row to the
 * yfinance pair the rest of the stack can price, and drops wrapped / leveraged
 * / non-USD-quoted variants the row normalization cannot trust.
 */

export interface CryptoSearchResult {
  symbol: string
  name: string
}

/** Curated base-coin → yfinance pair. Typing a major's mnemonic (BTC, ETH, …)
 * must suggest the exact tradeable pair, even when the FMP row catalogue is
 * noisy (or, as with `eth`, the upstream search itself degrades). */
const CRYPTO_PRIMARY_PAIRS: Readonly<Record<string, string>> = {
  btc: "BTC-USD",
  eth: "ETH-USD",
  sol: "SOL-USD",
  xrp: "XRP-USD",
  ada: "ADA-USD",
  doge: "DOGE-USD",
  dot: "DOT-USD",
  avax: "AVAX-USD",
  link: "LINK-USD",
  ltc: "LTC-USD",
  bch: "BCH-USD",
  xlm: "XLM-USD",
  atom: "ATOM-USD",
  trx: "TRX-USD",
  etc: "ETC-USD",
  bnb: "BNB-USD",
  dai: "DAI-USD",
  usdc: "USDC-USD",
  usdt: "USDT-USD",
  uni: "UNI-USD",
  aave: "AAVE-USD",
  algo: "ALGO-USD",
  near: "NEAR-USD",
  ftm: "FTM-USD",
  matic: "POL-USD", // polygon — renamed to POL on yfinance
  pol: "POL-USD",
  sand: "SAND-USD",
  mana: "MANA-USD",
  crv: "CRV-USD",
  vet: "VET-USD",
  shib: "SHIB-USD",
  axs: "AXS-USD",
  sushi: "SUSHI-USD",
  gala: "GALA-USD",
  enj: "ENJ-USD",
  icp: "ICP-USD",
  fil: "FIL-USD",
  apt: "APT-USD",
}

const CURATED_BASES = new Set(Object.keys(CRYPTO_PRIMARY_PAIRS))

/** Quote suffixes FMP appends to a base coin, longest first so `BTCBUSD` is
 * recognised as the `BUSD` venue and not a bare `USD` ending. */
const QUOTE_SUFFIXES = ["USDT", "USDC", "BUSD", "USD", "EUR", "GBP"]

/** A base coin is a bare mnemonic when it is 3–6 plain letters — no digits,
 * dashes or wrap prefixes (tBTC, WBTC). */
const BARE_MNEMONIC = /^[A-Z]{3,6}$/

function displayName(row: Record<string, unknown>, fallback: string): string {
  const name = typeof row.name === "string" ? row.name.trim() : ""
  return name || fallback
}

/** Map one FMP search row to a yfinance `-USD` pair, or null to exclude it. */
export function normalizeCryptoRow(row: Record<string, unknown>): CryptoSearchResult | null {
  const raw = typeof row.symbol === "string" ? row.symbol.trim() : ""
  if (!raw) return null

  const venueFree = raw.toUpperCase().split(".")[0]
  for (const quote of QUOTE_SUFFIXES) {
    if (!venueFree.endsWith(quote) || venueFree.length === quote.length) continue
    const base = venueFree.slice(0, -quote.length)
    if (quote !== "USD") return null // only USD-quoted rows map to yfinance -USD
    return pairFromBase(base, row)
  }
  return null
}

function pairFromBase(base: string, row: Record<string, unknown>): CryptoSearchResult | null {
  const key = base.toLowerCase()
  const curated = CRYPTO_PRIMARY_PAIRS[key]
  if (curated) {
    return { symbol: curated, name: displayName(row, curated) }
  }
  // Bare-mnemonic fallback: reject anything that is not plain letters, and
  // reject wrapped/derivative variants that merely contain a curated major
  // (TBTC, WBTC, RENBTC, …) — FMP only emits those as fakes of the real coin.
  if (!BARE_MNEMONIC.test(base)) return null
  for (const curatedKey of CURATED_BASES) {
    if (key.endsWith(curatedKey)) return null
  }
  const pair = `${base}-USD`
  return { symbol: pair, name: displayName(row, pair) }
}

/** The exact-pair suggestion for a bare base-coin query (BTC → BTC-USD). */
export function curatedPairFromQuery(query: string): CryptoSearchResult | null {
  const key = query.trim().toLowerCase()
  const pair = CRYPTO_PRIMARY_PAIRS[key]
  if (!pair) return null
  return { symbol: pair, name: pair }
}

/** Normalize a batch of FMP rows, drop the ones that do not map cleanly. */
export function normalizeCryptoRows(rows: Array<Record<string, unknown>>): CryptoSearchResult[] {
  const out: CryptoSearchResult[] = []
  for (const row of rows ?? []) {
    const hit = normalizeCryptoRow(row)
    if (hit) out.push(hit)
  }
  return out
}