import { createHash, timingSafeEqual } from "node:crypto"
import { Context, Next } from "hono"
import * as jose from "jose"

export interface UserIdentity {
  id: string
  email: string
  firstName: string
  lastName: string
  avatarUrl: string | null
  groups: string[]
}

declare module "hono" {
  interface ContextVariableMap {
    userIdentity: UserIdentity
    /** §63.10 — set when the request presented a valid service token. No
     * `userIdentity` is fabricated for a service caller, so `requireGroup`
     * cannot be satisfied by one. */
    serviceCaller: boolean
  }
}

interface AuthConfig {
  issuerUrl: string
  jwksUri: string
  audience: string
}

let jwks: jose.JWTVerifyGetKey | null = null

async function getJwks(config: AuthConfig): Promise<jose.JWTVerifyGetKey> {
  if (!jwks) {
    jwks = await jose.createRemoteJWKSet(new URL(config.jwksUri))
  }
  return jwks
}

export async function validateJwt(c: Context, next: Next) {
  const issuerUrl = c.req.header("X-Auth-Issuer") || process.env.POCKETID_ISSUER_URL
  const audience = c.req.header("X-Auth-Audience") || process.env.POCKETID_AUDIENCE || "portfoliost"
  const jwksUri = issuerUrl ? `${issuerUrl}/.well-known/jwks.json` : undefined

  if (!issuerUrl || !jwksUri) {
    return c.json({ error: "Unauthorized", message: "OIDC not configured" }, 401)
  }

  const authHeader = c.req.header("Authorization")
  if (!authHeader?.startsWith("Bearer ")) {
    return c.json({ error: "Unauthorized", message: "Missing or invalid Authorization header" }, 401)
  }

  const token = authHeader.slice(7)

  try {
    const key = await getJwks({ issuerUrl, jwksUri, audience })
    const { payload } = await jose.jwtVerify(token, key, {
      issuer: issuerUrl,
      audience,
    })

    c.set("userIdentity", {
      id: payload.sub!,
      email: payload.email as string,
      firstName: (payload.given_name as string) || "",
      lastName: (payload.family_name as string) || "",
      avatarUrl: (payload.picture as string) || null,
      groups: (payload.groups as string[]) || [],
    })

    await next()
  } catch (error) {
    return c.json({ error: "Unauthorized", message: "Invalid or expired token" }, 401)
  }
}

// Flexible middleware: supports both X-User-* headers (Docker Compose) and JWT (cluster)
export async function userIdentityMiddleware(c: Context, next: Next) {
  // Check if JWT validation is enabled
  if (process.env.POCKETID_ISSUER_URL) {
    return validateJwt(c, next)
  }

  // Fallback to X-User-* headers (Docker Compose with mock)
  const id = c.req.header("X-User-Id")
  const email = c.req.header("X-User-Email")
  if (id && email) {
    c.set("userIdentity", {
      id,
      email,
      firstName: c.req.header("X-User-FirstName") ?? "",
      lastName: c.req.header("X-User-LastName") ?? "",
      avatarUrl: c.req.header("X-User-AvatarUrl") || null,
      groups: c.req.header("X-User-Groups")?.split(",") || ["portfoliost_admin"],
    })
    await next()
    return
  }

  // Dev-only fallback: with the mock IdP there is no signature to verify and
  // the SPA only sends a bearer token. Derive a stable identity from its
  // claims when decodable, else from the token itself. Never reached in the
  // cluster, where POCKETID_ISSUER_URL forces strict validation above.
  const authHeader = c.req.header("Authorization")
  if (authHeader?.startsWith("Bearer ")) {
    const token = authHeader.slice(7)
    const claims = tryDecodeJwtPayload(token)
    c.set("userIdentity", {
      id: typeof claims?.sub === "string" && claims.sub ? claims.sub : `mock-${token.slice(0, 12)}`,
      email: typeof claims?.email === "string" && claims.email ? claims.email : "dev@localhost",
      firstName: typeof claims?.given_name === "string" ? claims.given_name : "",
      lastName: typeof claims?.family_name === "string" ? claims.family_name : "",
      avatarUrl: null,
      groups: ["portfoliost_admin"],
    })
    await next()
    return
  }

  return c.json({ error: "Unauthorized", message: "Missing user identity" }, 401)
}

function tryDecodeJwtPayload(token: string): Record<string, unknown> | null {
  const parts = token.split(".")
  if (parts.length !== 3) return null
  try {
    const json = atob(parts[1].replace(/-/g, "+").replace(/_/g, "/"))
    return JSON.parse(json) as Record<string, unknown>
  } catch {
    return null
  }
}

/**
 * §63.10 — a second accepted credential: a **service token**, an opaque shared
 * secret in `X-Service-Token`, for in-cluster callers that are not a user.
 *
 * The one that motivated it is `portfoliost-wallets`' scheduled snapshot sweep.
 * A user JWT is the wrong credential for it by construction: the sweep iterates
 * every portfolio of every user, so it has no single user context to present.
 * Forcing it through a user token guaranteed it could only ever refresh one
 * user's data — and because `fetchPriceBars` collapsed the resulting 401 into
 * "no price history", it silently wrote cash-only snapshots for the whole fleet
 * twice a day.
 *
 * Deliberately **not** an alternative way to be a user:
 * - It fabricates no `userIdentity`, so `requireGroup` cannot be satisfied by it.
 *   The admin surfaces stay user-only.
 * - It fails **closed**: with `INSTRUMENTS_SERVICE_TOKEN` unset, a service token
 *   is rejected rather than accepted, so a missing secret can never open the door.
 *   (Contrast the dev fallbacks above, which are only reached when
 *   `POCKETID_ISSUER_URL` is unset — never in the cluster.)
 *
 * Timing-safe compare, and the token is never logged or echoed.
 */
export function serviceTokenMatches(presented: string | undefined, expected: string | undefined) {
  if (!expected) return false
  if (!presented) return false
  const a = Buffer.from(presented)
  const b = Buffer.from(expected)
  // timingSafeEqual throws on a length mismatch, which would itself leak length;
  // hash both sides to a fixed width first.
  const ha = createHash("sha256").update(a).digest()
  const hb = createHash("sha256").update(b).digest()
  return timingSafeEqual(ha, hb)
}

/** Whether this request presented a valid service token (marker for handlers). */
export function isServiceCaller(c: Context): boolean {
  return c.get("serviceCaller") === true
}

/**
 * Gate for instruments' data routes: a valid **service token** OR a valid **user
 * JWT**. Neither is optional — this chain (instruments → cachest → openst →
 * provider keys) has no other authentication, and pfire has no edge auth
 * (`global-auth-url` is commented out in the ingress-nginx chart), so this
 * middleware is the only thing in front of the provider tier.
 *
 * Used by every route that returns global reference data. None of those handlers
 * reads `userIdentity` — instruments has no `user_id` column anywhere and every
 * response is a pure function of the URL — but authenticating the *caller* is
 * still what keeps the chain closed, and it is what the sweep needs to work.
 */
export async function serviceOrUserMiddleware(c: Context, next: Next) {
  const presented = c.req.header("X-Service-Token")
  if (presented) {
    if (!serviceTokenMatches(presented, process.env.INSTRUMENTS_SERVICE_TOKEN)) {
      return c.json({ error: "Unauthorized", message: "Invalid service token" }, 401)
    }
    c.set("serviceCaller", true)
    await next()
    return
  }
  return userIdentityMiddleware(c, next)
}

export function requireGroup(group: string) {
  return async (c: Context, next: Next) => {
    const identity = c.get("userIdentity")
    if (!identity?.groups?.includes(group)) {
      return c.json({ error: "Forbidden", message: `Required group: ${group}` }, 403)
    }
    await next()
  }
}
