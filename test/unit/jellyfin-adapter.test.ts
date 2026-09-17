import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'

// Jellyfin adapter against the real mock server — probe, history, metadata, and the Leaving Soon
// collection reconcile path (create, then add/remove on a second call).

const NOW = Date.parse('2026-06-30T00:00:00Z')
const PORT = 8913
const BASE = `http://localhost:${PORT}`
let mock: ChildProcess

async function waitForServer(url: string, attempts = 50) {
  for (let i = 0; i < attempts; i++) {
    try {
      const r = await fetch(url)
      if (r.ok) return
    } catch { /* not up yet */ }
    await new Promise(r => setTimeout(r, 100))
  }
  throw new Error('mock server did not start')
}

beforeAll(async () => {
  mock = spawn('node', ['test/mock-server/server.mjs'], {
    env: { ...process.env, MOCK_PORT: String(PORT), MOCK_NOW: String(NOW) },
    stdio: 'ignore'
  })
  await waitForServer(`${BASE}/System/Info`)
}, 20000)

afterAll(() => {
  mock?.kill()
})

describe('Jellyfin adapter', () => {
  const cfg = { baseUrl: BASE, credential: 'mock-key' }

  it('probes ok', async () => {
    const { createJellyfinClient } = await import('../../server/sources')
    const result = await createJellyfinClient(cfg).probe()
    expect(result.ok).toBe(true)
  })

  it('getUsers returns the mock admin user', async () => {
    const { createJellyfinClient } = await import('../../server/sources')
    const users = await createJellyfinClient(cfg).getUsers()
    expect(users.length).toBeGreaterThan(0)
  })

  it('getMetadata resolves provider ids for a library item', async () => {
    const { createJellyfinClient } = await import('../../server/sources')
    const meta = await createJellyfinClient(cfg).getMetadata('series-1') // Some Anime, tvdbId 100001
    expect(meta?.tvdbId).toBe(100001)
  })

  it('syncLeavingSoonCollection creates the collection, then reconciles membership on a later call', async () => {
    const { createJellyfinClient } = await import('../../server/sources')
    const client = createJellyfinClient(cfg)

    // First call: two titles in the grace window.
    await client.syncLeavingSoonCollection([
      { tmdbId: null, tvdbId: 100001, mediaType: 'series' }, // Some Anime
      { tmdbId: 300001, tvdbId: null, mediaType: 'movie' } // Never Watched Movie
    ])
    const afterFirst = await fetch(`${BASE}/Items?ParentId=leaving-soon-collection`).then(r => r.json()) as { Items: { Id: string }[] }
    expect(afterFirst.Items.map(i => i.Id).sort()).toEqual(['movie-1', 'series-1'])

    // Second call: only one title remains in the window — the other should be removed, not just left.
    await client.syncLeavingSoonCollection([{ tmdbId: null, tvdbId: 100001, mediaType: 'series' }])
    const afterSecond = await fetch(`${BASE}/Items?ParentId=leaving-soon-collection`).then(r => r.json()) as { Items: { Id: string }[] }
    expect(afterSecond.Items.map(i => i.Id)).toEqual(['series-1'])
  })
})
