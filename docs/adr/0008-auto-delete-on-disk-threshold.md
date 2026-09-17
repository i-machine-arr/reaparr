# ADR-0008 — Auto-delete on disk threshold, and Leaving Soon via native collections

**Status:** Accepted (2026-09-16)

## Context

The reaping workflow (ADR-0001) already tracks titles through `eligible -> scheduled -> appealed ->
due -> removed`, but `due -> removed` (`markRemoved`) only ever flipped a database row and sent an
email — it never called Sonarr/Radarr, never deleted a file. The state machine assumed a human would
notice a title in "The Appointed Hour," delete it manually in the *arr, then click a button. That's a
deliberate MVP scope cut (this app is explicitly "read-only" per the README), but it means the actual
disk-management payoff — the reason to run this at all — never happened automatically.

Separately, the grace window (`scheduled`/`appealed`, `reaping_grace_days`) was internal-only: members
learn about it by email, but there's no equivalent of the "Leaving Soon" shelf a media server's own
front page can show.

## Decision

**Auto-delete.** A new hourly task checks, per *arr source with `due` titles, whether that source's
root folder is over a configurable threshold (`reaping_disk_threshold_percent`, default 75%, ships
**disabled** by default). If so, it deletes files for due titles — oldest-due first, up to a
configurable per-run cap (`reaping_max_deletes_per_run`) — via the *arr's own file-delete endpoint
(episode files / movie file), then sets `monitored: false`. It never deletes the catalog entry itself.

This deliberately mirrors an existing, working deployment pattern (a Janitorr + janitorr-stats +
Placeholdarr compose stack) rather than inventing a new one:
- **File-only delete, catalog survives unmonitored** — same as that stack's `only-delete-files: true`.
  This is what lets a tombstoned title in reaparr's own model resurrect cleanly (ADR-0002), and lets a
  downstream placeholder tool's normal *arr-webhook listener drop in a redownload-on-demand placeholder
  with zero new wiring on either side.
- **`monitored: false` is intentional**, not cleanup: it's what makes "play the placeholder ->
  re-request -> re-monitor + search" the correct re-acquisition path instead of the *arr silently
  re-grabbing what was just freed.
- **Space is read via each *arr's own `/rootfolder` endpoint**, never the filesystem — reaparr's
  container needs no media volume mount at all, unlike a symlink-based approach.
- **A hard per-run cap** is a genuine addition, not a copy: neither Janitorr nor Maintainerr support one
  (verified against both projects' source during that same prior deployment).
- **Runs hourly**, separate from the existing daily 03:00 full sync — that cadence is fine for
  score/eligibility freshness, far too slow for real disk-pressure response.

**Leaving Soon.** Titles in `scheduled`/`appealed` (the grace window) are synced into a "Leaving Soon"
collection on the media server itself, via each server's **native Collections API** — not a symlinked
library folder — so the API-only adapter architecture holds. Membership is *derived*: every run
recomputes the full desired set from current title state and diffs it against the collection's actual
contents (add missing, remove stale), rather than patching membership on each individual transition.
Simpler to reason about, and self-healing if a previous run's call failed partway.

This is where "it should work for anybody" (Plex, Jellyfin, Emby) meets reality: Tautulli — reaparr's
existing watch-history source — is read-only Plex monitoring with no collection-write capability at
all, and Jellyfin/Emby have no Tautulli equivalent (they report watch state and manage collections
natively). `TautulliClient` is generalized into a shared `MediaServerClient` interface
(`getHistory`/`getUsers`/`getMetadata`/`syncLeavingSoonCollection`), keyed on tmdb/tvdb ids rather than
any server-native rating key, so the abstraction doesn't leak Plex's shape into Jellyfin/Emby code.
**Phase 1** (this change) ships a fully working Jellyfin adapter against that interface — the
currently-real, currently-deployed target. Tautulli's own `syncLeavingSoonCollection` throws rather
than silently no-op-ing, since Plex collection writes need a *second*, direct Plex API adapter.
**Phase 2** (follow-up PRs, same interface): a direct Plex adapter and an Emby adapter — Emby's
protocol closely mirrors Jellyfin's (Jellyfin was originally forked from Emby), so expect substantial
reuse.

## Consequences

- No new architecture: auto-delete and Leaving Soon both reuse the existing state machine, adapter
  pattern, and `app_setting`/settings-page conventions rather than introducing new ones.
- The disk-threshold gate is a second, independent safety rail on top of the existing age+watched
  eligibility scoring and the grace/appeal workflow — a title only gets deleted once it has cleared
  all three, not just one.
- v1 uses the first root folder an *arr instance reports; multi-root-folder aggregation for an
  instance spanning physically distinct disks is a known simplification, not silently wrong.
- Plex and Emby users get watch-history/eligibility scoring today (unaffected by this change) but not
  Leaving Soon visibility until Phase 2 lands.
