# File Catalog

The v3 layout separates immutable framework code from user data. This manifest lists every well-known path and its purpose. Use it as the canonical map.

## System (`core/`)

Framework files. Tracked in git, updated via `git pull`. Do not edit by hand — local edits collide with upstream updates.

| Path | Purpose |
|------|---------|
| `core/AGENTS.md` (root pointer) | Agent rules and session instructions (the actual file lives at repo root as `AGENTS.md`). |
| `core/startup.md` | Session startup protocol — pre-flight check, sequence, first-run detection. |
| `core/capture-rules.md` | Capture signal patterns, inbox-first pipeline, routing table, sweep protocol. |
| `core/manifest.md` | This file — canonical catalog of every well-known path. |
| `core/self-improvement-rules.md` | How Robin processes corrections, patterns, preferences, calibration. |
| `core/operations/` | On-demand operational workflows (Dream, Morning Briefing, etc.). |
| `core/operations/INDEX.md` | Auto-generated index of operations (regenerate via `regenerate-operations-index.js`). |
| `core/operations/dream.md` | Background processing — inbox routing, pattern promotion, integrity check. |
| `core/operations/morning-briefing.md` | Daily briefing protocol. |
| `core/operations/weekly-review.md` | Weekly review protocol. |
| `core/operations/email-triage.md` | Inbox triage protocol. |
| `core/operations/meeting-prep.md` | Meeting preparation protocol. |
| `core/operations/multi-session-coordination.md` | Coordination rules when multiple Robin sessions are active. |
| `core/operations/monthly-financial.md` | Monthly financial check-in protocol. |
| `core/operations/quarterly-self-assessment.md` | Quarterly self-assessment protocol. |
| `core/operations/receipt-tracking.md` | Receipt tracking protocol. |
| `core/operations/subscription-audit.md` | Subscription audit protocol. |
| `core/operations/system-maintenance.md` | Workspace maintenance protocol. |
| `core/operations/todo-extraction.md` | Todo extraction protocol. |
| `core/scripts/` | CLI helpers — setup, backup, restore, migrate, regenerate, startup-check, install-hooks. |
| `core/scripts/setup.js` | First-run installer (postinstall). Scaffolds `user-data/` from skeleton. |
| `core/scripts/startup-check.js` | Session pre-flight: validates env, surfaces FATAL/INFO/WARN findings. |
| `core/scripts/backup.js` | Snapshot `user-data/` into `backup/`. |
| `core/scripts/restore.js` | Restore `user-data/` from a `backup/` snapshot. |
| `core/scripts/reset.js` | Wipe `user-data/` (destructive — backup first). |
| `core/scripts/migrate.js` | Apply pending migrations from `core/migrations/`. |
| `core/scripts/migrate-v3.js` | One-shot migration from v2 layout to v3 layout. |
| `core/scripts/migrate-index.js` | Index migration helper. |
| `core/scripts/install-hooks.js` | Install the `pre-commit` hook into `.git/hooks/`. |
| `core/scripts/pre-commit-hook.js` | Pre-commit hook source — refuses to commit `user-data/` files. |
| `core/scripts/regenerate-pointers.js` | Regenerate platform pointer files from `platforms.js`. |
| `core/scripts/regenerate-operations-index.js` | Regenerate `core/operations/INDEX.md` from frontmatter. |
| `core/migrations/` | Numbered migration scripts applied at startup. |
| `core/skeleton/` | Default `user-data/` layout copied during `setup.js` first run. |

## User-data (`user-data/`)

User-specific persistent memory. Local-only by gitignore + pre-commit hook. Edit freely.

| Path | Purpose |
|------|---------|
| `user-data/robin.config.json` | User name, timezone, email, assistant name, indexing status. |
| `user-data/profile.md` | Identity, personality, preferences, goals, people, routines. |
| `user-data/tasks.md` | Active tasks grouped by category. |
| `user-data/knowledge.md` | Reference facts — vendors, medical, locations, subscriptions. |
| `user-data/decisions.md` | Decision log (append-only). |
| `user-data/journal.md` | Dated reflections (append-only). |
| `user-data/self-improvement.md` | Corrections, patterns, session handoff, calibration log. |
| `user-data/inbox.md` | Quick capture for unclassified items (append-only). |
| `user-data/integrations.md` | Available external capabilities per platform. |
| `user-data/custom-rules.md` | Optional. User-defined behavioral additions; loaded at session start. |
| `user-data/trips/` | One file per trip (`<destination>-<month>-<year>.md`). |
| `user-data/state/` | Runtime state — session registry, Dream state, locks. |
| `user-data/state/sessions.md` | Active session registry. |
| `user-data/state/dream-state.md` | Last Dream cycle timestamp and bookkeeping. |
| `user-data/index/` | Sidecar index files (`<file>.idx.md`). |
| `user-data/operations/` | Optional. User-defined or overriding operations; precedence over `core/operations/`. |

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
