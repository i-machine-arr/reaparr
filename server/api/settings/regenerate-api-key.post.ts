import { getDb } from '../../db/client'
import { regenerateApiKey, requireLocalOrApiKey } from '../../utils/security'

export default defineEventHandler((event) => {
  requireLocalOrApiKey(event)
  const apiKey = regenerateApiKey(getDb())
  return { ok: true, apiKey }
})
