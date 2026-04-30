# Robin Assistant

A personal AI assistant that builds a persistent wiki about your life, learns from its mistakes, and works across multiple AI tools at the same time.

Most AI assistants forget you when the session ends. Robin doesn't. It silently captures facts, preferences, and decisions as you talk, organizes them into a structured knowledge base, and uses them in every future conversation. Correct it twice and it writes a permanent rule so the mistake stops happening. Open it in Claude Code and Cursor at the same time — same memory, coordinated writes, no conflicts.

The repo *is* the workspace. You clone it, open it in your AI tool, and Robin is alive.

---

## Why Robin

### Wiki memory

Robin's memory isn't a chat log. It's a structured wiki — topic files organized into directories, cross-referenced with a link graph, and indexed so Robin loads only what it needs. You don't tell it to remember things. You just talk. Robin watches for capturable signals — facts, preferences, decisions, corrections, dated reflections — and writes them to the right file in the same turn it answers you.

Feed it a document with the **Ingest** command and it extracts facts, creates source pages, ripples updates across related files, and maintains cross-references automatically. Run **Lint** to audit the knowledge base for contradictions, dead links, stale claims, and orphans. Over time, the wiki compounds — each session leaves Robin knowing more than the last.

### Self-improvement

Robin tracks what it gets wrong and what it gets right. When you correct it, it logs the mistake and the right answer. Three similar corrections automatically promote to a named *pattern* with recognition signals and counter-actions, so the failure mode stops recurring. Patterns that stop firing get retired.

It also builds a model of how to communicate with you. Positive feedback accumulates into a communication style profile with domain-specific overrides. It tracks its own confidence calibration — when it makes a high-stakes recommendation, it records the outcome and adjusts future confidence statements based on actual accuracy. Every quarter it runs a self-assessment: grading its own responses, checking for sycophancy, and asking you to rate it directly.

### Multi-agent coordination

Robin works across AI coding tools — Claude Code, Cursor, Gemini CLI, Antigravity, Codex. Same workspace, same memory, same rules. Switch tools mid-week and Robin picks up where it left off.

Open two tools at the same time and Robin coordinates. A session registry tracks which tools are active. File-based locks prevent conflicting writes to shared files. Append-only files like the journal and decision log are safe to write concurrently. When you start a session, Robin tells you if another session is already running.

---

## Features

### Passive capture

Robin silently captures information from your conversations without you saying "remember this." It recognizes names and relationships, dates and deadlines, preferences, decisions with reasoning, corrections, commitments, and facts mentioned in passing. Each capture is tagged (`[fact]`, `[preference]`, `[decision]`, `[correction]`, `[task]`, `[journal]`) and written to an inbox. The nightly Dream cycle routes inbox entries to the right file. High-stakes captures (medical, financial, legal) are confirmed before storing.

### Structured memory

Memory is organized into topic directories with per-file frontmatter (description, type, tags, cross-references). The layout:

| Path | Holds |
|------|-------|
| `INDEX.md` | Generated directory of every memory file — read at session start |
| `hot.md` | Rolling window of last 3 session summaries for seamless continuation |
| `LINKS.md` | Cross-reference graph between memory files |
| `profile/` | Identity, personality, interests, goals, routines, people in your life |
| `knowledge/` | Reference facts — locations, medical, projects, restaurants, recipes |
| `knowledge/sources/` | Source pages created by the Ingest command |
| `knowledge/conversations/` | Summaries of substantive conversations |
| `self-improvement/` | Corrections, preferences, calibration, communication style, domain confidence, learning queue |
| `tasks.md` | Active tasks grouped by category |
| `decisions.md` | Append-only log of decisions and their reasoning |
| `journal.md` | Dated reflections and daily notes |
| `inbox.md` | Quick-capture items waiting to be routed by Dream |
| `archive/` | Content older than 12 months, pruned automatically |

Topic files split automatically when they exceed 200 lines. The structure scales as content grows.

### Wiki operations

**Ingest** processes source documents (files, URLs, inline text) into the knowledge base — extracts entities and facts, creates source pages, updates related knowledge files, adds cross-references to the link graph, and commits the result for rollback.

**Lint** audits memory health with 8 checks: contradictions across linked files, dead links, stale claims (>6 months unverified), orphan pages, missing pages (concepts mentioned 3+ times without a dedicated file), frontmatter gaps, data gaps, and size warnings.

**Save conversation** files the key outcomes of the current conversation as a lightweight summary page. Conversations older than 90 days with no inbound links are flagged for archival.

### Self-improvement framework

Seven dimensions of self-improvement, each stored in its own file:

- **Corrections** — what Robin got wrong and what to do instead. Append-only log.
- **Patterns** — recurring mistakes promoted automatically from 3+ similar corrections. Each has recognition signals and counter-actions. Retired when they stop firing.
- **Preferences** — positive signals and explicit style feedback. 3+ similar signals promote to communication style rules.
- **Communication style** — Robin's learned interaction model. Base style plus domain-specific overrides, built from preferences over time.
- **Domain confidence** — self-assessed competence per area of your life. New domains start at medium. Decays after 90 days of inactivity.
- **Calibration** — prediction accuracy by confidence band, effectiveness scores for high-stakes recommendations, sycophancy tracking.
- **Learning queue** — questions Robin wants to ask you when a natural moment arises. One question max per session.

### Dream cycle

Runs every night at 4 AM via the OS scheduler — no session needed. Five phases:

1. **Auto-memory migration** — drains host-managed memory (e.g., Claude Code's auto-memory) into Robin's inbox
2. **Scan** — reads inbox, tasks, journal, self-improvement files, hot cache, operation log
3. **Memory management** — routes inbox entries, promotes durable facts from journal, prunes finished tasks, checks freshness of profile and knowledge files
4. **Self-improvement processing** — promotes corrections to patterns, reviews pattern effectiveness, processes session reflections, promotes preferences to communication style, updates domain confidence, maintains learning queue, updates calibration
5. **Memory tree maintenance** — splits oversized files, cleans empty files, regenerates indexes, trims hot cache, rebuilds link graph, flags old conversations for archival

Unresolvable issues are escalated in a report: contradictions, ambiguous inbox items, time-sensitive items, ineffective patterns, calibration drift.

### Job system

A cross-platform scheduler that runs jobs on your OS (launchd on macOS, cron on Linux, Task Scheduler on Windows), independent of AI sessions. Jobs are defined as markdown files with YAML frontmatter specifying runtime (agent or node), schedule, triggers, and timeout.

Shipped jobs span daily maintenance, financial review, productivity, and system health:

| Job | Schedule | What it does |
|-----|----------|--------------|
| Dream | Daily 4 AM | Memory maintenance and self-improvement processing |
| Morning briefing | Daily 7 AM (disabled) | Calendar, priorities, flagged items, suggested focus |
| Weekly review | Sunday 10 AM (disabled) | Accomplishments, backlog health, goal check-ins, look-ahead |
| Monthly financial | 1st of month (disabled) | Income, recurring outflows, budget variance, anomalies |
| Quarterly self-assessment | Quarterly (disabled) | Effectiveness audit, calibration check, sycophancy detection, user grading |
| Subscription audit | 15th of month (disabled) | Recurring charges review, cancel/renegotiate candidates |
| System maintenance | On demand (disabled) | Interactive review of stale tasks, pending decisions, pattern effectiveness |
| Backup | Daily 3 AM | Snapshot of user-data to timestamped backup |
| Prune | Monthly (disabled) | Archive content older than 12 months |
| Auto-memory migration | Hourly | Drain host auto-memory into Robin's inbox |
| Email triage | On demand (disabled) | Classify unread email, surface action items, route receipts |
| Meeting prep | On demand (disabled) | Gather context, attendees, prior history, talking points |
| Todo extraction | On demand (disabled) | Extract action items from forwarded email/documents |
| Receipt tracking | On demand (disabled) | Find and summarize receipts by vendor, time range, or category |
| Ingest | On demand (disabled) | Process source documents into the knowledge base |
| Lint | On demand (disabled) | Audit memory health |
| Save conversation | On demand (disabled) | File conversation outcomes as summary pages |
| Host validation | Quarterly (disabled) | Verify all supported AI tools still honor loading rules |
| Multi-session coordination | On demand (disabled) | In-session protocol that registers active sessions and acquires file locks |
| Reconciler heartbeat | Every 6 hours | Pick up new/changed job definitions and update scheduler entries |

Add a job by dropping a markdown file in `user-data/jobs/` — the reconciler picks it up within 6 hours.

The runner handles atomic locks, active-window gating, catch-up for missed runs (laptop was closed), failure categorization, and native OS notifications on status transitions.

### Service integrations

Robin can pull data from external services on a schedule so it has context about your life without you pasting things in:

- **Google Calendar** — upcoming and recent events (every 30 min)
- **Gmail** — inbox metadata: senders, subjects, labels (every 15 min, no message bodies)
- **GitHub** — authored events, notifications, releases from starred repos (hourly)
- **Spotify** — recently played, top tracks/artists, playlists (every 4 hours)
- **Lunch Money** — financial transactions and category breakdowns (daily 1 AM)

Each integration is a standalone script with OAuth setup, bootstrap sync, and a job definition. All ship disabled — they only run after you complete auth setup. Per-provider walkthroughs (creating OAuth clients, choosing scopes, known gotchas like Spotify's `127.0.0.1` redirect requirement and GitHub fine-grained PAT limits on `/notifications`) live in [`system/integrations/`](system/integrations/README.md). Write CLIs are available for GitHub (`create-issue`, `comment`, `label`, `mark-read`) and Spotify (`queue`, `skip`, `playlist-add`) with `--dry-run` support. Calendar and Gmail writes use your AI tool's native capabilities.

The integration system is built on a shared library (`system/scripts/lib/sync/`) providing OAuth2 token refresh, secrets management, sync cursors, HTTP retry with exponential backoff, privacy redaction, and atomic markdown writes.

### Chat front-ends

Talk to Robin from outside your terminal. The first front-end is a personal **Discord bot** (macOS, launchd-supervised) — `@`-mention or DM the bot in your private server and it spawns a Claude Code subprocess against your Robin workspace, replying inline with full session continuity per Discord thread / DM channel. Allowlisted to a single user + a single guild; the events log records metadata only (no prompt or reply text). Setup walkthrough: [`system/integrations/discord-setup.md`](system/integrations/discord-setup.md).

### Privacy

Personal data never leaves your machine unless you explicitly push it to a remote you control. Four layers enforce this:

1. **`.gitignore`** excludes `user-data/`, `artifacts/`, `backup/`, `docs/`
2. **Pre-commit hook** refuses any commit that stages files in those directories or removes `user-data/` from `.gitignore`
3. **Capture rules** block writes containing full government IDs, payment card numbers, passwords, API keys, or credentials. Cannot be overridden, even by your own custom rules.
4. **Redaction module** automatically strips sensitive patterns (SSNs, SINs with Luhn validation, credit card numbers, API keys, URL credentials) from sync data before storage

### Token optimization

Robin's instruction layer is organized into tiers to minimize token usage at session start:

- **Tier 1** (always loaded) — core rules, capture checkpoint, manifest pointers. Capped at 5,800 tokens (5,600 for the cache-stable prefix).
- **Tier 2** (on demand) — job protocols, detailed rules. Loaded only when triggered.
- **Tier 3** (cold storage) — archived memory, historical data.

CI enforces token budgets on every PR. A measurement harness tracks per-file token counts, a golden-session snapshot detects load-order drift, and a memory linter catches structural issues.

### Customization

Four extension points, all in `user-data/` (gitignored, survives `git pull`):

- **`custom-rules.md`** — your own rules, appended to the rule list. Override operational rules but not immutable rules (privacy, verification). Examples: language preference, persona overrides, custom capture rules.
- **`jobs/`** — overlays `system/jobs/`. **The default convention is a shallow override** (`override: <name>` frontmatter): you change only what you need, the rest inherits from the system definition and keeps tracking upstream upgrades. Use a full override (no `override:` key) only when you intend to fully replace a system job. Drop a brand-new file to extend the catalog.
- **`scripts/`** — per-user integration scripts. Templates scaffolded from `system/skeleton/scripts/` on install. Add a new integration by dropping a job def + script and importing from `system/scripts/lib/sync/`.
- **`integrations.md`** — declare which platform integrations are configured. Jobs check this before assuming a capability is available.

#### Customizing a job (the default pattern)

Tweak any shipped job — schedule, body, prompt, enabled flag — without forking the package:

```markdown
<!-- user-data/jobs/morning-briefing.md -->
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
#      - copies system/skeleton/* into user-data/
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

If you ran `npm install` in a non-interactive shell (CI, no TTY), the prompts are skipped and `user-data/robin.config.json` ships with placeholder values — fill them in before your first session.

---

## Updating

```bash
git pull                    # if you cloned upstream
git pull upstream main      # if you forked
```

This only touches files in `system/` and root pointer files. **`user-data/`, `artifacts/`, `backup/`, and `docs/` are gitignored — your personal data is never touched by an update.**

Migrations, config upgrades, and skeleton sync run during `npm install` (via the postinstall hook), not at session start. This keeps the AI session's cold start fast.

If `git pull` reports a conflict, run `git checkout -- <conflicting-path>` — tracked files are upstream-owned. Move customizations into the extension points above.

---

## Commands

| Command | Purpose |
|---------|---------|
| `npm run backup` | Snapshot `user-data/` to `backup/user-data-<timestamp>.tar.gz` |
| `npm run restore` | Restore `user-data/` from a backup archive (interactive) |
| `npm run reset` | Wipe `user-data/`, recopy skeleton, re-prompt config (auto-backups first) |
| `npm test` | Run the test suite (~390 tests) |
| `npm run lint-memory` | Check for orphan files, stale INDEX entries, oversized sub-trees |
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
| `robin update` | Post-`git pull` check: config migrate, pending migrations, skeleton sync, validate |
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
│   └── robin.js             <- CLI entry point
├── system/                  <- upstream-owned, tracked, never user-edited
│   ├── startup.md
│   ├── capture-rules.md
│   ├── manifest.md
│   ├── jobs/                <- shipped jobs (agent protocols + node scripts)
│   ├── migrations/          <- versioned schema migrations
│   ├── scripts/
│   │   ├── jobs/            <- runner, reconciler, CLI, installer adapters
│   │   ├── lib/jobs/        <- frontmatter, cron, locks, state, notifications
│   │   └── lib/sync/        <- shared sync infrastructure (oauth, secrets, http, redact)
│   ├── skeleton/            <- first-run templates for user-data/
│   └── tests/
├── user-data/               <- your data, gitignored
│   ├── memory/              <- structured memory tree
│   ├── jobs/                <- your custom jobs + overrides
│   ├── scripts/             <- per-user integration scripts
│   ├── secrets/             <- credentials (.env)
│   ├── sources/             <- immutable source document archive
│   ├── state/               <- sessions, locks, sync cursors, job logs
│   └── robin.config.json
├── artifacts/{input,output} <- file pipe, gitignored
├── backup/                  <- tar.gz archives, gitignored
└── docs/                    <- design notes, gitignored
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
