import { describe, it, expect } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.REAPARR_DB_PATH = join(mkdtempSync(join(tmpdir(), 'reaparr-security-')), 'test.db')

describe('isLocalAddress', () => {
  it('treats loopback and RFC 1918 ranges as local', async () => {
    const { isLocalAddress } = await import('../../server/utils/security')
    expect(isLocalAddress('127.0.0.1')).toBe(true)
    expect(isLocalAddress('::1')).toBe(true)
    expect(isLocalAddress('10.0.5.2')).toBe(true)
    expect(isLocalAddress('192.168.1.50')).toBe(true)
    expect(isLocalAddress('172.16.0.1')).toBe(true)
    expect(isLocalAddress('172.31.255.255')).toBe(true)
    expect(isLocalAddress('::ffff:192.168.1.5')).toBe(true) // IPv4-mapped IPv6
    expect(isLocalAddress('fd12:3456:789a::1')).toBe(true) // unique local
  })

  it('does not treat public addresses or adjacent-but-different ranges as local', () => {
    return import('../../server/utils/security').then(({ isLocalAddress }) => {
      expect(isLocalAddress('8.8.8.8')).toBe(false)
      expect(isLocalAddress('1.1.1.1')).toBe(false)
      expect(isLocalAddress('172.15.255.255')).toBe(false) // just outside 172.16.0.0/12
      expect(isLocalAddress('172.32.0.0')).toBe(false) // just outside 172.16.0.0/12
      expect(isLocalAddress('2001:4860:4860::8888')).toBe(false) // public IPv6 (Google DNS)
    })
  })

  it('covers the full fe80::/10 link-local range, not just the fe80 prefix', () => {
    return import('../../server/utils/security').then(({ isLocalAddress }) => {
      expect(isLocalAddress('fe80::1')).toBe(true)
      expect(isLocalAddress('febf::1')).toBe(true)
      expect(isLocalAddress('fec0::1')).toBe(false) // outside fe80::/10 — this is a different (deprecated) range
    })
  })
})

describe('resolveTrustedIp (the actual authorization-bypass boundary)', () => {
  it('trusts X-Forwarded-For only when the direct TCP peer is itself local', async () => {
    const { resolveTrustedIp } = await import('../../server/utils/security')
    // Local peer (e.g. a request that actually arrived via a trusted local reverse proxy) — the
    // forwarded value is trusted, since only a proxy on the trusted network could have placed it.
    expect(resolveTrustedIp('127.0.0.1', '203.0.113.5')).toBe('203.0.113.5')
    expect(resolveTrustedIp('192.168.1.10', undefined)).toBe('192.168.1.10')
  })

  it('never trusts a spoofed X-Forwarded-For from a non-local direct peer — the actual bypass this fixes', async () => {
    const { resolveTrustedIp } = await import('../../server/utils/security')
    // An external client connecting directly (no trusted proxy in front) cannot fake being local by
    // just setting X-Forwarded-For: 127.0.0.1 — their real TCP peer address is what's trusted.
    expect(resolveTrustedIp('8.8.8.8', '127.0.0.1')).toBe('8.8.8.8')
    expect(resolveTrustedIp('8.8.8.8', '192.168.1.5')).toBe('8.8.8.8')
    expect(resolveTrustedIp('8.8.8.8', undefined)).toBe('8.8.8.8')
  })

  it('returns undefined when there is no direct peer at all', async () => {
    const { resolveTrustedIp } = await import('../../server/utils/security')
    expect(resolveTrustedIp(undefined, '127.0.0.1')).toBeUndefined()
  })
})

describe('forwarded client address', () => {
  it('uses the last X-Forwarded-For entry, the one our own proxy appended', async () => {
    const { clientFromForwardedFor } = await import('../../server/utils/security')
    // A client that sends "X-Forwarded-For: 127.0.0.1" gets it kept as the first entry; the proxy
    // then appends the real address. Only the last entry may be trusted.
    expect(clientFromForwardedFor('127.0.0.1, 203.0.113.5')).toBe('203.0.113.5')
    expect(clientFromForwardedFor('203.0.113.5')).toBe('203.0.113.5')
    expect(clientFromForwardedFor(undefined)).toBeUndefined()
  })
})

describe('API key comparison', () => {
  it('accepts only the exact key', async () => {
    const { apiKeyMatches } = await import('../../server/utils/security')
    const key = '0123456789abcdef0123456789abcdef'
    expect(apiKeyMatches(key, key)).toBe(true)
    expect(apiKeyMatches(key.slice(0, -1) + '0', key)).toBe(false)
    expect(apiKeyMatches(key.slice(0, 10), key)).toBe(false) // different length
    expect(apiKeyMatches(undefined, key)).toBe(false)
  })
})

describe('API key', () => {
  it('generates a key lazily and persists it across calls', async () => {
    const { getOrCreateApiKey } = await import('../../server/utils/security')
    const { getDb } = await import('../../server/db/client')
    const db = getDb()
    const first = getOrCreateApiKey(db)
    expect(first).toMatch(/^[0-9a-f]{32}$/)
    const second = getOrCreateApiKey(db)
    expect(second).toBe(first)
  })

  it('regenerateApiKey issues a different key that replaces the old one', async () => {
    const { getOrCreateApiKey, regenerateApiKey } = await import('../../server/utils/security')
    const { getDb } = await import('../../server/db/client')
    const db = getDb()
    const before = getOrCreateApiKey(db)
    const after = regenerateApiKey(db)
    expect(after).not.toBe(before)
    expect(getOrCreateApiKey(db)).toBe(after)
  })
})
