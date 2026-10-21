import { createHash } from "node:crypto"
import { mkdir, readFile, stat, writeFile } from "node:fs/promises"
import path from "node:path"
import { eq } from "drizzle-orm"
import type { Context } from "hono"
import { getDb } from "../db/index.js"
import { logos } from "../db/schema.js"
import { fetchLogo } from "../adapters/cachest.js"
import { externalImageUrl } from "./internal-url.js"

function logosDir(): string {
  return path.join(process.cwd(), "data", "logos")
}
const REFRESH_MS = 30 * 24 * 60 * 60 * 1000

interface PersistedLogo {
  bytes: Buffer
  contentType: string
}

const inFlight = new Map<string, Promise<PersistedLogo | null>>()

export function initialsSvg(symbol: string): string {
  const sym = symbol.split(".")[0].toUpperCase()
  const letters = sym.slice(0, 3)
  let hash = 0
  for (const ch of sym) hash = (hash * 31 + ch.charCodeAt(0)) % 360
  return `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" rx="32" fill="hsl(${hash} 45% 40%)"/><text x="32" y="39" font-family="system-ui,sans-serif" font-size="20" font-weight="600" fill="#fff" text-anchor="middle">${letters}</text></svg>`
}

function extFor(contentType: string): string {
  if (contentType.includes("svg")) return "svg"
  if (contentType.includes("x-icon") || contentType.includes("vnd.microsoft.icon")) return "ico"
  return "png"
}

function contentTypeFor(file: string): string {
  if (file.endsWith(".svg")) return "image/svg+xml"
  if (file.endsWith(".ico")) return "image/x-icon"
  return "image/png"
}

async function download(remoteUrl: string): Promise<{ bytes: Buffer; ext: string } | null> {
  try {
    const safeUrl = externalImageUrl(remoteUrl)
    if (!safeUrl) return null
    const res = await fetch(safeUrl, { redirect: "error" })
    if (!res.ok) return null
    const buf = Buffer.from(await res.arrayBuffer())
    if (buf.length === 0) return null
    const contentType = res.headers.get("content-type") ?? "image/png"
    if (!contentType.startsWith("image/") && !contentType.includes("octet-stream")) return null
    return { bytes: buf, ext: extFor(contentType) }
  } catch {
    return null
  }
}

async function resolveAndPersist(symbol: string): Promise<PersistedLogo | null> {
  let resolution: { source: string; remote_url: string }
  try {
    resolution = await fetchLogo(symbol)
  } catch {
    return null
  }
  const downloaded = await download(resolution.remote_url)
  if (!downloaded) return null

  const canonical = symbol.toUpperCase()
  if (!/^[A-Z0-9.-]{1,30}$/.test(canonical)) return null
  const file = `${canonical}.${downloaded.ext}`
  await mkdir(logosDir(), { recursive: true })
  await writeFile(path.join(logosDir(), file), downloaded.bytes)

  const sha256 = createHash("sha256").update(downloaded.bytes).digest("hex")
  const fetchedAt = new Date()
  const values = {
    symbol: canonical,
    source: resolution.source,
    remoteUrl: resolution.remote_url,
    file,
    bytes: downloaded.bytes.length,
    sha256,
    fetchedAt,
    refreshAfter: new Date(fetchedAt.getTime() + REFRESH_MS),
  }
  await getDb()
    .insert(logos)
    .values(values)
    .onConflictDoUpdate({ target: logos.symbol, set: values })

  return { bytes: downloaded.bytes, contentType: contentTypeFor(file) }
}

interface StoredLogo extends PersistedLogo {
  stale: boolean
}

async function readStored(symbol: string): Promise<StoredLogo | null> {
  let row: typeof logos.$inferSelect | undefined
  try {
    const rows = await getDb().select().from(logos).where(eq(logos.symbol, symbol.toUpperCase())).limit(1)
    row = rows[0]
  } catch {
    return null
  }
  if (!row) return null
  try {
    if (!/^[A-Z0-9.-]{1,30}\.(?:png|svg|ico)$/.test(row.file)) return null
    const filePath = path.join(logosDir(), row.file)
    const info = await stat(filePath)
    if (!info.isFile()) return null
    return {
      bytes: await readFile(filePath),
      contentType: contentTypeFor(row.file),
      stale: row.refreshAfter.getTime() < Date.now(),
    }
  } catch {
    return null
  }
}

function refreshInBackground(symbol: string): void {
  const key = symbol.toUpperCase()
  if (inFlight.has(key)) return
  const pending = resolveAndPersist(symbol)
  inFlight.set(key, pending)
  pending.finally(() => inFlight.delete(key))
}

export async function serveLogo(ctx: Context, symbol: string): Promise<Response> {
  if (!/^[A-Za-z0-9.\-_]{1,20}$/.test(symbol)) {
    return ctx.body(null, 400)
  }

  const stored = await readStored(symbol)
  if (stored) {
    if (stored.stale) refreshInBackground(symbol)
    ctx.header("Cache-Control", "public, max-age=86400, immutable")
    return ctx.body(new Uint8Array(stored.bytes), 200, { "Content-Type": stored.contentType })
  }

  const key = symbol.toUpperCase()
  let pending = inFlight.get(key)
  if (!pending) {
    pending = resolveAndPersist(symbol)
    inFlight.set(key, pending)
    pending.finally(() => inFlight.delete(key))
  }
  const resolved = await pending

  if (!resolved) {
    ctx.header("Cache-Control", "public, max-age=3600")
    ctx.header("Content-Type", "image/svg+xml")
    return ctx.body(initialsSvg(symbol), 200)
  }

  ctx.header("Cache-Control", "public, max-age=86400, immutable")
  return ctx.body(new Uint8Array(resolved.bytes), 200, { "Content-Type": resolved.contentType })
}
