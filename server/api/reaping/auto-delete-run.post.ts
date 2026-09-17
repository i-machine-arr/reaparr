import { getDb } from '../../db/client'
import { runAutoDeletePass } from '../../reaping/autoDelete'

// Manual trigger for the disk-threshold auto-delete pass, so it can be verified safely before
// trusting the hourly schedule (server/tasks/space-check.ts). Runs even if disabled in settings —
// the pass itself no-ops immediately when disabled, which is the useful signal to see here.
export default defineEventHandler(async () => {
  const counts = await runAutoDeletePass(getDb())
  return { ok: true, counts }
})
