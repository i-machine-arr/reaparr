import { getDb, schema } from '../../db/client'

interface AutoDeleteBody {
  enabled?: boolean
  thresholdPercent?: number
  maxDeletesPerRun?: number
}

function upsert(db: ReturnType<typeof getDb>, key: string, value: string) {
  db.insert(schema.appSetting).values({ key, value })
    .onConflictDoUpdate({ target: schema.appSetting.key, set: { value } }).run()
}

export default defineEventHandler(async (event) => {
  const body = await readBody<AutoDeleteBody>(event)

  // Validate the whole request before writing anything — silently ignoring one bad field while
  // still returning { ok: true } for the others let a client believe a destructive-adjacent
  // configuration change (e.g. a new threshold) took effect when it didn't.
  let roundedThreshold: number | undefined
  if (body?.thresholdPercent !== undefined) {
    if (typeof body.thresholdPercent !== 'number' || !Number.isFinite(body.thresholdPercent)) {
      setResponseStatus(event, 400)
      return { ok: false, message: 'thresholdPercent must be a finite number' }
    }
    roundedThreshold = Math.round(body.thresholdPercent)
    if (roundedThreshold < 1 || roundedThreshold > 100) {
      setResponseStatus(event, 400)
      return { ok: false, message: 'thresholdPercent must round to 1-100' }
    }
  }

  let roundedMax: number | undefined
  if (body?.maxDeletesPerRun !== undefined) {
    if (typeof body.maxDeletesPerRun !== 'number' || !Number.isFinite(body.maxDeletesPerRun)) {
      setResponseStatus(event, 400)
      return { ok: false, message: 'maxDeletesPerRun must be a finite number' }
    }
    roundedMax = Math.round(body.maxDeletesPerRun)
    if (roundedMax < 0) {
      setResponseStatus(event, 400)
      return { ok: false, message: 'maxDeletesPerRun must round to 0 or more' }
    }
  }

  const db = getDb()
  if (typeof body?.enabled === 'boolean') {
    upsert(db, 'reaping_auto_delete_enabled', body.enabled ? '1' : '0')
  }
  if (roundedThreshold !== undefined) upsert(db, 'reaping_disk_threshold_percent', String(roundedThreshold))
  if (roundedMax !== undefined) upsert(db, 'reaping_max_deletes_per_run', String(roundedMax))

  return { ok: true }
})
