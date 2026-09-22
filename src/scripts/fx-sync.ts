/**
 * FX sync entrypoint (plan §48.1): `npm run fx:sync` — daily incremental
 * import from frankfurter/ECB. The cluster CronJob wraps this.
 */
import { closeDb, getDb } from "../db/index.js"
import { syncDaily } from "../services/fx-import.js"

async function main() {
  const db = getDb()
  const count = await syncDaily(db)
  console.log(`[instruments] fx sync ok: ${count} rate rows in window`)
  await closeDb()
}

main().catch((err) => {
  console.error("[instruments] fx sync failed:", err?.message ?? err)
  process.exit(1)
})
