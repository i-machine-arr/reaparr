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
  const db = getDb()

  if (typeof body?.enabled === 'boolean') {
    upsert(db, 'reaping_auto_delete_enabled', body.enabled ? '1' : '0')
  }
  // Round BEFORE validating, not after — validating the raw input let e.g. 0.4 pass a ">0" check
  // and then round down to 0, which means "unlimited" for the cap and "delete at any usage" for the
  // threshold. Validate the normalized integer that will actually be persisted.
  if (typeof body?.thresholdPercent === 'number' && Number.isFinite(body.thresholdPercent)) {
    const rounded = Math.round(body.thresholdPercent)
    if (rounded >= 1 && rounded <= 100) upsert(db, 'reaping_disk_threshold_percent', String(rounded))
  }
  if (typeof body?.maxDeletesPerRun === 'number' && Number.isFinite(body.maxDeletesPerRun)) {
    const rounded = Math.round(body.maxDeletesPerRun)
    if (rounded >= 0) upsert(db, 'reaping_max_deletes_per_run', String(rounded))
  }

  return { ok: true }
})
