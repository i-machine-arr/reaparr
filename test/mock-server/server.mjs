// Mock source server (spec §12.3). Serves the canonical demo dataset at each
// source's REAL API paths + auth shapes, so the adapters, Test-connection, and
// full sync code paths run end-to-end with zero credentials.
//
//   node test/mock-server/server.mjs          # all four sources on one port
//   MOCK_PORT=8900 node test/mock-server/server.mjs
//
// Point every connection's base URL at http://localhost:<port> and use any
// non-empty API key.

import { createServer } from 'node:http'
import { buildDemoBundle } from '../../server/utils/demo-dataset.ts'

const PORT = Number(process.env.MOCK_PORT || 8900)
const VERSION = '1.0.0-mock'
// Pin "now" for deterministic tests; default to wall clock for interactive use.
const NOW = process.env.MOCK_NOW ? Number(process.env.MOCK_NOW) : null
const isoToEpoch = iso => (iso ? Math.floor(Date.parse(iso) / 1000) : 0)

// --- Mutable fake-filesystem state (auto-delete + Leaving Soon path testing) ------------------
// Built once at startup from the same demo bundle /api/v3/series and /api/v3/movie report, so a
// delete call here is consistent with what a real adapter fetched. One shared root folder — same
// simplification runAutoDeletePass itself makes (a single pool, matching a real deployment where
// Sonarr and Radarr point at the same physical disk).
const GB = 1024 ** 3
const seedBundle = buildDemoBundle(NOW ?? Date.now())
let rootFree = Number(process.env.MOCK_ROOT_FREE_BYTES ?? 20 * GB)
const rootTotal = Number(process.env.MOCK_ROOT_TOTAL_BYTES ?? 100 * GB)

const episodeFilesBySeries = new Map(seedBundle.series.map((s) => {
  const perEp = Math.floor(s.sizeOnDisk / Math.max(1, s.downloadedEpisodes))
  const files = Array.from({ length: s.downloadedEpisodes }, (_, i) => ({ id: s.sourceId * 1000 + i, size: perEp }))
  return [s.sourceId, files]
}))
const seriesMonitored = new Map(seedBundle.series.map(s => [s.sourceId, true]))
const movieFileByMovie = new Map(seedBundle.movies.filter(m => m.hasFile).map(m => [m.sourceId, { id: m.sourceId + 9000, size: m.sizeOnDisk }]))
const movieMonitored = new Map(seedBundle.movies.map(m => [m.sourceId, true]))

// --- Mutable fake Jellyfin state (Leaving Soon path testing) ----------------------------------
const JELLYFIN_USER_ID = 'mock-admin'
let leavingSoonCollectionId = null
const leavingSoonMembers = new Set()
function jellyfinItemId(kind, sourceId) {
  return `${kind}-${sourceId}`
}
function jellyfinLibraryItems() {
  return [
    ...seedBundle.series.map(s => ({
      Id: jellyfinItemId('series', s.sourceId), Type: 'Series',
      ProviderIds: { Tvdb: String(s.tvdbId), Tmdb: String(s.tmdbId) },
      UserData: { Played: false }
    })),
    ...seedBundle.movies.map(m => ({
      Id: jellyfinItemId('movie', m.sourceId), Type: 'Movie',
      ProviderIds: { Tmdb: String(m.tmdbId) },
      UserData: { Played: false }
    }))
  ]
}
async function readJsonBody(req) {
  let raw = ''
  for await (const chunk of req) raw += chunk
  return raw ? JSON.parse(raw) : {}
}

function reshapeSeries(s) {
  return {
    id: s.sourceId, title: s.title, year: s.year, tvdbId: s.tvdbId, tmdbId: s.tmdbId, imdbId: s.imdbId,
    titleSlug: s.title.toLowerCase().replace(/\s+/g, '-'), added: s.addedAt, status: s.status,
    ended: s.status === 'ended', seriesType: s.seriesType,
    ratings: { votes: 100, value: s.rating },
    statistics: {
      seasonCount: s.seasonCount, episodeFileCount: s.downloadedEpisodes, episodeCount: s.downloadedEpisodes,
      totalEpisodeCount: s.downloadedEpisodes, sizeOnDisk: s.sizeOnDisk, percentOfEpisodes: 100
    },
    seasons: s.seasons.map(se => ({ seasonNumber: se.seasonNumber, statistics: { sizeOnDisk: se.sizeOnDisk, episodeFileCount: se.episodeFiles } }))
  }
}
function reshapeMovie(m) {
  return { id: m.sourceId, title: m.title, year: m.year, tmdbId: m.tmdbId, imdbId: m.imdbId, sizeOnDisk: m.sizeOnDisk, hasFile: m.hasFile, added: m.addedAt, ratings: { tmdb: { value: m.rating }, imdb: { value: m.ratingImdb }, rottenTomatoes: { value: m.ratingRt } }, statistics: { sizeOnDisk: m.sizeOnDisk } }
}
function reshapeSeerrUser(u) {
  return { id: Number(u.sourceUserId), email: u.email, plexUsername: u.username, username: u.username, displayName: u.friendlyName }
}
function reshapeRequest(r) {
  return { id: r.seerrId, status: r.status, type: r.mediaType, createdAt: r.requestedAt, media: { tmdbId: r.tmdbId, tvdbId: r.tvdbId, mediaType: r.mediaType }, requestedBy: r.requester ? reshapeSeerrUser(r.requester) : null }
}
function reshapeHistoryRow(h) {
  return { date: isoToEpoch(h.lastWatchedAt), stopped: isoToEpoch(h.lastWatchedAt), user_id: Number(h.userId), user: h.username, friendly_name: h.friendlyName, media_type: h.mediaType, rating_key: Number(h.ratingKey), grandparent_rating_key: h.grandparentRatingKey != null ? Number(h.grandparentRatingKey) : null, watched_status: h.watchedStatus, percent_complete: h.percentComplete }
}
function reshapeTautUser(u) {
  return { user_id: Number(u.sourceUserId), username: u.username, friendly_name: u.friendlyName, email: u.email }
}
function guidsFor(m) {
  const g = []
  if (m.imdbId) g.push(`imdb://${m.imdbId}`)
  if (m.tmdbId) g.push(`tmdb://${m.tmdbId}`)
  if (m.tvdbId) g.push(`tvdb://${m.tvdbId}`)
  return g
}

function send(res, status, body) {
  const json = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(json)
}

async function handle(req, res) {
  const bundle = buildDemoBundle(NOW ?? Date.now())
  const u = new URL(req.url, `http://localhost:${PORT}`)
  const path = u.pathname
  const q = u.searchParams

  // --- Sonarr ---------------------------------------------------------------
  if (path === '/api/v3/system/status') {
    // Shared by Sonarr & Radarr probes.
    return send(res, 200, { appName: 'Mock', version: VERSION })
  }
  if (path === '/api/v3/series') {
    return send(res, 200, bundle.series.map(reshapeSeries))
  }
  if (path === '/api/v3/movie') {
    return send(res, 200, bundle.movies.map(reshapeMovie))
  }
  if (path === '/api/v3/rootfolder') {
    return send(res, 200, [{ path: '/data', freeSpace: rootFree, totalSpace: rootTotal }])
  }
  if (path === '/api/v3/episodefile') {
    const seriesId = Number(q.get('seriesId'))
    return send(res, 200, episodeFilesBySeries.get(seriesId) ?? [])
  }
  {
    const m = /^\/api\/v3\/episodefile\/(\d+)$/.exec(path)
    if (m && req.method === 'DELETE') {
      const id = Number(m[1])
      for (const files of episodeFilesBySeries.values()) {
        const idx = files.findIndex(f => f.id === id)
        if (idx >= 0) {
          rootFree += files[idx].size
          files.splice(idx, 1)
          break
        }
      }
      return send(res, 200, {})
    }
  }
  {
    const m = /^\/api\/v3\/series\/(\d+)$/.exec(path)
    if (m) {
      const seriesId = Number(m[1])
      const s = seedBundle.series.find(x => x.sourceId === seriesId)
      if (!s) return send(res, 404, { error: 'not found' })
      if (req.method === 'PUT') {
        const body = await readJsonBody(req)
        seriesMonitored.set(seriesId, body.monitored !== false)
        return send(res, 200, body)
      }
      return send(res, 200, { ...reshapeSeries(s), monitored: seriesMonitored.get(seriesId) ?? true })
    }
  }
  {
    const m = /^\/api\/v3\/movie\/(\d+)$/.exec(path)
    if (m) {
      const movieId = Number(m[1])
      const mv = seedBundle.movies.find(x => x.sourceId === movieId)
      if (!mv) return send(res, 404, { error: 'not found' })
      if (req.method === 'PUT') {
        const body = await readJsonBody(req)
        movieMonitored.set(movieId, body.monitored !== false)
        return send(res, 200, body)
      }
      const file = movieFileByMovie.get(movieId)
      return send(res, 200, { ...reshapeMovie(mv), monitored: movieMonitored.get(movieId) ?? true, movieFile: file ?? undefined })
    }
  }
  {
    const m = /^\/api\/v3\/moviefile\/(\d+)$/.exec(path)
    if (m && req.method === 'DELETE') {
      const id = Number(m[1])
      for (const [movieId, file] of movieFileByMovie) {
        if (file.id === id) {
          rootFree += file.size
          movieFileByMovie.delete(movieId)
          break
        }
      }
      return send(res, 200, {})
    }
  }

  // --- Jellyfin ---------------------------------------------------------------
  if (path === '/System/Info') {
    return send(res, 200, { Version: VERSION })
  }
  if (path === '/Users' && !path.includes('/Items')) {
    return send(res, 200, [{ Id: JELLYFIN_USER_ID, Name: 'admin' }])
  }
  {
    const m = /^\/Users\/[^/]+\/Items$/.exec(path)
    if (m) {
      return send(res, 200, { Items: jellyfinLibraryItems() })
    }
  }
  {
    const m = /^\/Items\/([^/]+)$/.exec(path)
    if (m && path !== '/Items') {
      const item = jellyfinLibraryItems().find(i => i.Id === m[1])
      if (!item) return send(res, 404, { error: 'not found' })
      return send(res, 200, item)
    }
  }
  if (path === '/Items') {
    if (q.get('IncludeItemTypes') === 'BoxSet') {
      const items = leavingSoonCollectionId ? [{ Id: leavingSoonCollectionId, Name: 'Leaving Soon' }] : []
      return send(res, 200, { Items: items })
    }
    const parentId = q.get('ParentId')
    if (parentId && parentId === leavingSoonCollectionId) {
      return send(res, 200, { Items: [...leavingSoonMembers].map(id => ({ Id: id })) })
    }
    return send(res, 200, { Items: [] })
  }
  if (path === '/Collections' && req.method === 'POST') {
    leavingSoonCollectionId = 'leaving-soon-collection'
    for (const id of (q.get('Ids') ?? '').split(',').filter(Boolean)) leavingSoonMembers.add(id)
    return send(res, 200, { Id: leavingSoonCollectionId })
  }
  {
    const m = /^\/Collections\/([^/]+)\/Items$/.exec(path)
    if (m) {
      const ids = (q.get('Ids') ?? '').split(',').filter(Boolean)
      if (req.method === 'POST') ids.forEach(id => leavingSoonMembers.add(id))
      if (req.method === 'DELETE') ids.forEach(id => leavingSoonMembers.delete(id))
      return send(res, 200, {})
    }
  }

  // --- Seerr ----------------------------------------------------------------
  if (path === '/api/v1/status') {
    return send(res, 200, { version: VERSION })
  }
  if (path === '/api/v1/request') {
    const take = Number(q.get('take') || 50)
    const skip = Number(q.get('skip') || 0)
    const all = bundle.requests.map(reshapeRequest)
    const page = all.slice(skip, skip + take)
    return send(res, 200, { pageInfo: { pages: Math.ceil(all.length / take), page: skip / take + 1, results: all.length }, results: page })
  }
  if (path === '/api/v1/user') {
    const take = Number(q.get('take') || 50)
    const skip = Number(q.get('skip') || 0)
    const all = bundle.seerrUsers.map(reshapeSeerrUser)
    const page = all.slice(skip, skip + take)
    return send(res, 200, { pageInfo: { pages: Math.ceil(all.length / take), results: all.length }, results: page })
  }

  // --- Tautulli (cmd-style) -------------------------------------------------
  if (path === '/api/v2') {
    const apikey = q.get('apikey')
    if (!apikey) return send(res, 200, { response: { result: 'error', message: 'Invalid apikey' } })
    const cmd = q.get('cmd')
    if (cmd === 'get_server_info') {
      return send(res, 200, { response: { result: 'success', data: { pms_name: 'MockPlex', pms_version: VERSION } } })
    }
    if (cmd === 'get_users') {
      return send(res, 200, { response: { result: 'success', data: bundle.tautulliUsers.map(reshapeTautUser) } })
    }
    if (cmd === 'get_history') {
      const length = Number(q.get('length') || 100)
      const start = Number(q.get('start') || 0)
      const after = q.get('after')
      let rows = bundle.history.map(reshapeHistoryRow)
      if (after) {
        const cutoff = Date.parse(`${after}T00:00:00Z`) / 1000
        rows = rows.filter(r => r.stopped >= cutoff)
      }
      const page = rows.slice(start, start + length)
      return send(res, 200, { response: { result: 'success', data: { recordsFiltered: rows.length, recordsTotal: rows.length, data: page } } })
    }
    if (cmd === 'get_metadata') {
      const ratingKey = q.get('rating_key')
      const m = ratingKey ? await bundle.resolveMetadata(ratingKey) : null
      if (!m) return send(res, 200, { response: { result: 'success', data: {} } })
      return send(res, 200, { response: { result: 'success', data: { rating_key: m.ratingKey, grandparent_rating_key: m.grandparentRatingKey, media_type: m.mediaType, guids: guidsFor(m) } } })
    }
    return send(res, 200, { response: { result: 'error', message: `Unknown cmd ${cmd}` } })
  }

  send(res, 404, { error: 'not found', path })
}

createServer((req, res) => {
  handle(req, res).catch((err) => {
    send(res, 500, { error: String(err?.message || err) })
  })
}).listen(PORT, () => {
  console.log(`[mock] Reaparr mock source server on http://localhost:${PORT}`)
  console.log('[mock] Sonarr/Radarr: /api/v3/* · Seerr: /api/v1/* · Tautulli: /api/v2?cmd=...')
})
