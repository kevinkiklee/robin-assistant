# Changelog

## [Unreleased]

### 2026-05-01 — Autonomous memory: capture enforcement + recall (cycles 3a / 3b)

Two subsystems shipped together, both closing the same architectural gap:
*the model is supposed to capture and recall, but doesn't always.* Both
move the work from "model discipline" to "system enforces via Claude Code
lifecycle hooks." No external API key required; all retrieval is
in-process Node-native (no ripgrep dependency).

**Capture enforcement (cycle-3a).** Stop hook now hard-walls turn-end
when a substantive turn finished without writing to `user-data/memory/`.
Model must either write a tagged line to `inbox.md` (or direct-write a
file) OR emit a `<!-- no-capture-needed: <reason> -->` marker. Bounded
retry (default 1). Per-turn write-intent recorded by PreToolUse to
`user-data/state/turn-writes.log`. Tier classifier
(`lib/capture-keyword-scan.js`) decides enforcement strictness from
user-message word count, capture keywords, and entity matches. Disable via
`ROBIN_CAPTURE_ENFORCEMENT=off` or `memory.capture_enforcement.enabled =
false`. Removes the prior T1 (~20-turn) sweep instruction from
`capture-rules.md` (now redundant).

**Recall (cycle-3b).** New `UserPromptSubmit` hook auto-injects relevant
memory into the model's input as `<!-- relevant memory -->` blocks based
on entity matches in the user message AND in the previous assistant
message (so follow-ups like "schedule it" inherit the entity). Entities
sourced from `user-data/memory/ENTITIES.md`, generated from any topic
file with `aliases:` frontmatter or `type: entity`. Hot cap 150 rows;
overflow → `ENTITIES-extended.md`. New `bin/robin.js recall <term>`
subcommand for ad-hoc lookup. Incremental ENTITIES.md refresh runs
inline if any entity-bearing file is newer than the index.

**Telemetry.** Three new logs surface in Dream Phase 3.11.5:
- `user-data/state/capture-enforcement.log` — outcomes per turn
  (skipped-trivial, captured, marker-pass, retried, retried-failed)
- `user-data/state/recall.log` — entities matched, hits injected, bytes
- `user-data/state/hook-perf.log` — slow-path warnings (UserPromptSubmit
  >80ms target)

Dream Phase 4.17.6 regenerates ENTITIES.md daily; 4.17.7 caps log files.

**Rollout.** Migration `0020-capture-enforcement-config.js` adds the
config block to existing installs. Run `node system/scripts/index-entities.js
--bootstrap` after upgrade to seed `ENTITIES.md`. `.claude/settings.json`
gains a `UserPromptSubmit` hook entry — users who have customized that file
locally must merge the new entry by hand; everyone else picks it up via
`git pull`. Manifest must be re-snapshotted once via
`node system/scripts/manifest-snapshot.js --apply --confirm-trust-current-state`.

**Known gap.** Disambiguator gating for short (≤2-token) entity aliases (spec S2.2) is
declared in frontmatter (`disambiguator: [...]`) but the matcher does not yet enforce it.
Tracked for a follow-up; today's entity tree is dominated by multi-token names so the
practical impact is limited.

### Security cycles 1a / 1b / 2a / 2b / 2c — driven by 2026-04-30 audit

Five sequenced security cycles closing 28 of 42 audit gaps directly,
2 as cycle-1a side effects, 2 already hotfixed, 1 won't-fix, 9 deferred.

- **cycle-1a** (boundary defenses): `trust:untrusted` markers + inline
  UNTRUSTED-START/END wrapping for all sync writers; `sanitize-tags.js`
  neutralizes capture-tag literals and role-shift markers on the way
  in; `dream-pre-filter.js` quarantines inbox lines whose `origin=`
  isn't `user`/`user|legacy`; `ingest-guard.js` blocks ingest writes to
  tasks/decisions/self-improvement/profile-identity. Capture format
  gains `origin=` in every tag; AGENTS.md adds Hard Rules for untrusted
  ingress + origin attribution.
- **cycle-1b** (outbound write policy): `outbound-policy.js` with
  three layers — sentence-hash taint check against
  `user-data/state/untrusted-index.json` haystack, sensitive-shape
  detection (PII patterns + `process.env` value substring scan),
  credential-derived target allowlist for github/spotify/discord. Wired
  into github-write, spotify-write, discord-bot reply path.
  `policy-refusals.log` (TSV append-only, 1MB rotation) is the shared
  refusal-log substrate. New `system/security-rules.md` Tier-2 reference.
- **cycle-2a** (secrets containment + bash policy): `secrets.js`
  rewritten — `requireSecret(workspaceDir, key)` reads
  `user-data/secrets/.env` per call without polluting `process.env`;
  `loadSecrets` becomes a no-op shim. `safe-env.js:safeEnv()` builds
  explicit minimal env for spawn sites. Discord-bot deletes secret
  keys from `process.env` after `dotenv.config`. `bash-sensitive-patterns.js`
  + `claude-code-hook.js --on-pre-bash` hook the Bash tool with six
  rules (secrets-read, env-dump, destructive-rm, low-level-fs,
  git-expose-userdata, eval-injection); fail-closed on hook errors.
- **cycle-2b** (tamper detection): `user-data/security/manifest.json`
  v2 baseline; `check-manifest.js` runs on SessionStart; severe drift
  surfaces in stderr (≤5 entries; collapses beyond), all non-info
  drift logs `kind=tamper`. `manifest-snapshot.js` for first-deploy
  bootstrap (`--apply --confirm-trust-current-state`).
- **cycle-2c** (rule backstops + lifecycle): PreToolUse hook gains PII
  scan on writes to `user-data/memory/` (block-and-explain) plus
  high-stakes destination audit to `user-data/state/high-stakes-writes.log`.
  Manifest schema v2 adds `agentsmd.hardRulesHash` + `userDataJobs.knownFiles`.
  `pattern-ttl.js` runs a 180-day TTL pass in Dream's Phase X, fed by
  `pattern-firings.log` written by the model via Bash echo.

Hotfixes shipped during the audit cycle:
- **G-31**: `secrets.js:saveSecret` enforces mode 0600 via
  `chmodSync(0o600)` after rename.
- **G-39**: discord-bot launchd label verified correct in `integrations.md`.

Net code: ~8540 line additions across 7 commits. 18 new test files;
734/734 tests passing. Token-budget caps bumped: AGENTS.md 80→90,
per_protocol 3700→4200, tier1 7800→8400. Skeleton scripts mirrored
into user-data/scripts/ so the live discord-bot picks up cycle-2a's
secrets-containment defenses on next restart.

Specs at `docs/superpowers/specs/2026-04-30-cycle-{1a,1b,2a,2b,2c}-*-design.md`;
plans at `docs/superpowers/plans/2026-04-30-cycle-*.md`. Source audit at
`docs/security/audit-2026-04-30.md` (local-only, gitignored).

### Autonomy roadmap — Ship 1: P1 Independence + P4 Invisibility (2026-04-30)

Replaces the single global "Ask vs Act" rule with a three-tier action
state machine (AUTO/ASK/NEVER). New deterministic libs:
`system/scripts/lib/actions/classify.js` (tool-call → class slug),
`precheck.js` (privacy/dollar/legal/explicit-NEVER hard-rule check),
`compact-summary.js` (regenerates Tier 1 summary block in policies.md
from the user-edited body).

New user-data files (created by migration 0019 from skeletons):
`policies.md` (root) holds explicit AUTO/ASK/NEVER classes plus a
Dream-maintained compact-summary block; `memory/self-improvement/action-trust.md`
holds earned-trust calibration mirroring predictions.md shape;
`state/pending-asks.md` queues ASK-tier actions deferred from agent-runtime
jobs (consumed at next interactive session-start in a future ship).

AGENTS.md replaces the "Ask vs Act" rule with "Action states" (4-step
resolution: precheck → policies → action-trust → ASK default) and
absorbs the standalone "Sycophancy" rule into a five-named-tic
"Conversational tics" rule (P4 Invisibility). Tier 1 line cap bumped
75 → 80 in token-budget.json. Per-protocol cap bumped 3000 → 3700 to
absorb dream.md's new steps.

capture-rules.md adds the `[action]` tag with settled-class elision
(only emit for ASK / AUTO-in-probation / AUTO-with-recent-correction
classes) and a self-correction path: Robin reverses its own AUTO
action and writes the correction in the same turn, demoting AUTO →
ASK with no threshold.

dream.md gains Phase 3 step 12.5 (action-trust calibration: tally
outcomes, demote on correction, emit promotion proposals at ≥5 successes
/ 0 corrections / 30d, finalize after 24h surfaced-at, decay AUTO idle
≥ 90d) and Phase 4 step 17.5 (compact-summary regeneration).

skeleton/memory/self-improvement/communication-style.md seeds five
tic rules in the base style, mirroring the AGENTS.md tic block; existing
Dream Phase 3 step 8 (preference promotion) maintains them.

lint-memory.js gains `findTicViolations` — scans session-handoff.md
for the five tic patterns and reports as warn severity.

`host-validation` job re-enabled to catch multi-host drift introduced
by AGENTS.md / capture-rules.md / dream.md edits.

Roadmap parent: `docs/superpowers/specs/2026-04-30-autonomy-roadmap-design.md`.
Ship 2 (P2 Setup-and-go CLI) and Ship 3 (P3 Proactivity surface routing)
follow in separate cycles.

### CLI improvements roadmap — A2 / A3 / D / W / X1 (2026-04-30)

A 5-spec sweep across reliability, self-improvement, memory quality, and
proactive capability. Roadmap parent: `docs/superpowers/specs/2026-04-30-cli-improvements-roadmap.md`.

**A3 — Session-end sweep contract.** Fixes silently-empty `hot.md`,
`session-handoff.md`, and `learning-queue.md`. Three coexisting triggers:
T1 (long session ≥20 turns or compaction-imminent reminder), T2 (graceful
end on user wrap signal), T3 (Stop-hook auto-line — Claude Code only;
other hosts depend on T1/T2). New `system/scripts/lib/handoff.js`
(`writeSessionBlock` — atomic append-or-replace by session-id header
with input validation). New `system/scripts/lib/sessions.js`
(`mostRecentSessionId` — parses `state/sessions.md`, ±2h window with
clock-skew tolerance). Stop hook (`claude-code-hook.js --on-stop`)
gains `--workspace` + `--no-drain` flags and writes auto-line synchronously
before drain; drain failure-isolated and respects `--workspace` override.
Privacy filter (`applyRedaction`) applied to inbox tail before embed.
Migration 0014 idempotently seeds 7 starter questions in `learning-queue.md`.
AGENTS.md adds Session End section. capture-rules.md updates Trigger 1/2/3
semantics + multi-host coverage caveat.

**A2 — Retire `startup-check.js` (Phase 3h).** Deferred from the
2026-04-29 token-optimization PR. New `system/scripts/lib/preflight.js`
extracts the 5-step pipeline (config-migrate → pending-migrations →
validate → skeleton-sync → changelog-notify). `bin/robin.js update` uses
the lib directly. Dream Phase 0 reads `state/jobs/failures.md` instead
of running pre-flight. `startup-check.js` becomes a deprecation shim
(removed in a future minor version). Bonus: new
`system/scripts/lib/jobs/lock-cleanup.js` (`cleanupStaleLocks` — sweeps
locks older than 5 min OR with non-running PIDs); runner pre-hook +
reconciler tick both call it.

**X1 — Outcome learning loop.** Closes calibration's open loop. New
`[predict]` tag with structured fields `[predict|<check-by-date>|<confidence>]`.
New `predictions.md` (Open + Resolved sections) — source of truth;
`calibration.md` is the derived rollup. New `outcome-check.md` job
(weekly Sunday 10 AM, disabled): revisits predictions past check-by,
proposes resolved-accurate / resolved-miss / inconclusive, user
confirms in system-maintenance; auto-resolves as inconclusive after
90 days past check-by with no signal. Migration 0015 creates
`predictions.md` from skeleton.

**D1 — Memory quality heuristics.** New `system/scripts/lib/decay.js`
with per-sub-tree defaults (`profile/` slow=365d, `knowledge/` and
`self-improvement/` medium=90d, `decisions.md`/`journal.md`/`inbox.md`
immortal). Migration 0016 backfills `last_verified` frontmatter from
git history (267 files stamped). Migration 0017 adds `decay:` defaults
(267 files stamped). `lint-memory.js` extended with two warn-level
checks: staleness (`last_verified` past decay threshold) and redundancy
(exact-paragraph duplicates across files).

**D2 — Audit job (LLM-pass).** New
`system/scripts/lib/audit-pairs.js` (`generateAuditPairs` — entity-graph
pairing via `LINKS.md` + same-sub-tree, recency-prioritized, max 20
pairs/run). New `audit.md` job (weekly Sunday 11 AM, disabled): LLM-pass
surfaces contradictions and redundancies; minimal context (skip Tier 1
personalization); output to `user-data/state/audit/<YYYY-MM-DD>.md`;
never auto-edits. system-maintenance gains an audit-findings-review
step. Test corpus at `system/tests/fixtures/audit/`.

**W1 — Watch-a-topic (Phase 1).** Proactive capability — Robin follows
topics on the user's behalf. `user-data/memory/watches/<id>.md` per
watch (frontmatter-driven). Per-watch dedup state in
`user-data/state/watches/<id>.json` (last 50 fingerprints).
`system/scripts/lib/watches.js` (slugify, paths, list, state I/O).
Migration 0018 scaffolds the sub-tree. Full CLI surface:
`robin watch add/list/enable/disable/tail/run`. New `watch-topics.md`
job (hourly, disabled): iterates ≤5 active watches per tick, fetches
via WebSearch, dedupes, redacts via `applyRedaction`, writes deltas to
inbox with `[watch:<id>]` tag. 3-strike failure handling auto-disables
flapping watches. Dream Phase 2 routes `[watch:<id>]` items to
`watches/log.md` (append-only chronological feed). W2 deferred: Discord
`/watch` slash command, RSS/URL `sources` overrides, Discord DM channel,
quota-aware cadence shifting.

**Cross-cutting.** Token budget caps revisited to reflect organic
memory growth: Tier 1 raised 5,800 → 7,200 tokens / 400 → 425 lines
(cache-stable 5,600 → 6,600). Calendar events sub-index created at
`user-data/memory/knowledge/calendar/events/INDEX.md`, dropping top-level
INDEX.md from 220 → 73 lines. Three new agent-runtime jobs all default
to `enabled: false` with minimal-context profile.

**Tests:** 290 → 537 (+247). 1 pre-existing failure (`prune-execute
idempotency check`) carried over from main, unrelated.

### Token optimization & frontier-model reliability (2026-04-29)

Reorganizes the always-on instruction layer into Tier 1 (always-loaded
cache-stable prefix) / Tier 2 (on-demand) / Tier 3 (cold storage). Adds
measurement, validation, governance, and a memory-pruning lifecycle.
Frontier-only host targets (Windsurf removed; Cursor + Antigravity now
read AGENTS.md natively).

**Reduction:** Tier 1 went from 8,278 tokens / 463 lines (baseline) to
5,225 tokens / 343 lines (-37% / -26%). Framework files (AGENTS.md,
manifest, capture-rules, startup) reduced 45% in tokens. User content
(personality, INDEX descriptions, integrations) unchanged. Cache-stable
prefix at 5,072 tokens (vs 5,300 cap).

**Phase 0 — Harness.** `system/scripts/measure-tokens.js`,
`token-budget.json` (single source of truth for tier classification +
caps), deterministic tokenizer (bytes/3.7), committed baseline. `--diff`
/ `--diff-against=<ref>` / `--check` / `--update-baseline` /
`--host=<name>` modes. CI step.

**Phase 1 — Validation.** `system/scripts/validate-host.js` + per-host
parsers (claude-code/codex/gemini-cli; manual JSON for cursor/antigravity).
Six scenarios: cold session, routine capture, triggered protocol,
reference fetch, multi-session detection, direct-write correction.
Headless runners for the three CLI hosts; manual checklists for the two
IDEs. `system/jobs/host-validation.md` quarterly drift-detection job
(default disabled).

**Phase 2 — Tier reorganization.** Migrations 0008 (split
self-improvement.md), 0009 (build sub-indexes for lunch-money,
photography-collection, events), 0010 (archive scaffolding), 0011
(year-split marker), 0012 (drop Windsurf). AGENTS.md slimmed 120 → 68
lines. manifest.md 117 → 78 lines. capture-rules.md 279 → 193 lines
(4,556 → 1,894 tokens). startup.md 40 → 22 lines (sequence inlined in
AGENTS.md). regenerate-memory-index.js stops at sub-indexes.
platforms.js drops Windsurf; Cursor/Codex/Antigravity use AGENTS.md
natively.

**Phase 3 — Performance + reliability.** `lint-memory.js` checks
orphans, sub-tree size, stale INDEX entries, orphan .tmp files.
`golden-session.js` snapshot of host-agnostic Tier 1 expected loads.
`migrate.js` fast-path (~50ms cold start when no migrations pending).
`system/migrations/CONTRIBUTING.md` codifies the migration safety
contract. Read-before-write conditional inlined in AGENTS.md.

**Phase 4 — Memory pruning.** `system/jobs/prune.md` (default disabled).
12-month cutoff archives transactions, conversations, calibration
entries to `user-data/memory/archive/<year>/`. Year-end splits
decisions.md and journal.md. Skips run when sibling sessions active.
Pre-prune backup. Atomic moves. Migration 0013 reserves the slot for
backfill prune.

**Phase 5 — Governance.** `docs/governance/token-budget.md`,
`CODEOWNERS`, `.github/workflows/token-budget.yml` (runs measure-tokens
--check, lint-memory, golden-session --check, npm test on every PR),
`.github/labeler.yml` auto-applies tier1-changes / migrations /
protocols labels.

**Deferred:** Phase 3h (`startup-check.js` retirement) ships separately
— biggest blast radius of the design; needs its own PR.

Tests: 279 → 293.

### Personal-data integrations — Phases 2–4 (Calendar, Gmail, GitHub, Spotify)

Adds the four read+write integrations the Phase 1 lib was built to support. All four ship as user-data templates (auto-scaffolded from `system/skeleton/scripts/` on first run); job markdowns ship at `enabled: false` so they don't fire until the user has completed per-provider auth setup.

#### New shared lib module: oauth.js

`system/scripts/lib/sync/oauth.js` adds the OAuth2 flow that all OAuth-based integrations share:
- **`getAccessToken(workspaceDir, provider)`** — runtime helper. Reads the long-lived refresh token from `.env`, returns a cached access token from state if still valid (60s clock skew), or calls the provider's token endpoint to refresh and caches the new access token. Writes back rotated refresh tokens (Spotify rotates them; Google does not).
- **`runAuthCodeFlow(opts)`** — one-shot setup helper. Spins up a localhost callback server on a random (or fixed) port, opens the user's browser to the consent URL, captures the auth code, exchanges it for tokens. CSRF-safe via random `state`. Cross-platform browser opener.
- Provider registry currently has Google and Spotify wired up.

#### Phase 2 — Calendar + Gmail (read-only sync)

- **`auth-google.js`** — one-shot OAuth setup. Uses read-only scopes (`calendar.readonly`, `gmail.readonly`); writes are still routed through the native MCPs in-session. Sets `access_type=offline` + `prompt=consent` to guarantee a refresh token.
- **`sync-calendar.js`** — pulls events from all subscribed calendars in a ±90-day window every 30 min. Writes scannable `upcoming.md` / `recent.md` tables and lazy per-event detail files for events with attendees, descriptions, or meeting URLs.
- **`sync-gmail.js`** — pulls last-30-days inbox metadata every 15 min (sender, subject, snippet, labels — no bodies). Writes `inbox-snapshot.md` and a derived `senders.md` (top 50 senders by frequency with last-seen + unread counts).

#### Phase 3 — GitHub + Spotify (read-only sync)

- **`auth-github.js`** — PAT validator (no OAuth flow needed for GitHub). Confirms the token authenticates, reports the user, scopes, and rate-limit status.
- **`sync-github.js`** — pulls last-30-days authored events, current notifications, and recent releases from up to 50 starred repos every hour. Writes `activity.md` / `notifications.md` / `releases.md`.
- **`auth-spotify.js`** — OAuth setup. Uses fixed port 8765 (configurable via `SPOTIFY_AUTH_PORT`) so users can pre-register the redirect URI in the Spotify developer dashboard.
- **`sync-spotify.js`** — pulls last-50 recently-played (append-only ledger; dedup by `played_at`), top tracks/artists for 4w / 6m / all-time windows, and on `--bootstrap` also dumps owned playlists with track lists. Lazy-caches Spotify audio-features per track. Detects gaps when more than 50 plays happened since the last cursor.

#### Phase 4 — Write CLIs

Single-entry-point scripts dispatched on `--action`:

- **`github-write.js`** — `create-issue`, `comment`, `label`, `mark-read`.
- **`spotify-write.js`** — `queue`, `skip`, `playlist-add`.

Both support `--dry-run` that prints the intended call without invoking the API or even loading credentials. Per AGENTS.md `Rule: Ask vs Act`, the agent must confirm with the user before invoking these.

Calendar and Gmail writes use Claude Code's native MCPs in-session per the spec — no parallel write CLI is built for those.

#### Setup flow per integration

```sh
# Calendar + Gmail (one auth covers both)
node user-data/scripts/auth-google.js
node user-data/scripts/sync-calendar.js --bootstrap
node bin/robin.js jobs enable sync-calendar
node user-data/scripts/sync-gmail.js --bootstrap
node bin/robin.js jobs enable sync-gmail

# GitHub
# (paste GITHUB_PAT into user-data/secrets/.env)
node user-data/scripts/auth-github.js
node user-data/scripts/sync-github.js --bootstrap
node bin/robin.js jobs enable sync-github

# Spotify
node user-data/scripts/auth-spotify.js
node user-data/scripts/sync-spotify.js --bootstrap
node bin/robin.js jobs enable sync-spotify
```

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
