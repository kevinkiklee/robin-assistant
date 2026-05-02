# Robin Assistant

A personal AI assistant that builds a persistent wiki about your life, learns from its mistakes, and works across multiple AI tools at the same time.

Most AI assistants forget you when the session ends. Robin doesn't. It silently captures facts, preferences, and decisions as you talk, organizes them into a structured wiki, cross-links every entity automatically, and pulls the relevant pages back in on the next turn — before you finish your sentence. Correct it twice and it writes a permanent rule so the mistake stops happening. Open it in Claude Code and Cursor at the same time — same memory, coordinated writes, no conflicts.

The repo *is* the workspace. You clone it, open it in your AI tool, and Robin is alive.

---

## Why Robin

### Wiki memory

Robin's memory isn't a chat log. It's a structured wiki — topic files organized into directories, cross-referenced with a link graph, and indexed so Robin loads only what it needs. You don't tell it to remember things. You just talk. Robin watches for capturable signals — facts, preferences, decisions, corrections, dated reflections — and writes them to the right file in the same turn it answers you.

Every entity (person, place, project, service) gets a page with `aliases:` in its frontmatter. After any write, Robin runs `robin link` to convert the *first mention* of every known entity into a wiki-link automatically — no manual `[[…]]` typing. The result is a self-maintaining knowledge graph: the more Robin learns, the more densely connected the wiki becomes.

Feed it a document with the **Ingest** command and it extracts facts, creates source pages, ripples updates across related files, and maintains cross-references automatically. Run **Lint** to audit the knowledge base for contradictions, dead links, stale claims, orphans, conversational tics, ambiguous aliases, and concepts mentioned three times without a dedicated page. Over time, the wiki compounds — each session leaves Robin knowing more than the last.

### Auto-recall

The model is supposed to look things up but doesn't always remember to. Robin closes the gap with a UserPromptSubmit hook: when you submit a prompt, the hook scans your message *and* the previous assistant message for known entities, then injects relevant memory directly into the model's input as `<!-- relevant memory -->` blocks. Follow-ups like "schedule it" inherit the entity from the prior turn.

All retrieval is in-process Node-native — no ripgrep, no API key, no external service. Telemetry lives in `user-data/ops/state/{recall,hook-perf}.log`.

### Self-improvement

Robin tracks what it gets wrong and what it gets right. When you correct it, it logs the mistake and the right answer. Three similar corrections automatically promote to a named *pattern* with recognition signals and counter-actions, so the failure mode stops recurring. Patterns that stop firing get retired after 180 days.

It also builds a model of how to communicate with you. Positive feedback accumulates into a communication style profile with domain-specific overrides. It tracks its own confidence calibration — when it makes a high-stakes recommendation, it tags it with `[predict|<check-by-date>|<confidence>]`, and the weekly outcome-check job revisits each prediction past its check-by date so calibration is fed by *actual outcomes*, not just self-reports. Every quarter it runs a self-assessment: grading its own responses, checking for the five named conversational tics, and asking you to rate it directly.

### Action states (AUTO / ASK / NEVER)

Instead of a single global "ask before acting" rule, Robin classifies every tool call into one of three classes — AUTO (just do it), ASK (confirm first), NEVER (refuse). Classes live in `policies.md` (you edit them); a deterministic precheck enforces hard rules (privacy, dollar amounts, legal, explicit NEVERs). A separate **action-trust** ledger tracks earned trust per class: 5+ successes with no corrections over 30 days proposes promotion ASK → AUTO; a single user reversal demotes back to ASK. Self-correction is a first-class path — Robin can reverse its own AUTO action and write the correction in the same turn.

### Multi-agent coordination

Robin works across AI coding tools — Claude Code, Cursor, Gemini CLI, Antigravity, Codex. Same workspace, same memory, same rules. Switch tools mid-week and Robin picks up where it left off.

Open two tools at the same time and Robin coordinates. A session registry tracks which tools are active. File-based locks prevent conflicting writes to shared files. Append-only files like the journal and decision log are safe to write concurrently. When you start a session, Robin tells you if another session is already running.

### Security boundaries

Personal data has explicit defenses against prompt injection from sync sources and against the model exfiltrating data through outbound writes:

- **Boundary defenses** — every sync writer wraps untrusted content in `UNTRUSTED-START`/`UNTRUSTED-END` sentinels and stamps `trust:untrusted` frontmatter. Capture tags carry an `origin=` attribution. A pre-filter quarantines inbox lines that don't claim `origin=user`.
- **Outbound write policy** — outbound write paths (github-write, spotify-write, discord reply) run through a three-layer policy: sentence-hash taint check against the untrusted index, sensitive-shape detection (PII patterns + `process.env` value substring scan), and a credential-derived target allowlist.
- **Secrets containment** — secrets are read on demand from `user-data/ops/secrets/.env` per call without polluting `process.env`. Spawn sites build explicit minimal envs.
- **Bash policy** — six rules (secrets-read, env-dump, destructive-rm, low-level-fs, git-expose-userdata, eval-injection) hook the Bash tool and fail closed.
- **Tamper detection** — a manifest baseline + `check-manifest.js` runs on SessionStart; severe drift surfaces in stderr and logs `kind=tamper`.
- **PII scan on memory writes** — PreToolUse hook scans writes to `user-data/memory/` for credentials and high-stakes shapes; blocks and explains.

---

## Features

### Passive capture

Robin silently captures information from your conversations without you saying "remember this." It recognizes names and relationships, dates and deadlines, preferences, decisions with reasoning, corrections, commitments, predictions worth grading, and facts mentioned in passing. Each capture is tagged (`[fact]`, `[preference]`, `[decision]`, `[correction]`, `[task]`, `[journal]`, `[predict]`, `[action]`, `[watch:<id>]`) with an `origin=` attribution and written to an inbox. The nightly Dream cycle routes inbox entries to the right file. High-stakes captures (medical, financial, legal) are confirmed before storing.

### Structured memory

Memory is organized into topic directories with per-file frontmatter (description, type, tags, aliases, cross-references, `last_verified`, `decay`). The layout:

| Path | Holds |
|------|-------|
| `INDEX.md` | Generated directory of every memory file — read at session start |
| `ENTITIES.md` | Auto-generated entity index (name, aliases, path) for recall + linker. Hot cap 150 rows; overflow → `ENTITIES-extended.md` |
| `hot.md` | Rolling window of last 3 session summaries for seamless continuation |
| `LINKS.md` | Cross-reference graph between memory files |
| `profile/` | Identity, personality, interests, goals, routines, people in your life (one page per person, `type: entity`) |
| `knowledge/` | Reference facts — locations, medical, projects, restaurants, recipes, service providers |
| `knowledge/sources/` | Source pages created by the Ingest command |
| `knowledge/conversations/` | Summaries of substantive conversations |
| `self-improvement/` | Corrections, patterns, preferences, calibration, predictions, communication style, domain confidence, action-trust, learning queue |
| `watches/` | Per-watch pages and `log.md` for proactive topic following |
| `tasks.md` | Active tasks grouped by category |
| `decisions.md` | Append-only log of decisions and their reasoning |
| `journal.md` | Dated reflections and daily notes |
| `inbox.md` | Quick-capture items waiting to be routed by Dream |
| `archive/` | Content older than 12 months, pruned automatically |

Topic files split automatically when they exceed 200 lines. Per-sub-tree decay defaults (`profile/` slow=365d, `knowledge/` and `self-improvement/` medium=90d, `decisions.md`/`journal.md`/`inbox.md` immortal) drive staleness alerts.

### Wiki-graph (entity linking)

Every page that defines an entity declares `aliases: [...]` in its frontmatter. The linker (`robin link <path>`) builds a registry from those declarations and converts the first occurrence of every alias in a target file into a wiki-link in a single pass — preserving original case, skipping frontmatter / fenced code / existing links / URLs, fail-soft on errors. It's wired into:

- All sync writers (Calendar, Gmail, GitHub, Spotify, Lunch Money) — every newly written page gets linked before the runner exits.
- Dream Phase 2 — runs `robin link` on every file the inbox router touched.
- Ingest Step 5 — runs `robin link` on every rippled file.
- A capture rule in AGENTS.md — model must invoke the linker after any direct write to memory.
- A backfill orchestrator (`backfill-entity-links.js`) for one-shot linking of the entire wiki, dry-run by default, `--apply` mode acquires a `wiki-backfill` lock and regenerates `LINKS.md` after.

Lint catches structural issues: ambiguous aliases (same alias claimed by two entities), candidate entities (terms mentioned 3+ times without a page), trust:untrusted skip, alias-collision rejection.

### Wiki operations

**Ingest** processes source documents (files, URLs, inline text) into the knowledge base — extracts entities and facts, creates source pages, ripples updates across related files, runs the entity linker on every touched file, adds cross-references to the link graph, and commits the result for rollback.

**Lint** audits memory health: contradictions across linked files, dead links, stale claims (per-sub-tree decay thresholds), orphan pages, missing pages (concepts mentioned 3+ times without a dedicated file), redundancy (exact-paragraph duplicates across files), ambiguous aliases, candidate entities, conversational-tic patterns in `session-handoff.md`, frontmatter gaps, size warnings, orphan `.tmp` files.

**Audit** (weekly LLM-pass, disabled by default) generates entity-graph candidate pairs via `LINKS.md`, runs an LLM pass with minimal context to surface contradictions and redundancies, and writes findings to `user-data/ops/state/audit/<YYYY-MM-DD>.md` for review in system-maintenance. Never auto-edits.

**Save conversation** files the key outcomes of the current conversation as a lightweight summary page. Conversations older than 90 days with no inbound links are flagged for archival.

**Deep-ripple** is an agent protocol for high-impact ingestions — when a single source touches many areas of the wiki and a mechanical ripple isn't enough.

### Self-improvement framework

Nine dimensions of self-improvement, each stored in its own file:

- **Corrections** — what Robin got wrong and what to do instead. Append-only log.
- **Patterns** — recurring mistakes promoted automatically from 3+ similar corrections. Each has recognition signals and counter-actions. 180-day TTL — retired when they stop firing.
- **Preferences** — positive signals and explicit style feedback. 3+ similar signals promote to communication style rules.
- **Communication style** — Robin's learned interaction model. Base style plus domain-specific overrides, built from preferences over time. Seeds with five named conversational tics on install.
- **Domain confidence** — self-assessed competence per area of your life. New domains start at medium. Decays after 90 days of inactivity.
- **Calibration** — prediction accuracy by confidence band, effectiveness scores for high-stakes recommendations, sycophancy tracking. *Derived rollup* — fed by `predictions.md`.
- **Predictions** — open and resolved high-stakes claims tagged `[predict|<check-by>|<confidence>]`. Source of truth for calibration; revisited weekly by the outcome-check job.
- **Action-trust** — earned-trust calibration per action class (mirrors predictions shape). 5+ successes / 0 corrections / 30 days proposes ASK → AUTO promotion; finalized after 24h surfaced-at; demotes on a single user reversal; AUTO decays after 90d idle.
- **Learning queue** — questions Robin wants to ask you when a natural moment arises. One question max per session. Migration 0014 seeds 7 starter questions.

### Dream cycle

Runs every night at 4 AM via the OS scheduler — no session needed. Phases:

1. **Phase 0 — Auto-memory migration** — drains host-managed memory (e.g., Claude Code's auto-memory) into Robin's inbox.
2. **Phase 1 — Scan** — reads inbox, tasks, journal, self-improvement files, hot cache, operation log.
3. **Phase 2 — Memory management** — routes inbox entries to topic files, runs `robin link` on every routed file, routes `[watch:<id>]` items to `watches/log.md`, promotes durable facts from journal, prunes finished tasks, checks freshness of profile and knowledge files.
4. **Phase 3 — Self-improvement processing** — promotes corrections to patterns, reviews pattern effectiveness (180-day TTL), processes session reflections, promotes preferences to communication style, updates domain confidence, maintains learning queue, runs action-trust calibration (step 12.5), surfaces telemetry from recall / hook-perf logs (step 11.5), updates calibration.
5. **Phase 4 — Memory tree maintenance** — splits oversized files, cleans empty files, regenerates `INDEX.md`, regenerates `ENTITIES.md` (step 17.6), regenerates compact-summary in `policies.md` (step 17.5), caps log files (step 17.7), trims hot cache, rebuilds link graph, flags old conversations for archival.
6. **Phase X — Pattern TTL** — 180-day pass over `pattern-firings.log` retires patterns that stopped firing.

Unresolvable issues are escalated in a report: contradictions, ambiguous inbox items, time-sensitive items, ineffective patterns, calibration drift, tamper-detection findings.

### Job system

A cross-platform scheduler that runs jobs on your OS (launchd on macOS, cron on Linux, Task Scheduler on Windows), independent of AI sessions. Jobs are defined as markdown files with YAML frontmatter specifying runtime (agent or node), schedule, triggers, and timeout.

Shipped jobs span daily maintenance, financial review, productivity, and system health:

| Job | Schedule | What it does |
|-----|----------|--------------|
| Dream | Daily 4 AM | Memory maintenance, self-improvement, telemetry surfacing, ENTITIES.md regen |
| Morning briefing | Daily 7 AM (disabled) | Calendar, priorities, flagged items, suggested focus |
| Weekly review | Sunday 10 AM (disabled) | Accomplishments, backlog health, goal check-ins, look-ahead |
| Monthly financial | 1st of month (disabled) | Income, recurring outflows, budget variance, anomalies |
| Quarterly self-assessment | Quarterly (disabled) | Effectiveness audit, calibration check, conversational-tic detection, user grading |
| Subscription audit | 15th of month (disabled) | Recurring charges review, cancel/renegotiate candidates |
| System maintenance | On demand (disabled) | Interactive review of stale tasks, pending decisions, pattern effectiveness, prediction resolution, audit findings |
| Backup | Daily 3 AM | Snapshot of user-data to timestamped backup |
| Prune | Monthly (disabled) | Archive content older than 12 months |
| Auto-memory migration | Hourly | Drain host auto-memory into Robin's inbox |
| Email triage | On demand (disabled) | Classify unread email, surface action items, route receipts |
| Meeting prep | On demand (disabled) | Gather context, attendees, prior history, talking points |
| Todo extraction | On demand (disabled) | Extract action items from forwarded email/documents |
| Receipt tracking | On demand (disabled) | Find and summarize receipts by vendor, time range, or category |
| Ingest | On demand (disabled) | Process source documents into the knowledge base; runs entity linker on every rippled file |
| Lint | On demand (disabled) | Audit memory health |
| Save conversation | On demand (disabled) | File conversation outcomes as summary pages |
| Deep-ripple | On demand (disabled) | Agent protocol for high-impact ingestions whose ripple exceeds the mechanical pass |
| Host validation | Quarterly | Verify all supported AI tools still honor loading rules |
| Multi-session coordination | On demand (disabled) | In-session protocol that registers active sessions and acquires file locks |
| Outcome check | Sunday 10 AM (disabled) | Revisit open `[predict]` claims past their check-by date; propose resolution; user confirms in system-maintenance |
| Audit | Sunday 11 AM (disabled) | LLM-pass over candidate file pairs (via LINKS.md cross-references) to surface contradictions and redundancies for user review |
| Watch topics | Hourly (disabled) | Iterate active watches, fetch via WebSearch, dedupe vs per-watch fingerprints, redact, write deltas to inbox with `[watch:<id>]` tag |
| Reconciler heartbeat | Every 6 hours | Pick up new/changed job definitions, update scheduler entries, sweep stale locks |

Add a job by dropping a markdown file in `user-data/ops/jobs/` — the reconciler picks it up within 6 hours.

The runner handles atomic locks, active-window gating, catch-up for missed runs (laptop was closed), failure categorization, and native OS notifications on status transitions.

### Service integrations

Robin can pull data from external services on a schedule so it has context about your life without you pasting things in:

- **Google Calendar** — upcoming and recent events (every 30 min)
- **Gmail** — inbox metadata: senders, subjects, labels (every 15 min, no message bodies)
- **GitHub** — authored events, notifications, releases from starred repos (hourly)
- **Spotify** — recently played, top tracks/artists, playlists (every 4 hours)
- **Lunch Money** — financial transactions and category breakdowns (daily 1 AM)

Each integration is a standalone script with OAuth setup, bootstrap sync, and a job definition. All ship disabled — they only run after you complete auth setup. Per-provider walkthroughs (creating OAuth clients, choosing scopes, known gotchas like Spotify's `127.0.0.1` redirect requirement and GitHub fine-grained PAT limits on `/notifications`) live in [`system/integrations/`](system/integrations/README.md). Write CLIs are available for GitHub (`create-issue`, `comment`, `label`, `mark-read`) and Spotify (`queue`, `skip`, `playlist-add`) with `--dry-run` support. Calendar and Gmail writes use your AI tool's native capabilities.

The integration system is built on a shared library (`system/scripts/sync/lib/`) providing OAuth2 token refresh, secrets management, sync cursors, HTTP retry with exponential backoff, privacy redaction, and atomic markdown writes.

### Chat front-ends

Talk to Robin from outside your terminal. The first front-end is a personal **Discord bot** (macOS, launchd-supervised) — `@`-mention or DM the bot in your private server and it spawns a Claude Code subprocess against your Robin workspace, replying inline with full session continuity per Discord thread / DM channel. Allowlisted to a single user + a single guild; the events log records metadata only (no prompt or reply text).

A launchd watchdog monitors the bot (and vice-versa) for mutual self-heal recovery — if either process disappears unexpectedly, the other restarts it. The reply path runs through the outbound write policy (taint check, sensitive-shape scan, target allowlist) so messages can't exfiltrate secrets or echo untrusted content back to Discord.

Setup walkthrough: [`system/integrations/discord-setup.md`](system/integrations/discord-setup.md).

### Privacy

Personal data never leaves your machine unless you explicitly push it to a remote you control. Four layers enforce this:

1. **`.gitignore`** excludes `user-data/`, `artifacts/`, `backup/`, `docs/`
2. **Pre-commit hook** refuses any commit that stages files in those directories or removes `user-data/` from `.gitignore`
3. **Capture rules** block writes containing full government IDs, payment card numbers, passwords, API keys, or credentials. Cannot be overridden, even by your own custom rules.
4. **Redaction module** automatically strips sensitive patterns (SSNs, SINs with Luhn validation, credit card numbers, API keys, URL credentials) from sync data before storage

### Token optimization

Robin's instruction layer is organized into tiers to minimize token usage at session start:

- **Tier 1** (always loaded) — core rules, identity, INDEX, ENTITIES, hot cache, communication style, learning queue. Capped at 10,200 tokens / 510 lines (9,300 for the cache-stable prefix).
- **Tier 2** (on demand) — job protocols, capture rules, manifest, security rules, self-improvement rules. Loaded only when triggered.
- **Tier 3** (cold storage) — archived memory, historical data, full per-event detail pages.

CI enforces token budgets on every PR. A measurement harness tracks per-file token counts, a golden-session snapshot detects load-order drift, and a memory linter catches structural issues. Caps live in `system/scripts/diagnostics/lib/token-budget.json` — a single source of truth read by the harness and host validators.

### Customization

Four extension points, all in `user-data/` (gitignored, survives `git pull`):

- **`custom-rules.md`** — your own rules, appended to the rule list. Override operational rules but not immutable rules (privacy, verification). Examples: language preference, persona overrides, custom capture rules.
- **`jobs/`** — overlays `system/jobs/`. **The default convention is a shallow override** (`override: <name>` frontmatter): you change only what you need, the rest inherits from the system definition and keeps tracking upstream upgrades. Use a full override (no `override:` key) only when you intend to fully replace a system job. Drop a brand-new file to extend the catalog.
- **`ops/scripts/`** — per-user integration scripts. Templates scaffolded from `system/scaffold/ops/scripts/` on install. Add a new integration by dropping a job def + script and importing from `system/scripts/sync/lib/`.
- **`integrations.md`** — declare which platform integrations are configured. Jobs check this before assuming a capability is available.

#### Customizing a job (the default pattern)

Tweak any shipped job — schedule, body, prompt, enabled flag — without forking the package:

```markdown
<!-- user-data/ops/jobs/morning-briefing.md -->
---
override: morning-briefing
schedule: "0 6 * * *"   # only the fields you want to change
---
# Protocol: Morning Briefing (user override)

…your custom protocol body, or omit the body to keep the system default…
```

The merge rules (system def + user override → effective def):

- Frontmatter: user override wins on field collisions, system fields are preserved otherwise.
- Body: replaced wholesale if the override has a non-empty body; system body is used if the override body is empty.
- To revert: delete the override file. To fully replace: omit the `override:` key (the file then stands alone).

`robin jobs enable <name>` and `robin jobs disable <name>` write a shallow override automatically — that's how the CLI itself flips state. Authoring your own override is the same pattern, just by hand.

### Memory lifecycle

Content older than 12 months is automatically archived by the prune job. Transactions, conversations, calibration entries move to `archive/<year>/`. Year-end splits break decisions and journal files by calendar year. A dry-run preview shows what would move before anything happens. Pre-prune backups are automatic.

### Session handoff

Robin maintains a rolling handoff note for the next session. At session end (or when context compaction is imminent), it runs a capture sweep — scanning for uncaptured signals, deduplicating against the inbox, and writing a session summary to the hot cache. The next session reads the hot cache immediately after the index, picking up where you left off.

---

## Installation

### Prerequisites

- **Node.js 18 or later** — check with `node --version`
- **git**
- An AI coding tool: Claude Code, Cursor, Antigravity, Codex, or Gemini CLI

### Steps

```bash
# 1. Fork or clone. Forking gives you a private remote for system-side
#    customizations. Personal data stays local regardless (it's gitignored).
git clone git@github.com:kevinkiklee/robin-assistant.git robin
cd robin

# 2. Install. The postinstall step:
#      - copies system/scaffold/* into user-data/
#      - creates artifacts/input, artifacts/output, backup/
#      - prompts for your name, timezone, email, platform, assistant name
#      - installs the pre-commit privacy hook
#      - applies migrations and installs scheduler entries
npm install

# 3. Open the repo in your AI tool. It reads AGENTS.md directly (Cursor,
#    Antigravity, Codex) or via a pointer file (CLAUDE.md, GEMINI.md).
#    Robin will introduce itself.
```

That's it. No global CLI. The repo is self-contained.

If you ran `npm install` in a non-interactive shell (CI, no TTY), the prompts are skipped and `user-data/ops/config/robin.config.json` ships with placeholder values — fill them in before your first session.

---

## Updating

```bash
git pull                    # if you cloned upstream
git pull upstream main      # if you forked
npm install                 # runs migrations, config upgrade, scaffold sync, scheduler reinstall
```

This only touches files in `system/` and root pointer files. **`user-data/`, `artifacts/`, `backup/`, and `docs/` are gitignored — your personal data is never touched by an update.**

Migrations, config upgrades, and scaffold sync run during `npm install` (via the postinstall hook), not at session start. This keeps the AI session's cold start fast.

After upgrading across the autonomous-memory cycle (≥ 2026-05-01), run once:

```bash
node system/scripts/memory/index-entities.js --bootstrap          # seed ENTITIES.md
node system/scripts/diagnostics/manifest-snapshot.js --apply --confirm-trust-current-state   # re-baseline tamper detection
```

Users who customized `.claude/settings.json` locally must merge the new `UserPromptSubmit` hook entry by hand; everyone else picks it up via `git pull`.

If `git pull` reports a conflict, run `git checkout -- <conflicting-path>` — tracked files are upstream-owned. Move customizations into the extension points above.

---

## Commands

| Command | Purpose |
|---------|---------|
| `npm run backup` | Snapshot `user-data/` to `backup/user-data-<timestamp>.tar.gz` |
| `npm run restore` | Restore `user-data/` from a backup archive (interactive) |
| `npm run reset` | Wipe `user-data/`, recopy scaffold, re-prompt config (auto-backups first) |
| `npm test` | Run the test suite (~734 tests) |
| `npm run lint-memory` | Check orphans, stale INDEX entries, oversized sub-trees, staleness, redundancy, ambiguous aliases, candidate entities, conversational tics |
| `npm run measure-tokens` | Measure tier token counts. `--check` enforces caps, `--diff` shows delta |
| `npm run prune-preview` | Preview what the 12-month archive prune would move |
| `npm run prune-execute` | Run the archive prune (auto-backups first) |
| `robin run <name>` | Manually invoke a job. `--force` skips gating, `--dry-run` prints the plan |
| `robin jobs list` | Show all jobs with enabled state, schedule, last run, status |
| `robin jobs status <name>` | Detail on one job — last run, log location, next run |
| `robin jobs logs <name>` | Tail the most recent run's summary (`--full` for complete log) |
| `robin jobs upcoming` | 7-day forward calendar of scheduled runs |
| `robin jobs enable <name>` | Turn on a disabled job |
| `robin jobs disable <name>` | Turn off an enabled job |
| `robin jobs sync` | Force-reconcile OS scheduler with job definitions |
| `robin jobs validate` | Parse and validate every job definition |
| `robin update` | Post-`git pull` check: config migrate, pending migrations, scaffold sync, validate |
| `robin link <path> [--dry-run]` | Apply first-mention entity links to a file. Idempotent, fail-soft, NFC-normalized |
| `robin recall <term> [--json]` | In-process node-native lookup over `ENTITIES.md` and memory files |
| `robin watch add "<topic>"` | Add a topic to follow; runs first fetch immediately to seed fingerprints |
| `robin watch list` | List active and disabled watches |
| `robin watch enable <id>` / `disable <id>` | Toggle a watch on/off |
| `robin watch tail [<id>]` | Show recent `[watch]` items from inbox (filtered by id if given) |
| `robin watch run <id> [--dry-run \| --bootstrap]` | Manually trigger a watch (real fetch requires the watch-topics agent-runtime job) |
| `node system/scripts/memory/index-entities.js --bootstrap` | Seed `ENTITIES.md` from frontmatter (run once after upgrade) |
| `node system/scripts/memory/backfill-entity-links.js [--apply]` | One-shot link the entire wiki. `--apply` acquires `wiki-backfill` lock and regenerates `LINKS.md` |
| `node system/scripts/diagnostics/manifest-snapshot.js --apply --confirm-trust-current-state` | Re-snapshot the security manifest (after major upgrades) |
| `npm run discord:auth` | Walk through Discord bot OAuth + token storage |
| `npm run discord:install` | Install the Discord bot launchd agent (macOS) |
| `npm run discord:status` / `discord:health` | Inspect bot daemon status / liveness |

---

## Workspace structure

```
robin/
├── AGENTS.md                <- Canonical instructions (read natively by Cursor, Antigravity, Codex)
├── CLAUDE.md                <- Pointer -> AGENTS.md (Claude Code)
├── GEMINI.md                <- Pointer -> AGENTS.md (Gemini CLI)
├── bin/
│   └── robin.js             <- CLI entry point (run, jobs, link, recall, watch, update)
├── system/                  <- upstream-owned, tracked, never user-edited
│   ├── rules/               <- agent-readable rules (capture, security, self-improvement, startup)
│   ├── jobs/                <- shipped jobs (agent protocols + node scripts)
│   ├── migrations/          <- versioned schema migrations
│   ├── scripts/
│   │   ├── cli/             <- user-facing CLI entry points (invoked by bin/robin.js)
│   │   ├── hooks/           <- claude-code.js (UserPromptSubmit / PreToolUse / Stop / on-pre-bash) + pre-commit.js
│   │   ├── jobs/            <- runner, reconciler, OS-scheduler installer adapters
│   │   ├── memory/          <- index-entities, backfill-entity-links, lint, prune, regenerate-{index,links,pointers}
│   │   ├── capture/         <- ingest guard, dream pre-filter, auto-memory, action classification
│   │   ├── sync/            <- oauth, secrets, http, redact, markdown, cursor, untrusted-index
│   │   ├── wiki-graph/      <- entity registry, link application, exclusions
│   │   ├── watches/         <- slugify, frontmatter parse, list/state I/O
│   │   ├── migrate/         <- migration apply harness + helpers
│   │   ├── diagnostics/     <- check-manifest, manifest-snapshot, measure-tokens, validate-host, check-doc-paths
│   │   └── lib/             <- cross-cutting utilities (outbound-policy, bash-sensitive-patterns, manifest, platforms…)
│   ├── scaffold/            <- first-run templates for user-data/
│   ├── integrations/        <- per-provider setup playbooks
│   └── tests/               <- mirrors system/scripts/ layout
├── user-data/               <- your data, gitignored
│   ├── memory/              <- structured memory tree (incl. ENTITIES.md, watches/, predictions.md)
│   ├── jobs/                <- your custom jobs + shallow overrides
│   ├── scripts/             <- per-user integration scripts (sync-*, auth-*, *-write, discord-bot)
│   ├── secrets/             <- credentials (.env, mode 0600 enforced)
│   ├── security/            <- manifest.json baseline, refusal logs
│   ├── sources/             <- immutable source document archive
│   ├── state/               <- sessions, locks, sync cursors, job logs, capture/recall/hook-perf logs
│   ├── policies.md          <- AUTO/ASK/NEVER action classes
│   ├── integrations.md      <- declared integrations
│   ├── custom-rules.md      <- your appended rules
│   └── robin.config.json
├── artifacts/{input,output} <- file pipe, gitignored
├── backup/                  <- tar.gz archives, gitignored
└── docs/                    <- design notes, specs, plans (gitignored)
```

---

## Supported platforms

| Tool | Pointer file | How it works |
|------|-------------|--------------|
| Claude Code | `CLAUDE.md` | Pointer to `AGENTS.md` |
| Gemini CLI | `GEMINI.md` | Pointer to `AGENTS.md` |
| Cursor | (none) | Reads `AGENTS.md` natively |
| Antigravity | (none) | Reads `AGENTS.md` natively |
| Codex | (none) | Reads `AGENTS.md` natively |

Pointer files are generated from `system/scripts/lib/platforms.js`. Adding a new tool is one entry there + `npm run regenerate-pointers`.

---

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for the dev workflow.

## Changelog

See [CHANGELOG.md](CHANGELOG.md).

## License

[MIT](LICENSE)
