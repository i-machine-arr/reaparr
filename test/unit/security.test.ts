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
