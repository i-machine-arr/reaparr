// Jellyfin adapter (docs/adr/0008). Unlike Plex, Jellyfin has no separate history/monitoring
// companion — watch state and provider ids both live on the item itself via its own API, and
// Leaving Soon is a native Collection rather than a symlinked library folder.

import { sourceFetch } from './http'
import type {
  AuthInjection, ConnectionConfig, LeavingSoonTarget, MediaServerClient, NormalizedHistoryRow,
  NormalizedMetadata, NormalizedSourceUser, ProbeResult
} from './types'

const AUTH: AuthInjection = { kind: 'header', name: 'X-Emby-Token' }
const COLLECTION_NAME = 'Leaving Soon'

interface JellyfinUser { Id: string, Name?: string }
interface JellyfinProviderIds { Tmdb?: string, Tvdb?: string, Imdb?: string }
interface JellyfinUserData { Played?: boolean, LastPlayedDate?: string }
interface JellyfinItem {
  Id: string
  Type?: string
  SeriesId?: string
  ProviderIds?: JellyfinProviderIds
  UserData?: JellyfinUserData
}
interface JellyfinItemsResponse<T = JellyfinItem> { Items?: T[] }

function parseProviderIds(p?: JellyfinProviderIds): { tmdbId: number | null, tvdbId: number | null, imdbId: string | null } {
  return {
    tmdbId: p?.Tmdb ? Number.parseInt(p.Tmdb, 10) || null : null,
    tvdbId: p?.Tvdb ? Number.parseInt(p.Tvdb, 10) || null : null,
    imdbId: p?.Imdb ?? null
  }
}

async function getUsers(config: ConnectionConfig): Promise<JellyfinUser[]> {
  return (await sourceFetch<JellyfinUser[]>(config, AUTH, '/Users')) ?? []
}

// One call, cached per-invocation: every Movie/Series with its provider ids, used both to translate
// tmdb/tvdb ids to Jellyfin item ids (Leaving Soon) and to read watch state (history).
async function getLibraryItems(config: ConnectionConfig, userId: string): Promise<JellyfinItem[]> {
  const res = await sourceFetch<JellyfinItemsResponse>(config, AUTH, `/Users/${userId}/Items`, {
    query: { Recursive: 'true', IncludeItemTypes: 'Movie,Series', Fields: 'ProviderIds' }
  })
  return res?.Items ?? []
}

async function findCollectionId(config: ConnectionConfig): Promise<string | null> {
  const res = await sourceFetch<JellyfinItemsResponse<{ Id: string, Name?: string }>>(config, AUTH, '/Items', {
    query: { IncludeItemTypes: 'BoxSet', Recursive: 'true' }
  })
  const found = (res?.Items ?? []).find(i => i.Name === COLLECTION_NAME)
  return found?.Id ?? null
}

export function createJellyfinClient(config: ConnectionConfig): MediaServerClient {
  return {
    source: 'jellyfin',
    async probe(): Promise<ProbeResult> {
      try {
        const info = await sourceFetch<{ Version?: string }>(config, AUTH, '/System/Info')
        return { ok: true, message: `Jellyfin ${info?.Version ?? ''}`.trim() }
      } catch (err) {
        return { ok: false, message: (err as Error).message }
      }
    },
    async getUsers(): Promise<NormalizedSourceUser[]> {
      const users = await getUsers(config)
      return users.map(u => ({ sourceUserId: u.Id, email: null, username: u.Name ?? null, friendlyName: u.Name ?? null }))
    },
    // No separate history service (unlike Plex/Tautulli) — a per-item Played/LastPlayedDate flag,
    // read across every user, is the whole signal. Same approach janitorr-stats already uses against
    // Jellyfin directly (see project_janitorr_stack).
    async getHistory(): Promise<NormalizedHistoryRow[]> {
      const users = await getUsers(config)
      const out: NormalizedHistoryRow[] = []
      for (const user of users) {
        const items = await getLibraryItems(config, user.Id)
        for (const item of items) {
          if (!item.UserData?.Played) continue
          out.push({
            lastWatchedAt: item.UserData.LastPlayedDate ?? null,
            userId: user.Id,
            username: user.Name ?? null,
            friendlyName: user.Name ?? null,
            mediaType: item.Type === 'Series' ? 'episode' : 'movie',
            ratingKey: item.Id,
            grandparentRatingKey: item.Type === 'Series' ? item.Id : null,
            watchedStatus: 1,
            percentComplete: 100
          })
        }
      }
      return out
    },
    async getMetadata(ratingKey: string): Promise<NormalizedMetadata | null> {
      const item = await sourceFetch<JellyfinItem | null>(config, AUTH, `/Items/${ratingKey}`)
      if (!item) return null
      return {
        ratingKey: item.Id,
        grandparentRatingKey: item.SeriesId ?? null,
        mediaType: item.Type ?? null,
        ...parseProviderIds(item.ProviderIds)
      }
    },
    async syncLeavingSoonCollection(items: LeavingSoonTarget[]): Promise<void> {
      const users = await getUsers(config)
      const firstUser = users[0]
      if (!firstUser) return // no admin user to enumerate the library through yet

      const library = await getLibraryItems(config, firstUser.Id)
      const byTmdb = new Map(library.filter(i => i.ProviderIds?.Tmdb).map(i => [i.ProviderIds!.Tmdb, i.Id]))
      const byTvdb = new Map(library.filter(i => i.ProviderIds?.Tvdb).map(i => [i.ProviderIds!.Tvdb, i.Id]))
      const desiredIds = new Set(
        items
          .map(t => (t.tvdbId ? byTvdb.get(String(t.tvdbId)) : t.tmdbId ? byTmdb.get(String(t.tmdbId)) : undefined))
          .filter((id): id is string => id != null)
      )

      const collectionId = await findCollectionId(config)
      if (!collectionId) {
        if (desiredIds.size === 0) return
        await sourceFetch(config, AUTH, '/Collections', {
          method: 'POST',
          query: { Name: COLLECTION_NAME, Ids: [...desiredIds].join(',') }
        })
        return
      }

      const currentRes = await sourceFetch<JellyfinItemsResponse<{ Id: string }>>(config, AUTH, '/Items', {
        query: { ParentId: collectionId }
      })
      const currentIds = new Set((currentRes?.Items ?? []).map(i => i.Id))

      const toAdd = [...desiredIds].filter(id => !currentIds.has(id))
      const toRemove = [...currentIds].filter(id => !desiredIds.has(id))
      if (toAdd.length) {
        await sourceFetch(config, AUTH, `/Collections/${collectionId}/Items`, { method: 'POST', query: { Ids: toAdd.join(',') } })
      }
      if (toRemove.length) {
        await sourceFetch(config, AUTH, `/Collections/${collectionId}/Items`, { method: 'DELETE', query: { Ids: toRemove.join(',') } })
      }
    }
  }
}
