import { getDb } from '../../db/client'
import { getAutoDeleteSettings } from '../../reaping/autoDelete'

export default defineEventHandler(() => {
  const settings = getAutoDeleteSettings(getDb())
  return {
    enabled: settings.enabled,
    thresholdPercent: settings.thresholdPercent,
    maxDeletesPerRun: settings.maxDeletesPerRun
  }
})
