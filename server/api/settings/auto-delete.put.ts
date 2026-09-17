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
  if (typeof body?.thresholdPercent === 'number' && Number.isFinite(body.thresholdPercent) && body.thresholdPercent > 0 && body.thresholdPercent <= 100) {
    upsert(db, 'reaping_disk_threshold_percent', String(Math.round(body.thresholdPercent)))
  }
  if (typeof body?.maxDeletesPerRun === 'number' && Number.isFinite(body.maxDeletesPerRun) && body.maxDeletesPerRun >= 0) {
    upsert(db, 'reaping_max_deletes_per_run', String(Math.round(body.maxDeletesPerRun)))
  }

  return { ok: true }
})
