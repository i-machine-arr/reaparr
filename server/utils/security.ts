// Shared local-bypass + API-key guard for destructive/administrative routes (docs/adr/0008).
// Mirrors Sonarr/Radarr's own "Authentication Required: Disabled for Local Addresses" model rather
// than inventing a new one: requests from a private/loopback address are trusted outright (matching
// this app's existing LAN-trusted, no-session design overall — ADR-0006), anything else must supply
// the app's own API key. This does not add a session/login system — that's a separate, larger M2
// concern upstream already deferred; it closes the specific gap of a bulk-destructive action being
// reachable from outside the trusted network with zero check at all.
//
// X-Forwarded-For is never trusted blindly (that would be a CWE-346 origin-validation bypass — an
// external caller could just claim to be 127.0.0.1): a forwarded address only counts when the
// DIRECT TCP peer is itself already local, i.e. the request could only have arrived via a proxy on
// the trusted network. See resolveTrustedIp below.

import { getDb, schema } from '../db/client'
import { randomBytes } from 'node:crypto'
import { eq } from 'drizzle-orm'
import type { H3Event } from 'h3'

const API_KEY_SETTING = 'api_key'

export function getOrCreateApiKey(db: ReturnType<typeof getDb> = getDb()): string {
  const row = db.select().from(schema.appSetting).where(eq(schema.appSetting.key, API_KEY_SETTING)).get()
  if (row?.value) return row.value
  const key = randomBytes(16).toString('hex')
  db.insert(schema.appSetting).values({ key: API_KEY_SETTING, value: key })
    .onConflictDoUpdate({ target: schema.appSetting.key, set: { value: key } }).run()
  return key
}

export function regenerateApiKey(db: ReturnType<typeof getDb> = getDb()): string {
  const key = randomBytes(16).toString('hex')
  db.insert(schema.appSetting).values({ key: API_KEY_SETTING, value: key })
    .onConflictDoUpdate({ target: schema.appSetting.key, set: { value: key } }).run()
  return key
}

// RFC 1918 / loopback / link-local (full fe80::/10, not just the fe80 prefix) / unique-local
// ranges, plus their IPv4-mapped-IPv6 forms.
export function isLocalAddress(ip: string): boolean {
  const addr = ip.replace(/^::ffff:/i, '')
  if (addr === '::1' || addr === '127.0.0.1' || addr.startsWith('127.')) return true
  if (addr === '::' || /^fe[89ab][0-9a-f]:/i.test(addr) || addr.toLowerCase().startsWith('fc') || addr.toLowerCase().startsWith('fd')) return true
  if (/^10\./.test(addr)) return true
  if (/^192\.168\./.test(addr)) return true
  const m = /^172\.(\d{1,3})\./.exec(addr)
  if (m && Number(m[1]) >= 16 && Number(m[1]) <= 31) return true
  return false
}

// The actual trust decision, pulled out as a pure function so it's testable without a real H3Event:
// only trust an X-Forwarded-For value when the DIRECT TCP peer is itself local — i.e. this process
// is only reachable via a proxy on the trusted network, matching the deployment this app assumes
// (Docker + Nginx Proxy Manager on the same LAN/host, per ADR-0008). An external client can put
// anything in X-Forwarded-For, including "127.0.0.1", but they cannot fake which socket the OS
// actually accepted their TCP connection on — so a non-local direct peer is trusted as exactly what
// it is (external) regardless of what the header claims, closing the bypass a naive
// getRequestIP(event, { xForwardedFor: true }) call would allow.
export function resolveTrustedIp(directPeer: string | undefined, forwardedFor: string | undefined): string | undefined {
  if (!directPeer) return undefined
  if (!isLocalAddress(directPeer)) return directPeer // external peer stays external, header or not
  return forwardedFor || directPeer
}

// Throws (sends a 401) unless the request is from a local address or carries a valid X-Api-Key
// header matching the app's own generated key.
//
// NOTE for local testing: `nuxt dev` runs requests through Vite's dev middleware, which does not
// expose a real raw socket (getRequestIP(event) with no options returns undefined there) and can
// inject its own synthetic X-Forwarded-For for internal proxying — this guard will see no usable
// direct peer and require the API key even from localhost. This is a `nuxt dev`-only artifact, not
// a bug: verified correct against the real production build (`node .output/server/index.mjs`,
// what actually ships per the Dockerfile), where the raw socket resolves properly and local access
// works as intended. Test this guard's behavior against a build, not `nuxt dev`.
export function requireLocalOrApiKey(event: H3Event): void {
  const directPeer = getRequestIP(event) // raw socket peer — never trusts any header
  // Parsed directly rather than via getRequestIP's own xForwardedFor option, to control exactly
  // which entry is used (the first, i.e. the originating client) regardless of h3-version parsing
  // differences (a real h3 issue existed where the last entry was picked instead).
  const forwardedFor = getHeader(event, 'x-forwarded-for')?.split(',')[0]?.trim()
  const ip = resolveTrustedIp(directPeer, forwardedFor)
  if (ip && isLocalAddress(ip)) return

  const provided = getHeader(event, 'x-api-key')
  const expected = getOrCreateApiKey()
  if (provided && provided === expected) return

  throw createError({ statusCode: 401, statusMessage: 'Requires X-Api-Key for non-local requests' })
}
