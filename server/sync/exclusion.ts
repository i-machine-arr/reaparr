// Cross-workflow exclusion (CodeRabbit finding on PR #1, docs/adr/0008). Nitro runs same-cron-minute
// scheduled tasks in parallel with no ordering guarantee between them (verified against Nitro's
// source) — daily-sync and space-check both land near 03:00 with nothing stopping them overlapping.
// A sync run can change a title's eligibility (auto-reprieve on watch, tombstone/resurrection) at the
// exact moment auto-delete is mid-deletion against a stale snapshot of that same title. This is a
// simple FIFO queue, not per-resource locking: whichever of runSync/runAutoDeletePass starts first
// runs to completion before the other begins, regardless of which task or API route triggered it.

let chain: Promise<unknown> = Promise.resolve()

export function runExclusive<T>(fn: () => Promise<T>): Promise<T> {
  const result = chain.then(fn, fn)
  chain = result.then(() => undefined, () => undefined)
  return result
}
