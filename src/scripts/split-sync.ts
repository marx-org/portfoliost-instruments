import postgres from "postgres"

type ProviderEvent = {
  symbol: string
  effectiveDate: string
  numerator: number
  denominator: number
  factor: number
  splitType?: string | null
  provider: string
}

type SplitResponse = {
  status: "confirmed" | "confirmed_empty" | "unsupported" | "unavailable" | "malformed" | "stale"
  provider: string | null
  events: ProviderEvent[]
}

const sql = postgres(process.env.DATABASE_URL ?? "postgres://portfoliost:portfoliost@postgres:5432/portfoliost")
const cacheUrl = process.env.API_CACHest_URL ?? process.env.API_CACHEST_URL ?? "http://cachest:8080"
const walletsUrl = process.env.API_WALLETS_URL ?? "http://wallets:3000"

async function fetchSplits(symbol: string): Promise<SplitResponse> {
  const res = await fetch(`${cacheUrl}/splits/${encodeURIComponent(symbol)}`, {
    signal: AbortSignal.timeout(120_000),
  })
  const body = await res.json() as SplitResponse
  if (!res.ok) throw new Error(`cachest returned ${res.status}`)
  if (res.headers.get("X-Cache-Stale-Reason")) return { ...body, status: "stale", events: [] }
  return body
}

async function recordCandidate(symbol: string, response: SplitResponse, event?: ProviderEvent) {
  const now = new Date().toISOString().slice(0, 10)
  const effectiveDate = event?.effectiveDate ?? null
  const status = event ? "pending" : "pending"
  const evidence = JSON.stringify({
    source: "split-sync",
    providerResponse: response,
    observedAt: new Date().toISOString(),
  })
  const conflictTarget = event
    ? sql`(symbol, effective_date) WHERE effective_date IS NOT NULL`
    : sql`(symbol, detected_at) WHERE effective_date IS NULL`
  const rows = await sql`
    INSERT INTO instruments.split_candidates (
      symbol, detected_at, effective_date, provider, provider_numerator,
      provider_denominator, provider_factor, provider_status, evidence, status
    ) VALUES (
      ${symbol}, ${now}, ${effectiveDate}, ${response.provider},
      ${event?.numerator ?? null}, ${event?.denominator ?? null},
      ${event?.factor ?? null}, ${response.status}, ${evidence}::jsonb, ${status}
    )
    ON CONFLICT ${conflictTarget}
    DO UPDATE SET
      provider = excluded.provider,
      provider_numerator = excluded.provider_numerator,
      provider_denominator = excluded.provider_denominator,
      provider_factor = excluded.provider_factor,
      provider_status = excluded.provider_status,
      evidence = excluded.evidence
    RETURNING status
  `
  return rows[0]?.status as string | undefined
}

async function applyConfirmed(symbol: string, event: ProviderEvent, status: string | undefined) {
  if (status === "applied" || status === "dismissed") return "skipped"
  const res = await fetch(`${walletsUrl}/internal/apply-split`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ symbol, factor: event.factor, effectiveDate: event.effectiveDate, source: `openst:${event.provider}` }),
    signal: AbortSignal.timeout(30_000),
  })
  if (!res.ok) throw new Error(`wallets returned ${res.status}: ${await res.text()}`)
  await sql`
    UPDATE instruments.split_candidates
       SET status = 'applied', applied_at = now(), reviewed_at = now(), reviewed_by = 'split-sync'
     WHERE symbol = ${symbol} AND effective_date = ${event.effectiveDate}
  `
  return "applied"
}

export async function runSplitSync() {
  const positions = await sql`
    SELECT DISTINCT symbol
      FROM portfolios.positions
     WHERE is_open = true
       AND asset_type = 'STOCK'
       AND quantity <> 0
     ORDER BY symbol
  `
  const summary = { symbols: positions.length, confirmed: 0, applied: 0, manual: 0, failed: 0 }
  for (const row of positions) {
    const symbol = String(row.symbol).toUpperCase()
    try {
      const response = await fetchSplits(symbol)
      if (response.status === "confirmed" && response.events.length > 0) {
        summary.confirmed += response.events.length
        for (const event of response.events) {
          const status = await recordCandidate(symbol, response, event)
          if (await applyConfirmed(symbol, event, status) === "applied") summary.applied++
        }
      } else {
        await recordCandidate(symbol, response)
        summary.manual++
      }
    } catch (error) {
      summary.failed++
      console.error(`[split-sync] ${symbol}:`, error)
    }
  }
  return summary
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runSplitSync()
    .then(async (summary) => { console.log(JSON.stringify(summary)); await sql.end() })
    .catch(async (error) => { console.error(error); await sql.end(); process.exitCode = 1 })
}
