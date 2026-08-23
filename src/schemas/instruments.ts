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
