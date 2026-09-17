import { getDb } from '../../db/client'
import { getAutoDeleteSettings } from '../../reaping/autoDelete'
import { getOrCreateApiKey, requireLocalOrApiKey } from '../../utils/security'

export default defineEventHandler((event) => {
  requireLocalOrApiKey(event) // this response includes the API key itself — must be gated too
  const settings = getAutoDeleteSettings(getDb())
  return {
    enabled: settings.enabled,
    thresholdPercent: settings.thresholdPercent,
    maxDeletesPerRun: settings.maxDeletesPerRun,
    apiKey: getOrCreateApiKey()
  }
})
