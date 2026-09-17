// Disk-threshold auto-delete (docs/adr/0008). The one piece the upstream project's read-only MVP
// deliberately stopped short of: when a title is `due` (The Appointed Hour) AND the relevant *arr's
// media pool is over the configured threshold, actually delete the file via the *arr's own API and
// close out the reaping workflow — instead of waiting on an operator to notice and click a button.

import { eq } from 'drizzle-orm'
import type { getDb } from '../db/client'
import { schema } from '../db/client'
import { createSonarrClient, createRadarrClient, type ConnectionConfig } from '../sources'
import { applyTransition } from './stateMachine'
import { emailNotifier, type Notifier } from './notifier'

type Db = ReturnType<typeof getDb>
type Title = typeof schema.title.$inferSelect

export interface AutoDeleteCounts {
  evaluated: number
  deleted: number
  failed: number
  skippedUnderThreshold: number
}

interface AutoDeleteSettings {
  enabled: boolean
  thresholdPercent: number
  maxDeletesPerRun: number // 0 = unlimited
}

const DEFAULT_SETTINGS: AutoDeleteSettings = { enabled: false, thresholdPercent: 75, maxDeletesPerRun: 5 }

export function getAutoDeleteSettings(db: Db): AutoDeleteSettings {
  const rows = db.select().from(schema.appSetting).all()
  const map = new Map(rows.map(r => [r.key, r.value]))
  const num = (k: string, d: number) => {
    const v = map.get(k)
    const n = v != null ? Number(v) : NaN
    return Number.isFinite(n) ? n : d
  }
  const enabledRaw = map.get('reaping_auto_delete_enabled')
  return {
    enabled: enabledRaw === '1' || enabledRaw === 'true',
    thresholdPercent: num('reaping_disk_threshold_percent', DEFAULT_SETTINGS.thresholdPercent),
    maxDeletesPerRun: num('reaping_max_deletes_per_run', DEFAULT_SETTINGS.maxDeletesPerRun)
  }
}

function connConfig(row: { baseUrl: string | null, credential: string | null } | undefined): ConnectionConfig | null {
  if (!row?.baseUrl || !row.credential) return null
  return { baseUrl: row.baseUrl, credential: row.credential }
}

export async function runAutoDeletePass(
  db: Db,
  now: number = Date.now(),
  notifier: Notifier = emailNotifier
): Promise<AutoDeleteCounts> {
  const counts: AutoDeleteCounts = { evaluated: 0, deleted: 0, failed: 0, skippedUnderThreshold: 0 }
  const settings = getAutoDeleteSettings(db)
  if (!settings.enabled) return counts

  const due = db.select().from(schema.title).where(eq(schema.title.state, 'due')).all()
    .sort((a, b) => (a.dueAt ?? '').localeCompare(b.dueAt ?? ''))
  if (due.length === 0) return counts

  const bySource = new Map<'sonarr' | 'radarr', Title[]>()
  for (const t of due) {
    if (t.source !== 'sonarr' && t.source !== 'radarr') continue
    const list = bySource.get(t.source) ?? []
    list.push(t)
    bySource.set(t.source, list)
  }

  let totalDeletedThisRun = 0
  const capReached = () => settings.maxDeletesPerRun > 0 && totalDeletedThisRun >= settings.maxDeletesPerRun

  for (const [source, titles] of bySource) {
    if (capReached()) break
    const connRow = db.select().from(schema.sourceConnection).where(eq(schema.sourceConnection.source, source)).get()
    const cfg = connConfig(connRow)
    if (!cfg || connRow?.enabled !== 1) continue

    const client = source === 'sonarr' ? createSonarrClient(cfg) : createRadarrClient(cfg)
    let folders
    try {
      folders = await client.getDiskSpace()
    } catch {
      continue // can't read space for this source right now — try again next run
    }
    const folder = folders[0]
    if (!folder || folder.totalSpace <= 0) continue

    let freeSpace = folder.freeSpace
    const percentUsed = () => ((folder.totalSpace - freeSpace) / folder.totalSpace) * 100
    if (percentUsed() < settings.thresholdPercent) {
      counts.skippedUnderThreshold++
      continue
    }

    for (const title of titles) {
      if (capReached()) break
      if (percentUsed() < settings.thresholdPercent) break // this source's pressure is already relieved
      counts.evaluated++
      try {
        const result = source === 'sonarr'
          ? await (client as ReturnType<typeof createSonarrClient>).deleteSeriesFiles(title.sourceId)
          : await (client as ReturnType<typeof createRadarrClient>).deleteMovieFile(title.sourceId)
        applyTransition(db, title.id, { to: 'removed', reason: 'auto_deleted', actor: { system: 'system' }, now })
        await notifier.notify(db, 'departed', { id: title.id, episode: title.episode, title: title.title, dueAt: title.dueAt }, now)
        freeSpace += result.deletedBytes
        totalDeletedThisRun++
        counts.deleted++
      } catch (err) {
        counts.failed++
        console.error(`[auto-delete] failed to delete title ${title.id} (${title.title}) via ${source}:`, (err as Error).message)
      }
    }
  }

  return counts
}
