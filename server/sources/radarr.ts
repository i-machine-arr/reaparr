import { sourceFetch } from './http'
import type {
  AuthInjection, ConnectionConfig, DeleteFileResult, NormalizedMovie, NormalizedDiskSpace,
  ProbeResult, RadarrClient
} from './types'

const AUTH: AuthInjection = { kind: 'header', name: 'X-Api-Key' }

// NOTE: /api/v3/rootfolder does NOT report totalSpace on real Radarr (freeSpace only) — confirmed
// against a real instance, not just assumed. /api/v3/diskspace is the endpoint that reports both.
interface RadarrDiskSpace { path: string, freeSpace?: number, totalSpace?: number }

// Each rating child is { votes, value, type }. imdb/tmdb are 0–10; rottenTomatoes
// is the critic score as a percentage (0–100).
interface RadarrRatingChild { votes?: number, value?: number, type?: string }

interface RadarrMovie {
  id: number
  title: string
  year?: number
  tmdbId?: number
  imdbId?: string
  sizeOnDisk?: number
  hasFile?: boolean
  added?: string
  ratings?: { imdb?: RadarrRatingChild, tmdb?: RadarrRatingChild, rottenTomatoes?: RadarrRatingChild }
  statistics?: { sizeOnDisk?: number }
}

function normalizeMovie(m: RadarrMovie): NormalizedMovie {
  return {
    sourceId: m.id,
    title: m.title,
    year: m.year ?? null,
    tmdbId: m.tmdbId ?? null,
    imdbId: m.imdbId ?? null,
    addedAt: m.added ?? null,
    sizeOnDisk: m.sizeOnDisk ?? m.statistics?.sizeOnDisk ?? 0,
    hasFile: m.hasFile ?? false,
    rating: m.ratings?.tmdb?.value ?? null,
    ratingImdb: m.ratings?.imdb?.value ?? null,
    ratingRt: m.ratings?.rottenTomatoes?.value ?? null
  }
}

export function createRadarrClient(config: ConnectionConfig): RadarrClient {
  return {
    source: 'radarr',
    async probe(): Promise<ProbeResult> {
      try {
        const status = await sourceFetch<{ version?: string }>(config, AUTH, '/api/v3/system/status')
        return { ok: true, message: `Radarr ${status?.version ?? ''}`.trim() }
      } catch (err) {
        return { ok: false, message: (err as Error).message }
      }
    },
    async getMovies(): Promise<NormalizedMovie[]> {
      const movies = await sourceFetch<RadarrMovie[]>(config, AUTH, '/api/v3/movie')
      return (movies ?? []).map(normalizeMovie)
    },
    async getDiskSpace(): Promise<NormalizedDiskSpace[]> {
      const disks = await sourceFetch<RadarrDiskSpace[]>(config, AUTH, '/api/v3/diskspace')
      // Skip entries with a missing/non-finite freeSpace or totalSpace rather than defaulting to 0
      // — a defaulted freeSpace: 0 against a real, positive totalSpace looks like 100% used and can
      // wrongly authorize deletion off incomplete data instead of a genuine full disk.
      return (disks ?? [])
        .filter((d): d is Required<RadarrDiskSpace> =>
          typeof d.path === 'string' && Number.isFinite(d.freeSpace) && Number.isFinite(d.totalSpace))
        .map(d => ({ path: d.path, freeSpace: d.freeSpace, totalSpace: d.totalSpace }))
    },
    async getRootFolderPaths(): Promise<string[]> {
      const folders = await sourceFetch<{ path: string }[]>(config, AUTH, '/api/v3/rootfolder')
      return (folders ?? []).map(f => f.path)
    },
    async deleteMovieFile(movieId: number): Promise<DeleteFileResult> {
      const movie = await sourceFetch<Record<string, unknown> & { movieFile?: { id: number, size?: number } }>(
        config, AUTH, `/api/v3/movie/${movieId}`
      )
      if (!movie?.movieFile) return { deletedBytes: 0, unknownSize: false }
      // Reject a malformed movieFile (missing numeric id) BEFORE unmonitoring — otherwise the PUT
      // still goes through, then the DELETE fails against an undefined id, leaving the movie
      // unmonitored with its file still present.
      if (!Number.isInteger(movie.movieFile.id)) {
        throw new Error('Invalid Radarr movie file response')
      }
      const unknownSize = !Number.isFinite(movie.movieFile.size)
      const deletedBytes = unknownSize ? 0 : movie.movieFile.size!
      const movieFileId = movie.movieFile.id
      // Unmonitor BEFORE deleting the file, not after — same reasoning as Sonarr's
      // deleteSeriesFiles: a successful DELETE followed by a failed PUT would leave the movie
      // monitored with its file gone, and Radarr would immediately re-grab it.
      movie.monitored = false
      await sourceFetch(config, AUTH, `/api/v3/movie/${movieId}`, { method: 'PUT', body: movie })
      await sourceFetch(config, AUTH, `/api/v3/moviefile/${movieFileId}`, { method: 'DELETE' })
      return { deletedBytes, unknownSize }
    }
  }
}
