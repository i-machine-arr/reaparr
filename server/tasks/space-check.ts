// Hourly disk-threshold check (docs/adr/0008). Deliberately separate from daily-sync's 03:00 full
// pull — score/eligibility freshness is fine on a daily cadence, but disk pressure isn't, so this
// stays a slim task: read already-synced `due` titles, check *arr root-folder space, delete if over
// threshold. Skipped in demo mode, same as daily-sync.
import { getDb } from '../db/client'
import { runAutoDeletePass } from '../reaping/autoDelete'
import { isDemoMode } from '../utils/seed'

export default defineTask({
  meta: {
    name: 'space-check',
    description: 'Delete due titles\' files via Sonarr/Radarr once the media pool crosses the configured threshold'
  },
  async run() {
    if (isDemoMode()) return { result: 'skipped (demo mode)' }
    const counts = await runAutoDeletePass(getDb())
    return { result: `deleted ${counts.deleted}/${counts.evaluated} evaluated (${counts.failed} failed, ${counts.skippedUnderThreshold} under threshold)` }
  }
})
