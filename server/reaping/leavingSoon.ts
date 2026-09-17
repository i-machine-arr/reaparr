// Leaving Soon collection sync (docs/adr/0008). Membership is derived, not incrementally patched:
// every run recomputes "which titles are currently in the grace window" from scratch and hands the
// whole desired set to the media server client, which reconciles it against actual collection
// membership. Simpler to reason about than hooking every state transition, and self-healing if a
// call fails partway through a previous run.
//
// Deliberately NOT part of tick.ts: tick.ts is pure DB/clock logic with no network calls (see its own
// header comment); this needs a media-server client, so it's called separately from run.ts, right
// after runReapingTick, riding the same daily cadence.

import { eq } from 'drizzle-orm'
import type { getDb } from '../db/client'
import { schema } from '../db/client'
import { createJellyfinClient, type ConnectionConfig, type LeavingSoonTarget } from '../sources'

type Db = ReturnType<typeof getDb>

function connConfig(row: { baseUrl: string | null, credential: string | null } | undefined): ConnectionConfig | null {
  if (!row?.baseUrl || !row.credential) return null
  return { baseUrl: row.baseUrl, credential: row.credential }
}

export interface LeavingSoonResult {
  synced: number // count of media servers actually synced (0 or 1 today; Phase 2 may add more)
  targets: number
}

export async function syncLeavingSoon(db: Db, _now: number = Date.now()): Promise<LeavingSoonResult> {
  const titles = db.select().from(schema.title).all()
    .filter(t => t.state === 'scheduled' || t.state === 'appealed')
  const targets: LeavingSoonTarget[] = titles.map(t => ({
    tmdbId: t.tmdbId,
    tvdbId: t.tvdbId,
    mediaType: t.mediaType === 'series' ? 'series' : 'movie'
  }))

  const result: LeavingSoonResult = { synced: 0, targets: targets.length }

  // Jellyfin only for now — Plex-direct and Emby adapters are Phase 2 (docs/adr/0008), same interface.
  const jellyfinRow = db.select().from(schema.sourceConnection).where(eq(schema.sourceConnection.source, 'jellyfin')).get()
  const jellyfinCfg = connConfig(jellyfinRow)
  if (jellyfinCfg && jellyfinRow?.enabled === 1) {
    await createJellyfinClient(jellyfinCfg).syncLeavingSoonCollection(targets)
    result.synced++
  }

  return result
}
