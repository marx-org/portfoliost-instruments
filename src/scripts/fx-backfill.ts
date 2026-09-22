/**
 * FX backfill entrypoint (plan §48.1): `npm run fx:backfill [start]` — one-shot
 * deep historical import from frankfurter/ECB. Defaults to 1999-01-04 (earliest
 * ECB reference rate). Idempotent via upsert on (rate_date, currency).
 */
import { closeDb, getDb } from "../db/index.js"
import { DEFAULT_HISTORY_START, importHistory } from "../services/fx-import.js"

const start = process.argv[2] ?? DEFAULT_HISTORY_START

async function main() {
  const db = getDb()
  const count = await importHistory(db, { start })
  console.log(`[instruments] fx backfill ok: ${count} rate rows since ${start}`)
  await closeDb()
}

main().catch((err) => {
  console.error("[instruments] fx backfill failed:", err?.message ?? err)
  process.exit(1)
})
