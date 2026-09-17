# Coding Best Practices & Reminders

> **Style rule:** Notes must be clear and concise — 300 characters or less each. Group by topic, not by date. Whenever a PR review (CodeRabbit or human) catches a mistake, add or amend a note here right away so it isn't repeated.

Seeded from the shared `i-machine-things/.claude` template — the template's Python/PyQt-specific notes
(resource cleanup in GUI apps, PyInstaller builds) were dropped as not applicable to this Nuxt/TypeScript
project. Only the genuinely stack-agnostic notes carried over; add reaparr-specific findings below as real
reviews catch them.

## Branch Protection

- **GitHub branch protection requires a public repo, or GitHub Pro/Team/Enterprise, on private repos** — `PUT .../branches/.../protection` 403s with "Upgrade to GitHub Pro or make this repository public" otherwise.
- **Don't set required status-check contexts before the repo has CI that produces them.** A required context that never reports a status permanently blocks merges. This fork has no `.github/workflows/ci.yml` yet (see `.claude/CLAUDE.md` Rule 3) — add required checks only once real CI exists and is green.
- **Avoid `required_pull_request_reviews` on a solo-maintained repo.** GitHub won't let an author approve their own PR, so requiring even 1 approval with no other reviewer deadlocks every merge. Rely on required status checks instead of an approval-count gate.

## General Style Notes

- **Keep lines under 120 characters.** Long lines are hard to review side-by-side in a diff or split editor pane, and tend to signal a line doing too many things at once.
- **Comments explain *why*, not *what*.** The code already shows what it does — a comment worth writing covers intent, a hidden constraint, or a gotcha a future reader would otherwise have to rediscover the hard way. This matches the upstream project's own convention (see root `CLAUDE.md`), just stated generally here.

## reaparr-specific

- **Real *arr API responses can silently differ from assumed shapes.** `/api/v3/rootfolder` does not report `totalSpace` on real Sonarr/Radarr — only `/api/v3/diskspace` does. Caught by testing against a real instance, not the mock server, on the very first feature built in this fork. Always verify a new adapter method's real response shape before trusting it, per Rule 3.
