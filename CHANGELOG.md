# Changelog

## [Unreleased]

### Personal-data integrations — Phase 1 (shared sync lib + Lunch Money migration)

First step toward a hybrid sync/MCP integration system. Establishes the shared infrastructure all per-user integrations import from, and migrates the existing Lunch Money sync onto it.

#### Shared sync lib (`system/scripts/lib/sync/`)

Six small, focused modules — each independently tested:
- `secrets.js` — `loadSecrets`, `requireSecret`, atomic `saveSecret` (preserves comments, supports rotating refresh tokens).
- `cursor.js` — per-source state files at `user-data/state/sync/<name>.json` with shallow-merge `saveCursor`.
- `redact.js` — privacy patterns (US SSN, Canadian SIN, Luhn-checked credit cards, OpenAI/GitHub/Slack/AWS API keys, URL credentials).
- `http.js` — `fetchJson` with exponential backoff on 429/5xx and a typed `AuthError` that bails on 401/403.
- `markdown.js` — `atomicWrite` (redaction-aware via tmp+rename), `openItem` (lazy fetch), `writeTable`.
- `index-updater.js` — file-locked INDEX regen with stale-PID detection.

#### Per-user integration convention

Integration code now lives in `user-data/scripts/`, not `system/`. Each user can add an integration by dropping `user-data/jobs/<name>.md` + `user-data/scripts/<name>.js` and importing from `system/scripts/lib/sync/`. No `system/` changes required. Canonical templates ship from `system/skeleton/scripts/` and auto-copy into `user-data/` on first run via the existing skeleton-sync.

#### Lunch Money migration

- Code relocated: `system/scripts/fetch-lunch-money.js` → `user-data/scripts/sync-lunch-money.js`.
- Lib relocated: `lunch-money-client.js` and `finance-writer.js` → `user-data/scripts/lib/lunch-money/`.
- Job renamed: `fetch-finances` → `sync-lunch-money`. New `command: node user-data/scripts/sync-lunch-money.js`.
- Migration `0007-rename-fetch-finances.js` handles the rename and converts the old state file shape (`user-data/state/lunch-money-sync.json` → `user-data/state/sync/lunch-money.json`) idempotently.
- Legacy launchd wrapper `system/scripts/run-fetch-finances.sh` deleted (the unified job runner replaces it).
- npm script renamed: `npm run fetch-finances` → `npm run sync-lunch-money`.

#### Bug fixes

- `npm test` glob `system/tests/**/*.test.js` was only expanding one directory deep under sh, silently skipping ~85% of tests. Switched to `find -print0 | xargs -0` so all 255 tests run.
- Three stale references to the old `fetch-finances` setup updated (startup.md example, analyze-finances.js error message, runner-logic.test.js fixture).

#### Hardening (post-review)

After an independent code review of the Phase 1 work, six follow-up fixes landed:

- **LunchMoneyClient → fetchJson** — the API client used raw `fetch()` with no retry/backoff, so 429s threw immediately and 401s never produced an `AuthError`. Now routed through `fetchJson` so the lib's retry and `AuthError` semantics apply uniformly. Without this fix, `auth_status` would have stayed `'unknown'` even on real auth failures.
- **`writeMemoryIndex` is now atomic** — was a plain `writeFileSync` directly into `INDEX.md`, which could leave a truncated INDEX visible to the agent on `ENOSPC` or SIGKILL. Now mirrors the cursor/markdown atomic pattern (tmp + rename).
- **`loadCursor` robust to corrupt JSON** — a truncated state file (from a prior crash) would crash every subsequent sync. Now detected, quarantined as `<path>.corrupt-<timestamp>`, and a fresh start returned. The 7-day overlap window means we don't lose data.
- **Migration 0007 quarantines corrupt state** — was previously logging and bailing but leaving the bad file in place, causing the migration framework to retry forever. Now renames the bad file aside on parse failure.
- **Redact: tighter SIN, type check** — SIN regex was matching any 3-3-3 digit grouping (false positives on phone numbers like `416-555-9876` and Lunch Money payee IDs). Now requires Luhn validity. Also throws `TypeError` on non-string input so a `Buffer` write doesn't silently skip redaction.
- **Sync script lock** — direct invocation (`node user-data/scripts/sync-lunch-money.js`) bypassed the unified runner's lock. A manual run during a cron-fired sync would double-fetch and race on cursor writes. Now acquires the same per-job lock the runner uses; if held by another live process, exits cleanly with a "lock held" message.

#### Spec & plan

- `docs/superpowers/specs/2026-04-28-personal-data-integrations-design.md` — full design covering Calendar, Gmail, GitHub, Spotify integrations and the shared lib. Phased delivery (Phase 1 lands here; Phases 2–4 add Calendar/Gmail/GitHub/Spotify/writes).
- `docs/superpowers/plans/2026-04-28-phase-1-shared-sync-lib-and-lunch-money-migration.md` — TDD task plan for this phase.

## [3.3.0] - 2026-04-29

### Job system — unified scheduler for everything that runs

Replaces the ad-hoc mix of `system/operations/` (LLM protocols invoked at session-startup) and one-off launchd templates with a single, cross-platform job system. Jobs run on the OS scheduler, no longer dependent on the user opening a session.

### Concept unification
- `system/operations/` collapsed into `system/jobs/`. Operations become "agent-runtime jobs" that may also have schedules; a job that fits a node-runtime script just sets `runtime: node` + `command:`. Same parser, same runner, same telemetry. Eliminates the operations/jobs split.

### New CLI
- `bin/robin.js` — first-class CLI. `robin run <name>`, `robin jobs list/status/logs/upcoming/sync/enable/disable/validate`, `robin job acquire/release` (the lock wrapper used by in-session trigger-phrase invocations). Sub-100ms cold start; no chalk/cli-table deps; printf + ANSI inline.

### Cross-platform from day one
- macOS launchd, Linux cron (managed-block markers preserve user's other entries), Windows Task Scheduler (built-in WinRT toast notifications, no module dependencies).
- Cron expressions translate per-platform with cap rejection at validate time for unrepresentable patterns.

### Runner contract (single OS-scheduler entry point)
- Atomic O_EXCL lock acquisition with PID-liveness staleness detection.
- Active-window gating (recurring MM-DD or absolute YYYY-MM-DD; supports wraparound like Oct 1 → Apr 30).
- Catch-up logic for missed runs (laptop closed at scheduled time), respecting the active window.
- Subprocess hygiene: `stdin: ignore`, `shell: false`, FD-piped stdout/stderr to log files, SIGTERM at timeout + SIGKILL +30s.
- Failure categorization (auth_expired, command_not_found, timeout, runtime_error, etc.) from rolling 4 KB stderr buffer.
- Native OS notifications, debounced on (job, category) status transitions; global 6h debounce for `auth_expired` since one expired token affects every agent-runtime job.

### Telemetry (token-optimized for agent consumption)
- `user-data/state/jobs/INDEX.md` — auto-regenerated jobs dashboard, ~500 tokens.
- `user-data/state/jobs/upcoming.md` — 7-day forward calendar.
- `user-data/state/jobs/failures.md` — per-job grouped (O(jobs) not O(events)), active + resolved sections.
- `user-data/state/jobs/<name>.json` — per-job structured state.
- All writes content-addressed (skip if unchanged), atomic via tmp + rename.
- Logs split: full subprocess log, runner.log (~10 lines of decisions), summary.log (last 50 non-empty lines + exit code) — agent reads the small ones by default.

### Reconciler
- `_robin-sync` heartbeat job runs every 6h, picks up new/removed/changed job defs, re-installs scheduler entries.
- SHA-256 hash early-exit when nothing has changed (sub-10 ms in the common case).
- Workspace move detection: re-installs all entries with new path automatically.
- Orphaned state JSON cleanup when a job def is deleted.

### No user intervention after init
- Postinstall hook installs scheduler entries for all enabled jobs.
- Adding a job: drop a markdown file in `user-data/jobs/`. Live within 6h, no install command.
- Removing a job: delete the file. Entry pruned within 6h.
- Failure: native OS notification fires; agent surfaces failures.md at next session start.

### Migrations
- `0005-job-system.js` — moves `system/operations/*.md` to `system/jobs/*.md` with added frontmatter (runtime, schedule, enabled defaults), removes legacy `system/launchd/` template, updates AGENTS.md and manifest.md references.
- `0006-fetch-finances-job.js` — converts the legacy fetch-finances launchd setup into a `user-data/jobs/fetch-finances.md` job def.

### Out of scope (v2 candidates)
- Programmable `shouldRun(now)` gates per job (e.g., NHL game-day-only).
- Circuit breaker after N consecutive failures.
- Quiet hours.
- Failure runbooks.
- systemd user timers on Linux (cron only in v1).

## [3.2.0] - 2026-04-28

### Wiki evolution — operations layer + entity typing

Turns Robin's memory from a filing cabinet into a compounding wiki. Knowledge is compiled once and kept current — not re-derived each session. Inspired by Karpathy's LLM Wiki pattern and Obsidian's graph-based knowledge management.

### New operations
- **Ingest** (`system/operations/ingest.md`) — process source documents (files, URLs, inline text), create source pages under `knowledge/sources/`, ripple updates across 5-8 knowledge files, maintain cross-references, git commit for rollback.
- **Lint** (`system/operations/lint.md`) — 8-check health audit: contradictions (scoped to LINKS.md edges), dead links, stale claims, orphans, missing pages, type suggestions, frontmatter gaps, size warnings. Issue cap default 10, scoped by subdirectory.
- **Save conversation** (`system/operations/save-conversation.md`) — file conversation outcomes as lightweight summary pages to `knowledge/conversations/`. 90-day pruning by Dream for orphaned conversations.

### New infrastructure
- `memory/LINKS.md` — centralized cross-reference graph. O(1) appends during operations, full rebuild only on structural changes in Dream. Replaces in-file backlinks.
- `memory/log.md` — chronological record of wiki operations (ingests, lints, query filings).
- `memory/hot.md` — rolling window of last 3 session summaries for seamless continuation. Append-only (lockless), Dream trims.
- `user-data/sources/` — immutable source document archive (`articles/`, `documents/`, `notes/`, `media/`).
- `knowledge/sources/` and `knowledge/conversations/` directories for ingest and conversation output.

### Entity/concept typing (migration 0004)
- `type:` field added to all memory file frontmatter. Vocabulary: `topic`, `entity`, `snapshot`, `event`, `source`, `analysis`, `conversation`, `reference`.
- Types are set by migration 0004 (conservative heuristics) and refined by lint suggestions or manual updates.
- Frontmatter parser extended to handle inline arrays (`tags: [medical, labs]`).
- Type assignment guidance added to capture rules.

### New scripts
- `system/scripts/regenerate-links.js` (`npm run regenerate-links`) — walks memory files, extracts markdown links, builds edge table, respects `graph_exclude` config.
- `system/migrations/0004-add-frontmatter-types.js` — adds `type:` to all memory files via path heuristics.

### Config additions
- `memory.graph_exclude` — array of path prefixes excluded from link scanning (default: transaction files).
- `memory.startup_budget_lines` — hard cap on lines loaded at session start (default: 500).

### Dream enhancements
- Phase 1 now reads `hot.md` and `log.md`.
- Phase 4 gains 3 steps: hot cache trim (step 16), LINKS.md rebuild on structural changes (step 17), conversation pruning after 90 days (step 18).
- Dream creates new topic files with `type:` inferred from content.

### Capture rules additions
- Ingest added as direct-write exception (user-supervised, structural).
- Hot cache section added to capture sweep (step 6).
- Full frontmatter field documentation (type, tags, related, created, last_verified, ingested, origin).

### Behavior
- Startup loads `hot.md` after INDEX.md, before identity/personality. LINKS.md and log.md are on-demand only.
- Lint is interactive — surfaces issues that need user judgment, does not auto-fix.

## [3.1.0] - 2026-04-28

### Breaking changes
- `memory/index/` (sidecar `.idx.md` tree) removed. Replaced by a single generated `memory/INDEX.md` driven by per-file `description:` frontmatter.
- `user-data/trips/` consolidated into `user-data/memory/knowledge/events/`.
- Inline `<!-- id:... -->` pointer comments removed from `knowledge.md` and `profile.md` (kept in `inbox.md`).
- `indexing.status` config field removed (no longer used).

### Memory restructure (two phases)

The new architecture organizes memory into topic folders (`profile/`, `knowledge/` with `knowledge/events/` for dated entries) with a generated `INDEX.md`. Because the existing `knowledge.md` and `profile.md` use level-2 headings for both top-level domains AND sub-sections, mechanical splitting would mis-place content. The migration is therefore split into two phases:

**Phase 1 (automatic, runs at session startup via `0003-flatten-memory`):**
- Drops the sidecar index tree.
- Relocates `user-data/trips/` to `user-data/memory/knowledge/events/`.
- Adds `description:` frontmatter to flat files and to `knowledge.md` / `profile.md` (which are preserved as monoliths).
- Generates `memory/INDEX.md`.

**Phase 2 (interactive, run when you're ready):**
- Run `npm run split-monoliths` from a terminal to split `knowledge.md` and `profile.md` into topic folders.
- For each `## ` heading, the splitter prompts whether it's a domain root (becomes its own file) or a child (kept as a `## ` subsection inside the preceding root's file).
- Smart defaults: first heading defaults to root; small sections default to child.
- After confirmation, topic files are written, cross-references are repaired, and INDEX.md is regenerated.

### New
- `memory/INDEX.md` — generated directory of every memory file.
- Threshold-based topic splitting in Dream. When a topic file crosses `memory.split_threshold_lines` (default 200), Dream splits it at `## ` boundaries. Applies to topic files only — exempts `knowledge.md`, `profile.md`, `decisions.md`, `journal.md`.
- New scripts: `system/scripts/regenerate-memory-index.js` (with `--check`), `system/scripts/split-monoliths.js`, `system/scripts/lib/memory-index.js`.
- New npm scripts: `regenerate-memory-index`, `split-monoliths`.
- `memory.split_threshold_lines` config option.

### Behavior
- Dream consults `INDEX.md` to route inbox entries into topic files. New topic files for inbox-routed content are Dream-only (avoids stale-INDEX windows). User-authored documents (events, derived analyses) can still be created mid-session with frontmatter.
- Startup loads `memory/INDEX.md` plus `profile/identity.md` and `profile/personality.md`. If those topic files don't exist yet (Phase 2 not run), startup falls back to loading `profile.md` directly.

## [3.0.0] - 2026-04-27

### Breaking changes
- Distribution model changed from npm package (`npx robin-assistant init`) to git-clone. The repo IS the workspace. See README for new onboarding.
- Layout: system files now under `system/`; personal data under `user-data/` (gitignored).
- Protocols renamed to operations: `system/protocols/` → `system/operations/`.
- `AGENTS.md` moved to repo root (per the AGENTS.md community spec).
- `robin` CLI binary retired. Functionality exposed as `npm run <command>`: `backup`, `restore`, `reset`, `install-hooks`, `migrate`, `migrate-v3`.
- `export` renamed to `backup`; `rollback` renamed to `restore` (now restores user-data from a backup tar.gz, not system files from an update backup).
- `init` removed — `git clone` replaces it.
- `update` removed — `git pull` is the update verb.
- `Rule: Remote Exposure Guard` removed (remotes are now expected); replaced by gitignore + Node-based pre-commit hook.
- `commander` runtime dependency dropped — repo has zero runtime deps.

### New
- Migration framework at `system/migrations/`. Drop a versioned migration file; it auto-applies on session start with a pre-migration backup.
- Customization extension points: `user-data/custom-rules.md`, `user-data/operations/` (overlays `system/operations/`).
- `artifacts/` directory: `artifacts/input/` for user-supplied files (not auto-read), `artifacts/output/` for AI-generated artifacts.
- Auto-applied additive config schema migrations on session start (`lib/config-migrate.js`).
- Generated root pointer files (`CLAUDE.md`, `.cursorrules`, `GEMINI.md`, `.windsurfrules`) from `system/scripts/lib/platforms.js`.
- Auto-generated `system/operations/INDEX.md` from per-operation YAML frontmatter.
- CHANGELOG-aware session-start notification (`lib/changelog-notify.js`).
- Native Antigravity support (reads root `AGENTS.md`).

### Migration from v2
Run `npm run migrate-v3 -- --from <path-to-v2-workspace>` from a fresh v3 clone. Source workspace is left untouched. See `docs/superpowers/specs/2026-04-27-distribution-redesign-design.md` for full migration semantics.

---

## 2.1.0 — Memory Indexing & Metadata Layer

### Added
- Per-file sidecar indexes at `index/*.idx.md` with entry-level metadata (domains, tags, relationships, summaries)
- Root manifest at `manifest.md` providing file-level memory overview
- Timestamp-based entry IDs embedded in source files (`YYYYMMDD-HHMM-<session><seq>`)
- `robin migrate-index` command for upgrading v2.0.0 workspaces (Phase A: structural)
- Phase B semantic enrichment runs in background on first post-migration session
- Dream Phase 0 (index integrity) and Phase 4 (index maintenance)
- Index write step in capture rules — entries are indexed at capture time
- Controlled domain vocabulary: work, personal, finance, health, learning, home, shopping, travel
- Tag normalization rules (lowercase, hyphen-separated)
- Cross-reference syntax for linking entries across files
- Validation checks for index integrity on v2.1.0 workspaces

### Changed
- Config version bumped to 2.1.0 with `indexing` status field
- Startup sequence includes Phase B check and manifest reading
- Dream protocol expanded with Phase 0, Phase 4, and entry movement indexing
- Capture rules include index write step and trip indexing

## 1.0.0 (Unreleased)

Initial release.

- CLI with 9 commands: init, configure, update, check-update, rollback, validate, version, export, reset
- Core operational files: 12 protocols, coordination scripts, self-improvement framework, privacy scan
- Dream protocol for automatic memory consolidation
- Passive knowledge capture system
- Override system for user customizations
- Multi-session coordination with atomic locks
- Auto-update check with user approval
- Pre-push git hook for privacy protection
- `trips/` directory scaffolded on init with `_template.md` showing per-trip structure (was referenced in `AGENTS.md` but not created)
