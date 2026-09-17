import { sourceFetch } from './http'
import type {
  AuthInjection, ConnectionConfig, DeleteFileResult, NormalizedMovie, NormalizedRootFolder,
  ProbeResult, RadarrClient
} from './types'

const AUTH: AuthInjection = { kind: 'header', name: 'X-Api-Key' }

interface RadarrRootFolder { path: string, freeSpace?: number, totalSpace?: number }

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
    async getRootFolders(): Promise<NormalizedRootFolder[]> {
      const folders = await sourceFetch<RadarrRootFolder[]>(config, AUTH, '/api/v3/rootfolder')
      return (folders ?? []).map(f => ({
        path: f.path,
        freeSpace: f.freeSpace ?? 0,
        totalSpace: f.totalSpace ?? 0
      }))
    },
    async deleteMovieFile(movieId: number): Promise<DeleteFileResult> {
      const movie = await sourceFetch<Record<string, unknown> & { movieFile?: { id: number, size?: number } }>(
        config, AUTH, `/api/v3/movie/${movieId}`
      )
      if (!movie?.movieFile) return { deletedBytes: 0 }
      const deletedBytes = movie.movieFile.size ?? 0
      await sourceFetch(config, AUTH, `/api/v3/moviefile/${movie.movieFile.id}`, { method: 'DELETE' })
      // Unmonitor so Radarr doesn't immediately re-grab what we just deleted — same reasoning as
      // Sonarr's deleteSeriesFiles.
      movie.monitored = false
      delete movie.movieFile
      await sourceFetch(config, AUTH, `/api/v3/movie/${movieId}`, { method: 'PUT', body: movie })
      return { deletedBytes }
    }
  }
}
