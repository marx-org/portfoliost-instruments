export const CURATED_LISTING_OVERRIDES_VERSION = "2026-10-08"

export type CuratedListingOverrideRow = {
  listingKey: string
  ticker: string
  exchange: string
  quoteCurrency: string
  assetType: string
  status: "active" | "disabled"
  rationale: string
  provenance: string
}

// Keep this source reviewable and versioned. Upstream rows remain untouched.
export const CURATED_LISTING_OVERRIDES: CuratedListingOverrideRow[] = [
  {
    listingKey: "NYSE::MFC",
    ticker: "MFC",
    exchange: "NYSE",
    quoteCurrency: "USD",
    assetType: "Stock",
    status: "active",
    rationale: "MFC is quoted in USD on NYSE; do not infer CAD from its TSX listing.",
    provenance: "pfire-docs#97",
  },
]
