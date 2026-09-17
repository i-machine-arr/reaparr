// Shared local-bypass + API-key guard for destructive/administrative routes (docs/adr/0008).
// Mirrors Sonarr/Radarr's own "Authentication Required: Disabled for Local Addresses" model rather
// than inventing a new one: requests from a private/loopback address are trusted outright (matching
// this app's existing LAN-trusted, no-session design overall — ADR-0006), anything else must supply
// the app's own API key. This does not add a session/login system — that's a separate, larger M2
// concern upstream already deferred; it closes the specific gap of a bulk-destructive action being
// reachable from outside the trusted network with zero check at all.
//
// Caveat inherited from the same model Sonarr/Radarr use: if this app sits behind a reverse proxy,
// the "local" determination is only as trustworthy as X-Forwarded-For, which an external client can
// forge unless the proxy strips/overwrites it before forwarding. Deploy behind a proxy that does so
// (Nginx Proxy Manager does, by default) if exposing this beyond a fully trusted LAN.

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

// RFC 1918 / loopback / link-local / unique-local ranges, plus their IPv4-mapped-IPv6 forms.
export function isLocalAddress(ip: string): boolean {
  const addr = ip.replace(/^::ffff:/i, '')
  if (addr === '::1' || addr === '127.0.0.1' || addr.startsWith('127.')) return true
  if (addr === '::' || addr.toLowerCase().startsWith('fe80:') || addr.toLowerCase().startsWith('fc') || addr.toLowerCase().startsWith('fd')) return true
  if (/^10\./.test(addr)) return true
  if (/^192\.168\./.test(addr)) return true
  const m = /^172\.(\d{1,3})\./.exec(addr)
  if (m && Number(m[1]) >= 16 && Number(m[1]) <= 31) return true
  return false
}

// Throws (sends a 401) unless the request is from a local address or carries a valid X-Api-Key
// header matching the app's own generated key.
export function requireLocalOrApiKey(event: H3Event): void {
  const ip = getRequestIP(event, { xForwardedFor: true })
  if (ip && isLocalAddress(ip)) return

  const provided = getHeader(event, 'x-api-key')
  const expected = getOrCreateApiKey()
  if (provided && provided === expected) return

  throw createError({ statusCode: 401, statusMessage: 'Requires X-Api-Key for non-local requests' })
}
