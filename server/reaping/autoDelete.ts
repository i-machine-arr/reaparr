// Disk-threshold auto-delete (docs/adr/0008). The one piece the upstream project's read-only MVP
// deliberately stopped short of: when a title is `due` (The Appointed Hour) AND the relevant *arr's
// media pool is over the configured threshold, actually delete the file via the *arr's own API and
// close out the reaping workflow — instead of waiting on an operator to notice and click a button.

import { eq } from 'drizzle-orm'
import type { getDb } from '../db/client'
import { schema } from '../db/client'
import {
  createSonarrClient, createRadarrClient, type ConnectionConfig, type NormalizedDiskSpace,
  type SonarrClient, type RadarrClient
} from '../sources'
import { applyTransition } from './stateMachine'
import { emailNotifier, type Notifier } from './notifier'
import { runExclusive } from '../sync/exclusion'

type Db = ReturnType<typeof getDb>
type Title = typeof schema.title.$inferSelect
type ArrSource = 'sonarr' | 'radarr'

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

// Sonarr/Radarr can run natively on Windows too, not just Linux Docker — normalize backslashes to
// forward slashes so a UNC/drive-letter root folder still matches. Case is preserved for POSIX
// paths (Linux is case-sensitive: /Media and /media can be genuinely different locations) and only
// folded for Windows-shaped paths (drive letter or UNC), which are case-insensitive by convention.
function isWindowsPath(p: string): boolean {
  return /^[a-z]:[\\/]/i.test(p) || /^[\\/]{2}/.test(p)
}

function normalizePath(p: string, foldCase: boolean): string {
  const withForwardSlashes = p.replace(/\\/g, '/')
  return foldCase ? withForwardSlashes.toLowerCase() : withForwardSlashes
}

// /api/v3/diskspace can report multiple mounts (Sonarr/Radarr have been seen returning /, /config,
// /data as separate entries with no guaranteed order) — it alone can't say which one is the actual
// media root. Match against the real configured root folder path instead of blindly taking the
// first entry.
function isPathUnder(candidatePath: string, mountPath: string): boolean {
  const foldCase = isWindowsPath(candidatePath) || isWindowsPath(mountPath)
  const candidate = normalizePath(candidatePath, foldCase)
  const mount = normalizePath(mountPath, foldCase)
  if (mount === '/') return true
  const normalized = mount.endsWith('/') ? mount.slice(0, -1) : mount
  return candidate === normalized || candidate.startsWith(`${normalized}/`)
}

function pickMediaDisk(disks: NormalizedDiskSpace[], rootFolderPaths: string[]): NormalizedDiskSpace | null {
  // Multiple configured root folders could sit on physically different disks, and titles aren't
  // (yet) associated with which root folder they actually live under — guessing which root's disk
  // to check could delete titles on an unpressured disk while a different, pressured one stays full,
  // or the reverse. Skip rather than guess; single-root-folder setups (the common case) are exact.
  if (rootFolderPaths.length !== 1) return null
  const rootPath = rootFolderPaths[0]!
  let best: NormalizedDiskSpace | null = null
  for (const d of disks) {
    if (!isPathUnder(rootPath, d.path)) continue
    if (!best || d.path.length > best.path.length) best = d
  }
  return best
}

interface SourceContext {
  client: SonarrClient | RadarrClient
  disk: NormalizedDiskSpace
  freeSpace: number
  // Set once a deletion's freed bytes couldn't be counted accurately (a file with an unknown size).
  // freeSpace can no longer be trusted to reflect reality, so further titles for this source are
  // left for the next run, which re-reads real disk space instead of continuing to estimate.
  freeSpaceUnreliable: boolean
}

async function buildSourceContext(db: Db, source: ArrSource): Promise<SourceContext | null> {
  const connRow = db.select().from(schema.sourceConnection).where(eq(schema.sourceConnection.source, source)).get()
  const cfg = connConfig(connRow)
  if (!cfg || connRow?.enabled !== 1) return null

  const client = source === 'sonarr' ? createSonarrClient(cfg) : createRadarrClient(cfg)
  let disks: NormalizedDiskSpace[]
  let rootFolderPaths: string[]
  try {
    const results = await Promise.all([client.getDiskSpace(), client.getRootFolderPaths()])
    disks = results[0]
    rootFolderPaths = results[1]
  } catch {
    return null // can't read space for this source right now — try again next run
  }
  const disk = pickMediaDisk(disks, rootFolderPaths)
  if (!disk || disk.totalSpace <= 0) return null // no verified media-root match — skip rather than guess

  return { client, disk, freeSpace: disk.freeSpace, freeSpaceUnreliable: false }
}

function percentUsed(ctx: SourceContext): number {
  return ((ctx.disk.totalSpace - ctx.freeSpace) / ctx.disk.totalSpace) * 100
}

async function runAutoDeletePassUnguarded(
  db: Db,
  now: number,
  notifier: Notifier
): Promise<AutoDeleteCounts> {
  const counts: AutoDeleteCounts = { evaluated: 0, deleted: 0, failed: 0, skippedUnderThreshold: 0 }
  const settings = getAutoDeleteSettings(db)
  if (!settings.enabled) return counts

  // Sorted oldest-due-first across ALL sources together — this order is preserved through the
  // single loop below so a global maxDeletesPerRun cap can't let a newer title from one source jump
  // ahead of an older, more-overdue title from the other.
  const due = db.select().from(schema.title).where(eq(schema.title.state, 'due')).all()
    .filter((t): t is Title & { source: ArrSource } => t.source === 'sonarr' || t.source === 'radarr')
    .sort((a, b) => (a.dueAt ?? '').localeCompare(b.dueAt ?? ''))
  if (due.length === 0) return counts

  // Build each present source's disk context once, up front, before processing any title.
  const contexts = new Map<ArrSource, SourceContext>()
  for (const source of new Set(due.map(t => t.source))) {
    const ctx = await buildSourceContext(db, source)
    if (!ctx) continue
    if (percentUsed(ctx) < settings.thresholdPercent) {
      counts.skippedUnderThreshold++
      continue
    }
    contexts.set(source, ctx)
  }

  let totalDeletedThisRun = 0
  const capReached = () => settings.maxDeletesPerRun > 0 && totalDeletedThisRun >= settings.maxDeletesPerRun

  for (const title of due) {
    if (capReached()) break
    const ctx = contexts.get(title.source)
    if (!ctx) continue // source disabled/unreachable, unresolvable disk, or already under threshold
    if (ctx.freeSpaceUnreliable) continue // this source's free-space estimate is no longer trustworthy this run
    if (percentUsed(ctx) < settings.thresholdPercent) continue // this source's pressure is already relieved

    counts.evaluated++
    try {
      const result = title.source === 'sonarr'
        ? await (ctx.client as SonarrClient).deleteSeriesFiles(title.sourceId)
        : await (ctx.client as RadarrClient).deleteMovieFile(title.sourceId)
      applyTransition(db, title.id, { to: 'removed', reason: 'auto_deleted', actor: { system: 'system' }, now })
      // Counters update immediately after the deletion is recorded, regardless of whether the
      // notification succeeds — a rejected notify() must not be able to hide a completed deletion
      // from capReached(), or the pass could delete more than maxDeletesPerRun allows.
      if (result.unknownSize) {
        ctx.freeSpaceUnreliable = true
      } else {
        ctx.freeSpace += result.deletedBytes
      }
      totalDeletedThisRun++
      counts.deleted++
      try {
        await notifier.notify(db, 'departed', { id: title.id, episode: title.episode, title: title.title, dueAt: title.dueAt }, now)
      } catch (err) {
        console.error(`[auto-delete] departed notification failed for title ${title.id}:`, (err as Error).message)
      }
    } catch (err) {
      counts.failed++
      console.error(`[auto-delete] failed to delete title ${title.id} (${title.title}) via ${title.source}:`, (err as Error).message)
    }
  }

  return counts
}

export async function runAutoDeletePass(
  db: Db,
  now: number = Date.now(),
  notifier: Notifier = emailNotifier
): Promise<AutoDeleteCounts> {
  // Never overlaps a sync run (docs/adr/0008) — a sync's reaping tick can auto-reprieve or resurrect
  // a title at the exact moment this pass is mid-deletion against a stale snapshot of it.
  return runExclusive(() => runAutoDeletePassUnguarded(db, now, notifier))
}
