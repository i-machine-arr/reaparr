import { sourceFetch } from './http'
import type {
  AuthInjection, ConnectionConfig, DeleteFileResult, NormalizedDiskSpace, NormalizedSeries,
  ProbeResult, SonarrClient
} from './types'

const AUTH: AuthInjection = { kind: 'header', name: 'X-Api-Key' }

// NOTE: /api/v3/rootfolder does NOT report totalSpace on real Sonarr (freeSpace only) — confirmed
// against a real instance, not just assumed. /api/v3/diskspace is the endpoint that reports both.
interface SonarrDiskSpace { path: string, freeSpace?: number, totalSpace?: number }
interface SonarrEpisodeFile { id: number, size?: number }

interface SonarrSeasonStats { sizeOnDisk?: number, episodeFileCount?: number }
interface SonarrSeason { seasonNumber: number, statistics?: SonarrSeasonStats }
interface SonarrStats {
  seasonCount?: number
  episodeFileCount?: number
  episodeCount?: number
  totalEpisodeCount?: number
  sizeOnDisk?: number
  percentOfEpisodes?: number
}
interface SonarrSeries {
  id: number
  title: string
  year?: number
  tvdbId?: number
  imdbId?: string
  tmdbId?: number
  titleSlug?: string
  added?: string
  status?: string
  ended?: boolean
  seriesType?: string
  ratings?: { votes?: number, value?: number }
  statistics?: SonarrStats
  seasons?: SonarrSeason[]
}

function normalizeSeries(s: SonarrSeries): NormalizedSeries {
  const stats = s.statistics ?? {}
  return {
    sourceId: s.id,
    title: s.title,
    titleSlug: s.titleSlug ?? null,
    year: s.year ?? null,
    tvdbId: s.tvdbId ?? null,
    tmdbId: s.tmdbId ?? null,
    imdbId: s.imdbId ?? null,
    addedAt: s.added ?? null,
    sizeOnDisk: stats.sizeOnDisk ?? 0,
    seasonCount: stats.seasonCount ?? (s.seasons?.filter(x => x.seasonNumber > 0).length ?? 0),
    downloadedEpisodes: stats.episodeFileCount ?? 0,
    status: s.status === 'continuing' ? 'continuing' : 'ended',
    seriesType: s.seriesType ?? 'standard',
    rating: s.ratings?.value ?? null,
    seasons: (s.seasons ?? []).map(se => ({
      seasonNumber: se.seasonNumber,
      sizeOnDisk: se.statistics?.sizeOnDisk ?? 0,
      episodeFiles: se.statistics?.episodeFileCount ?? 0
    }))
  }
}

export function createSonarrClient(config: ConnectionConfig): SonarrClient {
  return {
    source: 'sonarr',
    async probe(): Promise<ProbeResult> {
      try {
        const status = await sourceFetch<{ version?: string }>(config, AUTH, '/api/v3/system/status')
        return { ok: true, message: `Sonarr ${status?.version ?? ''}`.trim() }
      } catch (err) {
        return { ok: false, message: (err as Error).message }
      }
    },
    async getSeries(): Promise<NormalizedSeries[]> {
      const series = await sourceFetch<SonarrSeries[]>(config, AUTH, '/api/v3/series')
      return (series ?? []).map(normalizeSeries)
    },
    async getDiskSpace(): Promise<NormalizedDiskSpace[]> {
      const disks = await sourceFetch<SonarrDiskSpace[]>(config, AUTH, '/api/v3/diskspace')
      return (disks ?? []).map(d => ({
        path: d.path,
        freeSpace: d.freeSpace ?? 0,
        totalSpace: d.totalSpace ?? 0
      }))
    },
    async getRootFolderPaths(): Promise<string[]> {
      const folders = await sourceFetch<{ path: string }[]>(config, AUTH, '/api/v3/rootfolder')
      return (folders ?? []).map(f => f.path)
    },
    async deleteSeriesFiles(seriesId: number): Promise<DeleteFileResult> {
      const files = await sourceFetch<SonarrEpisodeFile[]>(config, AUTH, '/api/v3/episodefile', {
        query: { seriesId }
      })
      // Unmonitor BEFORE deleting files, not after — a successful DELETE followed by a failed PUT
      // would leave the series monitored with its files gone, and Sonarr would immediately re-grab
      // what was just deleted. Re-acquisition is expected to happen via the downstream placeholder
      // tool's play-triggered re-request instead.
      const series = await sourceFetch<Record<string, unknown>>(config, AUTH, `/api/v3/series/${seriesId}`)
      if (series) {
        series.monitored = false
        await sourceFetch(config, AUTH, `/api/v3/series/${seriesId}`, { method: 'PUT', body: series })
      }
      let deletedBytes = 0
      for (const f of files ?? []) {
        deletedBytes += f.size ?? 0
        await sourceFetch(config, AUTH, `/api/v3/episodefile/${f.id}`, { method: 'DELETE' })
      }
      return { deletedBytes }
    }
  }
}
