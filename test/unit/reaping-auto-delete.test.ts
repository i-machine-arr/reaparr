import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Notifier, NotifyResult } from '../../server/reaping/notifier'

// Auto-delete pass against the real mock server (over-threshold by default: 10GB free / 100GB total
// = 90% used), so the delete calls exercise the actual HTTP + adapter path, not a hand-rolled fake.

process.env.REAPARR_DB_PATH = join(mkdtempSync(join(tmpdir(), 'reaparr-autodelete-')), 'test.db')

const NOW = Date.parse('2026-06-30T00:00:00Z')
const PORT = 8912
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

function fakeNotifier() {
  const calls: { event: string, titleId: number }[] = []
  const notifier: Notifier = {
    async notify(_db, event, title): Promise<NotifyResult> {
      calls.push({ event, titleId: title.id })
      return { event, sent: 1, skipped: 0, failed: 0 }
    }
  }
  return { notifier, calls }
}

async function ctx() {
  const { getDb, schema } = await import('../../server/db/client')
  const { eq } = await import('drizzle-orm')
  return { db: getDb(), schema, eq }
}

async function setDue(sourceId: number, source: 'sonarr' | 'radarr', dueAt: string) {
  const { db, schema, eq } = await ctx()
  const { applyTransition } = await import('../../server/reaping/stateMachine')
  const t = db.select().from(schema.title)
    .where(eq(schema.title.sourceId, sourceId)).all()
    .find(x => x.source === source)!
  applyTransition(db, t.id, {
    to: 'scheduled', reason: 'admin_scheduled', actor: { system: 'operator' },
    patch: { scheduledAt: new Date(NOW - 10 * 86_400_000).toISOString(), dueAt }, now: NOW
  })
  applyTransition(db, t.id, { to: 'due', reason: 'grace_elapsed', actor: { system: 'sync' }, now: NOW })
  return t.id
}

async function setSetting(key: string, value: string) {
  const { db, schema } = await ctx()
  db.insert(schema.appSetting).values({ key, value })
    .onConflictDoUpdate({ target: schema.appSetting.key, set: { value } }).run()
}

beforeAll(async () => {
  mock = spawn('node', ['test/mock-server/server.mjs'], {
    env: {
      ...process.env, MOCK_PORT: String(PORT), MOCK_NOW: String(NOW),
      MOCK_ROOT_FREE_BYTES: String(10 * 1024 ** 3), MOCK_ROOT_TOTAL_BYTES: String(100 * 1024 ** 3)
    },
    stdio: 'ignore'
  })
  await waitForServer(`${BASE}/api/v3/system/status`)

  const { getDb, schema } = await import('../../server/db/client')
  const { seedDefaults } = await import('../../server/utils/seed')
  const { buildDemoBundle } = await import('../../server/utils/demo-dataset')
  const { persistBundle } = await import('../../server/sync/persist')
  seedDefaults()
  await persistBundle(buildDemoBundle(NOW), NOW)

  const db = getDb()
  const { eq } = await import('drizzle-orm')
  for (const source of ['sonarr', 'radarr']) {
    db.update(schema.sourceConnection)
      .set({ baseUrl: BASE, credential: 'mock-key', enabled: 1 })
      .where(eq(schema.sourceConnection.source, source)).run()
  }
}, 20000)

afterAll(() => {
  mock?.kill()
})

describe('runAutoDeletePass', () => {
  it('disabled by default: no-op, no state change', async () => {
    const { runAutoDeletePass } = await import('../../server/reaping/autoDelete')
    const { db, schema, eq } = await ctx()
    const id = await setDue(5, 'sonarr', new Date(NOW - 86_400_000).toISOString()) // Stale Series

    const { notifier } = fakeNotifier()
    const counts = await runAutoDeletePass(db, NOW, notifier)
    expect(counts).toEqual({ evaluated: 0, deleted: 0, failed: 0, skippedUnderThreshold: 0 })
    expect(db.select().from(schema.title).where(eq(schema.title.id, id)).get()!.state).toBe('due')
  })

  it('under threshold: skips without deleting', async () => {
    await setSetting('reaping_auto_delete_enabled', '1')
    await setSetting('reaping_disk_threshold_percent', '95') // mock is at 90% used
    const { runAutoDeletePass } = await import('../../server/reaping/autoDelete')
    const { db } = await ctx()

    const { notifier } = fakeNotifier()
    const counts = await runAutoDeletePass(db, NOW, notifier)
    expect(counts.deleted).toBe(0)
    expect(counts.skippedUnderThreshold).toBeGreaterThan(0)
  })

  it('over threshold: deletes the oldest-due title first, respects the per-run cap, fires departed', async () => {
    await setSetting('reaping_disk_threshold_percent', '75') // mock is at 90% used — now over
    await setSetting('reaping_max_deletes_per_run', '1')
    const olderDueId = await setDue(3, 'sonarr', new Date(NOW - 5 * 86_400_000).toISOString()) // A Comedy — more overdue
    const newerDueId = await setDue(4, 'sonarr', new Date(NOW - 1 * 86_400_000).toISOString()) // Ongoing Show

    const { runAutoDeletePass } = await import('../../server/reaping/autoDelete')
    const { db, schema, eq } = await ctx()
    const { notifier, calls } = fakeNotifier()
    const counts = await runAutoDeletePass(db, NOW, notifier)

    expect(counts.deleted).toBe(1) // capped at 1 despite two eligible due titles
    expect(db.select().from(schema.title).where(eq(schema.title.id, olderDueId)).get()!.state).toBe('removed')
    expect(db.select().from(schema.title).where(eq(schema.title.id, newerDueId)).get()!.state).toBe('due') // untouched, cap reached

    const trans = db.select().from(schema.titleTransition).where(eq(schema.titleTransition.titleId, olderDueId)).all()
    expect(trans.some(t => t.reason === 'auto_deleted' && t.actorSystem === 'system' && t.toState === 'removed')).toBe(true)
    expect(calls.some(c => c.event === 'departed' && c.titleId === olderDueId)).toBe(true)
  })
})
