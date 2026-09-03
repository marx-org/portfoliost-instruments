/**
 * price-data-architecture H10 — post-import hook.
 *
 * Called by the admin service (POST /api/instruments/internal/stooq-imported)
 * after a stooq import job completes. Cleans up overflow rows that are now
 * superseded by the freshly imported stooq data, dismisses pending split
 * candidates for covered symbols, and writes the result to admin.job_run.
 */
import { sql } from "drizzle-orm"
import type { DB } from "../db/index.js"

export type StooqDataset =
  | "daily_us"
  | "daily_pl"
  | "daily_jp"
  | "daily_world"
  | "daily_uk"
  | "daily_hk"
  | "daily_hu"
  | "daily_macro"

/** Return the instruments table name for a dataset. */
export function tableForDataset(dataset: StooqDataset): string {
  return `stooq_${dataset}`
}

/**
 * For the US dataset tickers carry a .US suffix that is stripped to the
 * system symbol. For all other datasets the ticker IS the system symbol.
 */
export function isUsDataset(dataset: StooqDataset): boolean {
  return dataset === "daily_us"
}

export interface HookResult {
  dataset: StooqDataset
  latestDate: string | null
  rowsDeleted: number
  candidatesDismissed: number
}

/**
 * Run the post-import cleanup for one dataset.
 *
 * 1. Query MAX(date) from the stooq table for this dataset.
 * 2. Derive the set of covered system symbols (strip .US for US, passthrough otherwise).
 * 3. Delete price_bars overflow rows up to MAX(date) for covered symbols.
 * 4. Delete split_adjustments for covered symbols up to MAX(date).
 * 5. Auto-dismiss pending split_candidates for covered symbols.
 * 6. Write latestDate + rowsDeleted back to admin.job_run.
 *
 * Never throws — errors are caught and returned as { rowsDeleted: 0 }.
 */
export async function runPostImportHook(
  db: DB,
  dataset: StooqDataset,
  jobName: string,
): Promise<HookResult> {
  const table = tableForDataset(dataset)
  const us = isUsDataset(dataset)

  try {
    // 1. MAX(date) from the stooq table
    const maxResult = await db.execute(sql.raw(`
      SELECT MAX(date)::text AS max_date FROM instruments.${table}
    `))
    const rows = (maxResult.rows ?? maxResult) as Array<{ max_date: string | null }>
    const latestDate = rows[0]?.max_date ?? null
    if (!latestDate) {
      return { dataset, latestDate: null, rowsDeleted: 0, candidatesDismissed: 0 }
    }

    // 2. Covered symbols: for US strip .US suffix; otherwise ticker is symbol.
    //    We operate directly via SQL subqueries to avoid pulling symbol lists
    //    into application memory (tables can be large).
    const symbolExpr = us
      ? `REPLACE(ticker, '.US', '')`
      : `ticker`

    // 3. Delete overflow rows superseded by the fresh stooq data
    const delResult = await db.execute(sql.raw(`
      DELETE FROM instruments.price_bars
      WHERE date <= '${latestDate}'
        AND symbol IN (
          SELECT DISTINCT ${symbolExpr} FROM instruments.${table}
        )
    `))
    const rowsDeleted =
      (delResult as { affectedRows?: number; rowCount?: number }).affectedRows ??
      (delResult as { affectedRows?: number; rowCount?: number }).rowCount ??
      0

    // 4. Delete split_adjustments that are now superseded
    await db.execute(sql.raw(`
      DELETE FROM instruments.split_adjustments
      WHERE detected_at <= '${latestDate}'
        AND symbol IN (
          SELECT DISTINCT ${symbolExpr} FROM instruments.${table}
        )
    `))

    // 5. Auto-dismiss pending split_candidates for covered symbols
    const dismissResult = await db.execute(sql.raw(`
      UPDATE instruments.split_candidates
      SET status = 'dismissed'
      WHERE status = 'pending'
        AND symbol IN (
          SELECT DISTINCT ${symbolExpr} FROM instruments.${table}
        )
    `))
    const candidatesDismissed =
      (dismissResult as { affectedRows?: number; rowCount?: number }).affectedRows ??
      (dismissResult as { affectedRows?: number; rowCount?: number }).rowCount ??
      0

    // 6. Write back to admin.job_run (best-effort — admin schema on same DB)
    await db.execute(sql.raw(`
      UPDATE admin.job_run
      SET latest_date  = '${latestDate}',
          rows_deleted = ${rowsDeleted},
          updated_at   = now()
      WHERE name = '${jobName.replace(/'/g, "''")}'
    `)).catch(() => undefined)

    return { dataset, latestDate, rowsDeleted, candidatesDismissed }
  } catch (err) {
    console.error(`[stooq-import-hook] dataset=${dataset}`, err)
    return { dataset, latestDate: null, rowsDeleted: 0, candidatesDismissed: 0 }
  }
}
