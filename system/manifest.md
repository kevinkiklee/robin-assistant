# File Catalog

The v3 layout separates immutable framework code from user data. Use this manifest as the canonical map of well-known paths.

## System (`system/`) — framework, tracked in git, do not edit by hand

| Path | Purpose |
|------|---------|
| `AGENTS.md` (root) | Agent rules + Tier 2 pointer table. Source of truth for all hosts. |
| `system/startup.md` | Edge cases — first-run, sibling-session detection. (Sequence inlined in AGENTS.md.) |
| `system/capture-rules.md` | Full capture vocabulary, routing table, sweep protocol. (5-line checkpoint inlined in AGENTS.md.) |
| `system/manifest.md` | This file. |
| `system/self-improvement-rules.md` | How Robin processes corrections, patterns, preferences. |
| `system/jobs/` | Agent + node job definitions. Schedulable and trigger-invocable. |
| `system/migrations/` | Numbered migrations. Auto-applied at startup via `migrate.js`. |
| `system/skeleton/` | Default `user-data/` layout copied on first run. |
| `system/integrations/` | Per-provider setup playbooks (Google, GitHub, Spotify, Lunch Money, Discord). Reference docs distributed with the package. |
| `bin/robin.js` | CLI entry: `robin run <name>`, `robin jobs ...`, `robin job acquire/release`. |
| `system/scripts/jobs/runner.js` | OS-scheduler entry. Parses, gates, locks, executes, surfaces failures. |
| `system/scripts/jobs/reconciler.js` | Syncs OS scheduler entries with `system/jobs/` + `user-data/jobs/`. Runs every 6h. |
| `system/scripts/jobs/cli.js` | `robin jobs ...` subcommand impls. |
| `system/scripts/jobs/installer/` | launchd / cron / Task Scheduler adapters. |
| `system/scripts/lib/jobs/` | Frontmatter parser, cron parser, atomic locks, state writers, OS notifications. |
| `system/scripts/lib/sync/` | Personal-data integration infra — secrets, cursor state, redaction, HTTP retry, atomic writes, INDEX regen, OAuth2. |
| `system/scripts/lib/parsers/` | Per-host transcript parsers for `validate-host.js`. |
| `system/scripts/measure-tokens.js` | Token-budget harness (Phase 0). |
| `system/scripts/validate-host.js` | Multi-host scenario validator (Phase 1). |
| `system/scripts/setup.js` | First-run installer (postinstall). |
| `system/scripts/lib/preflight.js` | Session pre-flight pipeline — 5 steps: config-migrate, pending-migrations, validate, skeleton-sync, changelog-notify. Returns `{ findings }`. |
| `system/scripts/startup-check.js` | Deprecation shim. Re-exports `runStartupCheck` wrapping `runPreflight`. Will be deleted in a future minor version. |
| `system/scripts/migrate.js` | Apply pending migrations (auto-runs on session start). |
| `system/scripts/backup.js` / `restore.js` / `reset.js` | Snapshot, restore, wipe `user-data/`. |
| `system/scripts/regenerate-pointers.js` | Regenerate per-host pointer files from `platforms.js`. |
| `system/scripts/regenerate-memory-index.js` | Regenerate `user-data/memory/INDEX.md`. Sub-tree barriers stop at `INDEX.md`. |
| `system/scripts/regenerate-links.js` | Regenerate `user-data/memory/LINKS.md`. |
| `system/scripts/install-hooks.js` | Install `pre-commit` hook. |
| `system/scripts/pre-commit-hook.js` | Refuses to commit `user-data/`. |
| `system/scripts/lib/memory-index.js` | Frontmatter parse, slug, threshold, link rewrite, split planner. |
| `system/scripts/lib/watches.js` | Watch lib: slugify, path helpers, frontmatter parse/serialize, listWatches, state I/O. |
| `system/scripts/watches/cli.js` | `robin watch ...` subcommand impls (add/list/enable/disable/tail/run). |
| `system/jobs/watch-topics.md` | Hourly agent job: iterates active watches, fetches via WebSearch, dedupes, writes `[watch:<id>]` inbox items. |

## User-data (`user-data/`) — local-only, gitignored

| Path | Purpose |
|------|---------|
| `user-data/robin.config.json` | User name, timezone, email, assistant name, threshold settings. |
| `user-data/memory/INDEX.md` | Memory tree map — opens at session start. Sub-trees with their own `INDEX.md` are linked, not enumerated. |
| `user-data/memory/LINKS.md` | Cross-reference graph. On-demand only. |
| `user-data/memory/log.md` | Append-only ops log (ingests, lints, filings). |
| `user-data/memory/hot.md` | Rolling 2-3 session context. Loaded at startup. |
| `user-data/memory/profile/` | Identity, personality, interests, people, goals, routines, work, photography, preferences. |
| `user-data/memory/knowledge/` | Reference facts. Sub-indexed: `lunch-money/`, `photography-collection/`, `events/`. |
| `user-data/memory/knowledge/sources/` | Ingested source summaries. |
| `user-data/memory/knowledge/conversations/` | Conversation summaries from save-conversation. |
| `user-data/memory/self-improvement/` | Per-section: corrections, preferences, calibration, session-handoff, communication-style, domain-confidence, learning-queue. |
| `user-data/memory/decisions.md` | Append-only decision log. |
| `user-data/memory/journal.md` | Append-only daily reflections. |
| `user-data/memory/inbox.md` | Quick capture (append-only); Dream routes. |
| `user-data/memory/tasks.md` | Active tasks grouped by category. |
| `user-data/memory/archive/` | Pruned content. `archive/INDEX.md` is the cold-storage catalog. |
| `user-data/integrations.md` | Available external capabilities per platform. |
| `user-data/custom-rules.md` | Optional. User-defined rules; loaded at startup. Cannot override Immutable Rules. |
| `user-data/state/sessions.md` | Active session registry. |
| `user-data/state/dream-state.md` | Last Dream cycle bookkeeping. |
| `user-data/state/jobs/INDEX.md` | Auto-generated jobs dashboard. |
| `user-data/state/jobs/upcoming.md` | 7-day forward calendar of scheduled runs. |
| `user-data/state/jobs/failures.md` | Per-job failure register. |
| `user-data/state/jobs/<name>.json` | Per-job state — last_run_at, exit_code, status, next_run_at, consecutive_failures. |
| `user-data/memory/watches/` | One `.md` file per watch. Frontmatter drives the watch-topics job. `INDEX.md` is the sub-index; `log.md` is the append-only hits feed. |
| `user-data/state/watches/` | Per-watch dedup state JSON — fingerprints ring buffer, last_run_at, consecutive_failures. |
| `user-data/jobs/` | User-defined job overrides + additions. Default convention is a shallow override (`override: <name>` frontmatter — only the fields you change, body inherits from system if empty). Full replacement (no `override:`) and brand-new jobs both supported. Same file format as `system/jobs/`. |
| `user-data/secrets/` | API keys; `.env`-style, gitignored. |

## Artifacts + Sources + Backup

| Path | Purpose |
|------|---------|
| `artifacts/input/` | User-provided inputs (ephemeral). On ingest, files move to `user-data/sources/`. |
| `artifacts/output/` | Generated outputs (PDFs, exports, scripts, summaries, images). |
| `user-data/sources/articles/` | Web clips, saved articles. |
| `user-data/sources/documents/` | PDFs, reports, statements. |
| `user-data/sources/notes/` | Freeform notes, meeting notes, transcriptions. |
| `user-data/sources/media/` | Images, screenshots referenced by wiki pages. |
| `backup/<YYYYMMDD-HHMMSS>/` | Local-only `user-data/` snapshots. Created by `npm run backup`. Migrations also write pre-migration snapshots. |
