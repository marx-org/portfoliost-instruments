import { z } from "zod"

export const SymbolSummarySchema = z.object({
  symbol: z.string(),
  name: z.string().optional(),
  exchange: z.string().optional(),
})

export const ErrorResponseSchema = z.object({
  error: z.string(),
  message: z.string(),
})

export const SearchResultSchema = z.object({
  symbol: z.string().optional(),
  name: z.string().optional(),
  type: z.string().optional(),
  exchange: z.string().optional(),
  source: z.string().optional(),
})

export const InstrumentSearchResponseSchema = z.object({
  count: z.number().optional(),
  results: z.array(SearchResultSchema).optional(),
})

export const InstrumentDetailSchema = z.object({
  id: z.string().optional(),
  symbol: z.string().optional(),
  name: z.string().optional(),
  exchange: z.string().optional(),
  type: z.string().optional(),
  currency: z.string().optional(),
})

export const InstrumentProfileSchema = z.looseObject({
  ticker: z.string().optional(),
  name: z.string().nullish(),
  country: z.string().nullish(),
  currency: z.string().nullish(),
  exchange: z.string().nullish(),
  finnhubIndustry: z.string().nullish(),
  ipo: z.string().nullish(),
  logo: z.string().nullish(),
  marketCapitalization: z.number().nullish(),
  marketCapCurrency: z.string().nullish(),
  marketcapUSD: z.number().nullish(),
  phone: z.string().nullish(),
  shareOutstanding: z.number().nullish(),
  weburl: z.string().nullish(),
  description: z.string().nullish(),
  gicsSector: z.string().nullish(),
  gicsIndustryGroup: z.string().nullish(),
  gicsIndustry: z.string().nullish(),
  gicsSubIndustry: z.string().nullish(),
  address: z.string().nullish(),
  city: z.string().nullish(),
  state: z.string().nullish(),
  employeeTotal: z.number().nullish(),
  ceo: z.string().nullish(),
})

export const QuoteSchema = z.object({
  symbol: z.string(),
  currentPrice: z.number(),
  highPrice: z.number(),
  lowPrice: z.number(),
  openPrice: z.number(),
  previousClose: z.number(),
  change: z.number(),
  percentChange: z.number(),
  timestamp: z.number(),
  marketSession: z.string(),
  timezone: z.string(),
  bid: z.number(),
  ask: z.number(),
  bidSize: z.number(),
  askSize: z.number(),
  currency: z.string(),
  regularMarketPrice: z.number(),
  extendedHoursChange: z.number(),
  extendedHoursChangePercent: z.number(),
  marketSessionPhase: z.string(),
  source: z.string(),
  asOf: z.number(),
})

export const PriceHistorySchema = z.object({
  symbol: z.string(),
  closePrices: z.array(z.number()),
  highPrices: z.array(z.number()).optional(),
  lowPrices: z.array(z.number()).optional(),
  openPrices: z.array(z.number()).optional(),
  volumes: z.array(z.number()).optional(),
  timestamps: z.array(z.number()),
  status: z.string().optional(),
  currency: z.string().optional(),
})

export const PriceTargetSchema = z.object({
  symbol: z.string().optional(),
  targetHigh: z.number().optional(),
  targetLow: z.number().optional(),
  targetMean: z.number().optional(),
  targetMedian: z.number().optional(),
  numberAnalysts: z.number().optional(),
  lastUpdated: z.string().optional(),
})

export const InstrumentMetricsSchema = z.looseObject({
  metrics: z
    .object({
      symbol: z.string().optional(),
      metricType: z.string().optional(),
      metric: z.record(z.string(), z.unknown()).optional(),
    })
    .optional(),
  priceTarget: PriceTargetSchema.optional(),
  trailingValuation: z.record(z.string(), z.unknown()).optional(),
  margins: z.record(z.string(), z.unknown()).optional(),
  capitalEfficiency: z.record(z.string(), z.unknown()).optional(),
  financialHealth: z.record(z.string(), z.unknown()).optional(),
  perShare: z.record(z.string(), z.unknown()).optional(),
})

export const InstrumentOverviewMetricsSchema = z.looseObject({
  symbol: z.string().optional(),
  marketCap: z.number().nullish(),
  enterpriseValue: z.number().nullish(),
  sharesOutstanding: z.number().nullish(),
  revenue: z.number().nullish(),
  employees: z.number().nullish(),
  cash: z.number().nullish(),
  netDebt: z.number().nullish(),
})
