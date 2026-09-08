import { Hono } from "hono"
import { logger } from "hono/logger"
import { createInstrumentsRoutes } from "./routes/instruments.js"
import { createDoc } from "./doc.js"
import { validateJwt } from "./auth.js"
import { moduleMeta } from "./meta.js"
import { serveLogo } from "./services/logos.js"
import { providerSymbol } from "./adapters/symbol.js"
import { getDb } from "./db/index.js"
import { runPostImportHook } from "./services/stooq-import-hook.js"
import type { StooqDataset } from "./services/stooq-import-hook.js"

const VALID_DATASETS = new Set([
  "daily_us", "daily_pl", "daily_jp", "daily_world",
  "daily_uk", "daily_hk", "daily_hu", "daily_macro",
])

const app = new Hono()

app.use("*", logger())

app.get("/health", (c) => c.json({ status: "ok" }))

// D4 — module identity/verification endpoint
app.get("/__meta", (c) => c.json(moduleMeta()))

// Logos are consumed via <img> tags (no Authorization header possible) and
// carry no user data — auth-exempt by design; initials fallback keeps 200s.
app.get("/api/logos/:symbol", (c) => serveLogo(c, providerSymbol(c.req.param("symbol"))))
app.get("/logos/:symbol", (c) => serveLogo(c, providerSymbol(c.req.param("symbol"))))

// D9 — edge auth preflight: 204 when the bearer token validates, 401 otherwise
app.get("/internal/verify", validateJwt, (c) => c.body(null, 204))

// H10 — post-import hook: called by admin after a stooq import job completes.
// Cleans up superseded overflow rows and writes the result to admin.job_run.
app.post("/internal/stooq-imported", async (c) => {
  let body: { dataset?: string; jobName?: string }
  try { body = await c.req.json() } catch { return c.json({ error: "Invalid JSON" }, 400) }
  const { dataset, jobName } = body
  if (!dataset || !VALID_DATASETS.has(dataset)) {
    return c.json({ error: "Invalid or missing dataset" }, 400)
  }
  if (!jobName || typeof jobName !== "string") {
    return c.json({ error: "jobName is required" }, 400)
  }
  const result = await runPostImportHook(getDb(), dataset as StooqDataset, jobName)
  return c.json(result)
})

const api = new Hono()
api.route("/instruments", createInstrumentsRoutes())

const doc = createDoc(api)
app.get("/api/doc", (c) => c.json(doc))
app.route("/api", api)

export default app
