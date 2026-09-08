import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { sql } from "drizzle-orm"
import { createTestDb } from "./test-db.js"
import type { DB } from "./index.js"
import { newsArticles } from "./schema.js"

describe("news_articles schema (N3)", () => {
  let db: DB
  let client: Awaited<ReturnType<typeof createTestDb>>["client"]

  beforeAll(async () => {
    const t = await createTestDb()
    db = t.db
    client = t.client
  })

  afterAll(async () => {
    await client.close()
  })

  it("creates the news_articles table via migration", async () => {
    const rows = await db.execute(
      sql`select to_regclass('instruments.news_articles') as rel`,
    )
    expect(rows.rows[0]?.rel).not.toBeNull()
  })

  it("creates the symbols GIN index", async () => {
    const rows = await db.execute(sql`
      select indexname
      from pg_indexes
      where schemaname = 'instruments' and tablename = 'news_articles'
        and indexname = 'idx_news_symbols'
    `)
    expect(rows.rows).toHaveLength(1)
    const def = await db.execute(sql`
      select indexdef
      from pg_indexes
      where schemaname = 'instruments' and indexname = 'idx_news_symbols'
    `)
    expect(String(def.rows[0]?.indexdef)).toMatch(/USING gin/)
  })

  it("creates the published_at DESC and expires_at indexes", async () => {
    const rows = await db.execute(sql`
      select indexname
      from pg_indexes
      where schemaname = 'instruments' and tablename = 'news_articles'
        and indexname in ('idx_news_published', 'idx_news_expires')
      order by indexname
    `)
    expect(rows.rows.map((r: { indexname: string }) => r.indexname)).toEqual([
      "idx_news_expires",
      "idx_news_published",
    ])
  })

  it("stores articles deduped by url and queryable by symbol via GIN", async () => {
    const now = new Date("2026-09-08T10:00:00Z")
    const expiresAt = new Date(now.getTime() + 90 * 86_400_000)
    const row = {
      url: "https://example.com/aaple-news",
      title: "Apple bets on AR",
      summary: "…",
      source: "polygon",
      publishedAt: new Date("2026-09-08T09:15:00Z"),
      symbols: ["AAPL", "MSFT"],
      expiresAt,
    }
    await db.insert(newsArticles).values(row)
    await db
      .insert(newsArticles)
      .values(row)
      .onConflictDoNothing()

    const all = await db.select().from(newsArticles)
    expect(all).toHaveLength(1)

    const forSymbol = await db.select().from(newsArticles).where(
      sql`${newsArticles.symbols} @> ARRAY['AAPL']::text[]`,
    )
    expect(forSymbol).toHaveLength(1)
    expect(forSymbol[0]).toMatchObject({ url: row.url, title: row.title })
  })

  it("defaults fetched_at to now", async () => {
    const before = new Date()
    await db.insert(newsArticles).values({
      url: "https://example.com/other",
      title: "Other news",
      publishedAt: new Date(),
      symbols: ["MSFT"],
      expiresAt: new Date(),
    })
    const [row] = await db
      .select({ fetchedAt: newsArticles.fetchedAt })
      .from(newsArticles)
      .where(sql`${newsArticles.url} = 'https://example.com/other'`)
    expect(row?.fetchedAt).toBeInstanceOf(Date)
    expect(row!.fetchedAt.getTime()).toBeGreaterThanOrEqual(before.getTime())
  })
})