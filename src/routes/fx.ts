import { Hono, type Context } from "hono"
import { sql, asc, desc, and, eq, gte, lte } from "drizzle-orm"
import { CURRENCIES } from "@marx2/contracts/currencies"
import { crossRate } from "@marx2/contracts/fx"
import { z } from "zod"
import { openApi } from "hono-zod-openapi"
import { userIdentityMiddleware, requireGroup } from "../auth.js"
import { getDb, type DB } from "../db/index.js"
import { fxRates } from "../db/schema.js"
import { distinctRateDatesBefore, ratesTableForDate } from "../db/fx-rates.js"
import type { components } from "../generated/api-types.js"

type CurrenciesResponse = components["schemas"]["CurrenciesResponse"]
type AdminFxRatesResponse = components["schemas"]["AdminFxRatesResponse"]

const CURRENCIES_SCHEMA = z.object({
  currencies: z.array(
    z.object({
      code: z.string(),
      name: z.string(),
      symbol: z.string(),
      minorUnits: z.number(),
      popular: z.boolean(),
    }),
  ),
})

/**
 * FX endpoints moved here with the fx_rates table (plan §48.3): the
 * availability SoT is the table itself (D26), so the registry, the SPA
 * resolved-rate lookup, the service-to-service pair lookup and the admin
 * listing all follow the data into the instruments module.
 */

/**
 * Available-currencies registry (fees-and-custom-fx D26): availability SoT is
 * the fx_rates table — we support exactly the currencies we import rates for;
 * the set refreshes automatically on every daily import. Display metadata
 * comes from the contracts catalog.
 */
async function currenciesPayload(db: DB) {
  const result = await db.execute(sql`select distinct currency from instruments.fx_rates order by currency`)
  const list = (Array.isArray(result) ? result : (result as unknown as { rows: { currency: string }[] }).rows) as {
    currency: string
  }[]
  const codes = new Set<string>(["EUR", ...list.map((r) => String(r.currency))])
  return {
    currencies: [...codes].map((code) => {
      const meta = CURRENCIES.find((c) => c.code === code)
      return {
        code,
        name: meta?.name ?? code,
        symbol: meta?.symbol ?? code,
        minorUnits: meta?.minorUnits ?? 2,
        popular: meta?.popular ?? false,
      }
    }),
  }
}

/** Internal cross-module rate lookup (D20): ?date=&from=&to= — resolved
 * pair rate with carry-forward over dated tables (D39: weekends, holidays
 * and sync gaps resolve to the last known rate). */
async function internalRate(c: Context, db: DB) {
  const from = String(c.req.query("from") ?? "").toUpperCase()
  const to = String(c.req.query("to") ?? "EUR").toUpperCase()
  const date = c.req.query("date")
  if (!/^[A-Z]{3}$/.test(from) || !/^[A-Z]{3}$/.test(to)) {
    return c.json({ error: "ValidationError", message: "from/to must be ISO 4217 codes" }, 422)
  }

  const asOf = date ?? new Date().toISOString().slice(0, 10)
  const dates = await distinctRateDatesBefore(db, asOf, 10)
  for (const d of dates) {
    const rate = crossRate(from, to, await ratesTableForDate(db, d))
    if (rate !== undefined) return c.json({ rate, asOf: d })
  }

  const message = date
    ? `No rate ${from}->${to} on or before ${date}`
    : `No rate ${from}->${to} within staleness window`
  return c.json({ error: "NotFound", message }, 404)
}

const FX_LATEST_RESPONSES = {
  200: {
    description: "Resolved rate",
    content: { "application/json": { schema: z.object({ rate: z.number(), asOf: z.string() }) } },
  },
  404: {
    description: "Not found",
    content: {
      "application/json": {
        schema: z.object({ error: z.string(), message: z.string() }),
      },
    },
  },
  422: {
    description: "Validation error",
    content: {
      "application/json": {
        schema: z.object({ error: z.string(), message: z.string() }),
      },
    },
  },
} as const

export function createFxRoutes(db?: DB) {
  const routes = new Hono()
  const getDbInstance = () => db ?? getDb()

  routes.get(
    "/currencies",
    openApi({
      tags: ["FX"],
      summary: "Available currencies (availability SoT: instruments.fx_rates, D26)",
      operationId: "getCurrencies",
      responses: {
        200: {
          description: "Currency registry",
          content: { "application/json": { schema: CURRENCIES_SCHEMA } },
        },
      },
    }),
    async (c) => {
      return c.json(await currenciesPayload(getDbInstance()) satisfies CurrenciesResponse)
    },
  )

  // SPA-facing resolved rate (fees-and-custom-fx D28/D30 UI): automatic value
  // shown in dialogs, custom inputs pre-filled from it.
  routes.get(
    "/fx/latest",
    openApi({
      tags: ["FX"],
      summary: "Resolved automatic rate for a currency pair (carry-forward)",
      operationId: "getFxLatest",
      parameters: [
        { name: "from", in: "query", required: true, schema: { type: "string" } },
        { name: "to", in: "query", required: true, schema: { type: "string" } },
        { name: "date", in: "query", schema: { type: "string", format: "date" } },
      ],
      responses: { ...FX_LATEST_RESPONSES, 401: { description: "Unauthorized" } },
    }),
    userIdentityMiddleware,
    async (c) => internalRate(c, getDbInstance()),
  )

  // service-to-service (settlement + one-off lookups, plan §48.3)
  routes.get(
    "/internal/fx-rates",
    openApi({
      tags: ["FX"],
      summary: "Internal pair rate lookup (service-to-service)",
      operationId: "getInternalFxRates",
      parameters: [
        { name: "from", in: "query", required: true, schema: { type: "string" } },
        { name: "to", in: "query", required: true, schema: { type: "string" } },
        { name: "date", in: "query", schema: { type: "string", format: "date" } },
      ],
      responses: { ...FX_LATEST_RESPONSES, 401: { description: "Unauthorized" } },
    }),
    userIdentityMiddleware,
    async (c) => internalRate(c, getDbInstance()),
  )

  // D47 — admin-facing FX rates listing (moved with the table, plan §48.3)
  routes.get(
    "/admin/fx-rates",
    openApi({
      tags: ["FX"],
      summary: "Admin FX rates listing (paginated)",
      operationId: "getAdminFxRates",
      parameters: [
        { name: "page", in: "query", schema: { type: "integer" } },
        { name: "per_page", in: "query", schema: { type: "integer" } },
        { name: "sort_by", in: "query", schema: { type: "string" } },
        { name: "sort_dir", in: "query", schema: { type: "string" } },
        { name: "base_currency", in: "query", schema: { type: "string" } },
        { name: "quote_currency", in: "query", schema: { type: "string" } },
        { name: "date_from", in: "query", schema: { type: "string", format: "date" } },
        { name: "date_to", in: "query", schema: { type: "string", format: "date" } },
      ],
      responses: { 200: { description: "FX rates page" } },
    }),
    userIdentityMiddleware,
    requireGroup("portfoliost_admin"),
    async (c) => {
      const d = getDbInstance()
      const page = Math.max(1, parseInt(c.req.query("page") ?? "1", 10))
      const perPage = Math.min(200, Math.max(1, parseInt(c.req.query("per_page") ?? "50", 10)))
      const sortBy = c.req.query("sort_by") ?? "date"
      const sortDir = c.req.query("sort_dir") === "asc" ? "asc" : "desc"
      const baseCurrency = c.req.query("base_currency")
      const quoteCurrency = c.req.query("quote_currency")
      const dateFrom = c.req.query("date_from")
      const dateTo = c.req.query("date_to")

      const conditions = []
      // All rows are EUR-based (D21/D25): quote is the stored currency column,
      // base decoding happens on read. Non-EUR base matches nothing.
      if (baseCurrency && baseCurrency.toUpperCase() !== "EUR") conditions.push(sql`false`)
      if (quoteCurrency) conditions.push(eq(fxRates.currency, quoteCurrency.toUpperCase()))
      if (dateFrom) conditions.push(gte(fxRates.rateDate, dateFrom))
      if (dateTo) conditions.push(lte(fxRates.rateDate, dateTo))

      const where = conditions.length > 0 ? and(...conditions) : undefined

      const countResult = await d.execute(
        sql`SELECT COUNT(*) as count FROM instruments.fx_rates ${where ? sql`WHERE ${where}` : sql``}`,
      )
      const countRows = (Array.isArray(countResult) ? countResult : (countResult as unknown as { rows: { count: string }[] }).rows) as {
        count: string
      }[]
      const total = parseInt(countRows[0]?.count ?? "0", 10)
      const totalPages = Math.ceil(total / perPage)

      // Sort column mapping
      const sortColumn = sortBy === "base_currency" ? fxRates.currency : sortBy === "rate" ? fxRates.rate : fxRates.rateDate
      const orderFn = sortDir === "asc" ? asc : desc

      const offset = (page - 1) * perPage
      const rows = await d.execute(
        sql`SELECT rate_date, currency, rate FROM instruments.fx_rates
            ${where ? sql`WHERE ${where}` : sql``}
            ORDER BY ${orderFn(sortColumn)}
            LIMIT ${perPage} OFFSET ${offset}`,
      )
      const items = (Array.isArray(rows) ? rows : (rows as unknown as { rows: Record<string, unknown>[] }).rows).map(
        (r) => ({
          date: String(r.rate_date),
          baseCurrency: "EUR",
          quoteCurrency: String(r.currency),
          rate: parseFloat(String(r.rate)),
        }),
      )

      const body: AdminFxRatesResponse = {
        items,
        pagination: { total, page, per_page: perPage, total_pages: totalPages },
      }
      return c.json(body)
    },
  )

  return routes
}
