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

interface JellyfinUserPolicy { IsAdministrator?: boolean, EnableAllFolders?: boolean }
interface JellyfinUser { Id: string, Name?: string, Policy?: JellyfinUserPolicy }
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

// Reconciliation needs one consistent "what's actually in the library" view. users[0] is arbitrary —
// if that account lacks folder access, items it can't see would look like they don't exist and get
// dropped from Leaving Soon. Prefer a verified admin with full folder access; only fall back to the
// first user if the server genuinely has no such account (better than refusing to sync at all).
function pickLibraryUser(users: JellyfinUser[]): JellyfinUser | undefined {
  return users.find(u => u.Policy?.IsAdministrator && u.Policy?.EnableAllFolders) ?? users[0]
}

// Validates the shape rather than defaulting to [] on anything unexpected: a malformed (non-array)
// or falsy-but-present Items would otherwise look identical to "library is genuinely empty," and an
// empty result here means syncLeavingSoonCollection removes every real collection member.
function assertItemsResponse<T extends { Id: string }>(res: JellyfinItemsResponse<T> | undefined): T[] {
  if (res === undefined) return [] // sourceFetch returns undefined for a genuinely empty response body
  if (!Array.isArray(res.Items) || res.Items.some(item => typeof item?.Id !== 'string')) {
    throw new Error('Invalid Jellyfin items response')
  }
  return res.Items
}

// Movie,Series only — used for collection membership matching (syncLeavingSoonCollection), where a
// series is matched/added as one unit, not per episode.
async function getLibraryItems(config: ConnectionConfig, userId: string): Promise<JellyfinItem[]> {
  const res = await sourceFetch<JellyfinItemsResponse>(config, AUTH, `/Users/${userId}/Items`, {
    query: { Recursive: 'true', IncludeItemTypes: 'Movie,Series', Fields: 'ProviderIds' }
  })
  return assertItemsResponse(res)
}

// Movie,Episode — used for watch history. IncludeItemTypes: 'Movie,Series' (getLibraryItems) would
// report a whole series as one played/unplayed item, collapsing every episode into a single history
// row and undercounting completion; querying episodes directly keeps one row per watched episode,
// each carrying its own series id as grandparentRatingKey.
async function getHistoryItems(config: ConnectionConfig, userId: string): Promise<JellyfinItem[]> {
  const res = await sourceFetch<JellyfinItemsResponse>(config, AUTH, `/Users/${userId}/Items`, {
    query: { Recursive: 'true', IncludeItemTypes: 'Movie,Episode', Fields: 'ProviderIds' }
  })
  return assertItemsResponse(res)
}

async function findCollectionId(config: ConnectionConfig): Promise<string | null> {
  const res = await sourceFetch<JellyfinItemsResponse<{ Id: string, Name?: string }>>(config, AUTH, '/Items', {
    query: { IncludeItemTypes: 'BoxSet', Recursive: 'true' }
  })
  const found = assertItemsResponse(res).find(i => i.Name === COLLECTION_NAME)
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
        const items = await getHistoryItems(config, user.Id)
        for (const item of items) {
          if (!item.UserData?.Played) continue
          const isEpisode = item.Type === 'Episode'
          out.push({
            lastWatchedAt: item.UserData.LastPlayedDate ?? null,
            userId: user.Id,
            username: user.Name ?? null,
            friendlyName: user.Name ?? null,
            mediaType: isEpisode ? 'episode' : 'movie',
            ratingKey: item.Id,
            grandparentRatingKey: isEpisode ? (item.SeriesId ?? null) : null,
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
      const libraryUser = pickLibraryUser(users)
      if (!libraryUser) return // no user to enumerate the library through yet

      const library = await getLibraryItems(config, libraryUser.Id)
      // Fetch-guard, same principle as the sync pipeline's own (docs/adr/0002): a validly-shaped but
      // empty library response is indistinguishable from a transient/erroneous one (a real Jellyfin
      // server having zero movies or series at all is not a realistic steady state). Trusting it
      // would compute an empty desiredIds regardless of how many real targets were passed in, and
      // remove every existing Leaving Soon member. Bail out and leave the collection untouched
      // rather than treat "fetched nothing" as "wants nothing."
      if (library.length === 0) return
      // Keyed by mediaType + provider id, not id alone — an unkeyed map risks a cross-type collision
      // (a movie and a series coincidentally sharing a raw tmdb/tvdb id) silently adding the wrong item.
      const byTmdb = new Map(
        library.filter(i => i.ProviderIds?.Tmdb).map(i => [`${i.Type}:${i.ProviderIds!.Tmdb}`, i.Id])
      )
      const byTvdb = new Map(
        library.filter(i => i.ProviderIds?.Tvdb).map(i => [`${i.Type}:${i.ProviderIds!.Tvdb}`, i.Id])
      )
      const desiredIds = new Set(
        items
          .map((t) => {
            const jellyfinType = t.mediaType === 'series' ? 'Series' : 'Movie'
            // Try tvdb first, but fall back to tmdb if the target has both ids and only the tvdb
            // lookup misses — a target with a real tmdb match shouldn't be dropped just because it
            // also carries a tvdb id that happens not to resolve in this library.
            const tvdbMatch = t.tvdbId ? byTvdb.get(`${jellyfinType}:${t.tvdbId}`) : undefined
            return tvdbMatch ?? (t.tmdbId ? byTmdb.get(`${jellyfinType}:${t.tmdbId}`) : undefined)
          })
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
      const currentIds = new Set(assertItemsResponse(currentRes).map(i => i.Id))

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
