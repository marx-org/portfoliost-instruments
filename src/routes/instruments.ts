import { z } from "zod"
import { openApi } from "hono-zod-openapi"
import { Hono } from "hono"
import { userIdentityMiddleware } from "../auth.js"
import { SymbolSummarySchema, ErrorResponseSchema } from "../schemas/instruments.js"

export function createInstrumentsRoutes() {
  const instruments = new Hono()
  instruments.use("*", userIdentityMiddleware)

  instruments.get(
    "/symbols",
    openApi({
      tags: ["Instruments"],
      summary: "List tracked symbols",
      operationId: "listSymbols",
      responses: {
        200: {
          description: "Symbols currently tracked by the module",
          content: {
            "application/json": {
              schema: z.object({ symbols: z.array(SymbolSummarySchema) }),
            },
          },
        },
        401: {
          description: "Unauthorized",
          content: { "application/json": { schema: ErrorResponseSchema } },
        },
      },
    }),
    (c) => c.json({ symbols: [] }),
  )

  return instruments
}
