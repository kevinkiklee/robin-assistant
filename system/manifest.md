# File Catalog

The v3 layout separates immutable framework code from user data. This manifest lists every well-known path and its purpose. Use it as the canonical map.

## System (`system/`)

Framework files. Tracked in git, updated via `git pull`. Do not edit by hand — local edits collide with upstream updates.

| Path | Purpose |
|------|---------|
| `system/AGENTS.md` (root pointer) | Agent rules and session instructions (the actual file lives at repo root as `AGENTS.md`). |
| `system/startup.md` | Session startup protocol — pre-flight check, sequence, first-run detection. |
| `system/capture-rules.md` | Capture signal patterns, inbox-first pipeline, routing table, sweep protocol. |
| `system/manifest.md` | This file — canonical catalog of every well-known path. |
| `system/self-improvement-rules.md` | How Robin processes corrections, patterns, preferences, calibration. |
| `system/operations/` | On-demand operational workflows (Dream, Morning Briefing, etc.). |
| `system/operations/INDEX.md` | Auto-generated index of operations (regenerate via `regenerate-operations-index.js`). |
| `system/operations/dream.md` | Background processing — inbox routing, pattern promotion, integrity check. |
| `system/operations/morning-briefing.md` | Daily briefing protocol. |
| `system/operations/weekly-review.md` | Weekly review protocol. |
| `system/operations/email-triage.md` | Inbox triage protocol. |
| `system/operations/meeting-prep.md` | Meeting preparation protocol. |
| `system/operations/multi-session-coordination.md` | Coordination rules when multiple Robin sessions are active. |
| `system/operations/monthly-financial.md` | Monthly financial check-in protocol. |
| `system/operations/quarterly-self-assessment.md` | Quarterly self-assessment protocol. |
| `system/operations/receipt-tracking.md` | Receipt tracking protocol. |
| `system/operations/subscription-audit.md` | Subscription audit protocol. |
| `system/operations/system-maintenance.md` | Workspace maintenance protocol. |
| `system/operations/todo-extraction.md` | Todo extraction protocol. |
| `system/scripts/` | CLI helpers — setup, backup, restore, migrate, regenerate, startup-check, install-hooks. |
| `system/scripts/setup.js` | First-run installer (postinstall). Scaffolds `user-data/` from skeleton. |
| `system/scripts/startup-check.js` | Session pre-flight: validates env, surfaces FATAL/INFO/WARN findings. |
| `system/scripts/backup.js` | Snapshot `user-data/` into `backup/`. |
| `system/scripts/restore.js` | Restore `user-data/` from a `backup/` snapshot. |
| `system/scripts/reset.js` | Wipe `user-data/` (destructive — backup first). |
| `system/scripts/migrate.js` | Apply pending migrations from `system/migrations/` (auto-runs on session start). |
| `system/scripts/install-hooks.js` | Install the `pre-commit` hook into `.git/hooks/` (auto-runs on `npm install`). |
| `system/scripts/pre-commit-hook.js` | Pre-commit hook source — refuses to commit `user-data/` files. |
| `system/scripts/regenerate-pointers.js` | Regenerate platform pointer files from `platforms.js`. |
| `system/scripts/regenerate-operations-index.js` | Regenerate `system/operations/INDEX.md` from frontmatter. |
| `system/scripts/regenerate-memory-index.js` | Regenerate `user-data/memory/INDEX.md` from per-file frontmatter. Supports `--check` for CI. |
| `system/scripts/lib/memory-index.js` | Shared helpers — frontmatter parse, slug, threshold, link rewrite, split planner. |
| `system/migrations/` | Numbered migration scripts applied at startup. |
| `system/skeleton/` | Default `user-data/` layout copied during `setup.js` first run. |

## User-data (`user-data/`)

User-specific persistent memory. Local-only by gitignore + pre-commit hook. Edit freely.

| Path | Purpose |
|------|---------|
| `user-data/robin.config.json` | User name, timezone, email, assistant name, threshold settings. |
| `user-data/memory/INDEX.md` | Generated directory of topic files. Read at startup to map the memory tree. |
| `user-data/memory/profile/` | Identity, personality, interests, people, goals, routines, work, etc. (one topic file per area). |
| `user-data/memory/knowledge/` | Reference facts — locations, medical, projects, restaurants, recipes, etc. |
| `user-data/memory/events/` | Dated events — trips, attended events. |
| `user-data/memory/tasks.md` | Active tasks grouped by category. |
| `user-data/memory/decisions.md` | Decision log (append-only; exempt from threshold splits). |
| `user-data/memory/journal.md` | Dated reflections (append-only; exempt from threshold splits). |
| `user-data/memory/self-improvement.md` | Corrections, patterns, session handoff, calibration log. |
| `user-data/memory/inbox.md` | Quick capture for unclassified items (append-only). |
| `user-data/integrations.md` | Available external capabilities per platform. |
| `user-data/custom-rules.md` | Optional. User-defined behavioral additions; loaded at session start. |
| `user-data/state/` | Runtime state — session registry, Dream state, locks. |
| `user-data/state/sessions.md` | Active session registry. |
| `user-data/state/dream-state.md` | Last Dream cycle timestamp and bookkeeping. |
| `user-data/operations/` | Optional. User-defined or overriding operations; precedence over `system/operations/`. |

## Artifacts (`artifacts/`)

Workspace-scoped scratch space for files that aren't memory.

| Path | Purpose |
|------|---------|
| `artifacts/input/` | User-provided inputs. Read only when the user references a file by name. |
| `artifacts/output/` | Generated outputs (PDFs, exports, scripts, summary docs, images). |

## Backup (`backup/`)

Local-only snapshots of `user-data/`. Created by `npm run backup`, restored by `npm run restore`. Migrations may also write pre-migration snapshots here.

| Path | Purpose |
|------|---------|
| `backup/<YYYYMMDD-HHMMSS>/` | Timestamped snapshot of `user-data/` at backup time. |
