# Robin Assistant

A personal AI assistant for Claude Code that builds a persistent wiki about your life and learns from its mistakes.

Most AI assistants forget you when the session ends. Robin doesn't. It silently captures facts, preferences, and decisions as you talk, organizes them into a structured wiki, cross-links every entity automatically, and pulls the relevant pages back in on the next turn — before you finish your sentence. Correct it twice and it writes a permanent rule so the mistake stops happening. Open multiple Claude Code sessions at the same time — same memory, coordinated writes, no conflicts.

The repo *is* the workspace. You clone it, open it in Claude Code, and Robin is alive.

---

## Quickstart

**Prerequisites:** [Node.js 18+](https://nodejs.org/), git, [Claude Code](https://claude.com/claude-code).

```bash
git clone git@github.com:kevinkiklee/robin-assistant.git robin
cd robin
npm install
```

`npm install`'s postinstall scaffolds `user-data/`, prompts for your name, timezone, email, and assistant name (in a TTY) or writes placeholders (in CI), and installs the pre-commit privacy hook.

Open `robin/` in Claude Code. `CLAUDE.md` is auto-discovered from cwd; Robin introduces itself on the first prompt.

For non-interactive installs, install scenarios (CI), fork vs. clone, and post-install verification, see [Installation](#installation) below.

---

## Why Robin

### Wiki memory

Robin's memory isn't a chat log. It's a structured wiki — topic files organized into directories, cross-referenced with a link graph, and indexed so Robin loads only what it needs. You don't tell it to remember things. You just talk. Robin watches for capturable signals — facts, preferences, decisions, corrections, dated reflections — and writes them to the right file in the same turn it answers you.

Every entity (person, place, project, service) gets a page with `aliases:` in its frontmatter. Every memory write auto-links via a `PostToolUse` hook that converts the *first mention* of every known entity into a wiki-link — no manual `[[…]]` typing. The result is a self-maintaining knowledge graph: the more Robin learns, the more densely connected the wiki becomes.

Feed it a document with the **Ingest** command and it extracts facts, creates source pages, ripples updates across related files, and maintains cross-references automatically. Run **Lint** to audit the knowledge base for contradictions, dead links, stale claims, orphans, conversational tics, ambiguous aliases, and concepts mentioned three times without a dedicated page. Over time, the wiki compounds — each session leaves Robin knowing more than the last.

### Auto-recall

The model is supposed to look things up but doesn't always remember to. Robin closes the gap with a UserPromptSubmit hook: when you submit a prompt, the hook scans your message *and* the previous assistant message for known entities, plus a configurable activity-keyword map (e.g. "fertilizer" → garden notes, "whoop" → recovery file), then injects the matching memory directly into the model's input as `<!-- relevant memory -->` blocks. Follow-ups like "schedule it" inherit the entity from the prior turn.

All retrieval is in-process Node-native — no ripgrep, no API key, no external service. Telemetry lives in `user-data/runtime/state/{recall,hook-perf}.log`.

### Self-improvement

Robin tracks what it gets wrong and what it gets right. When you correct it, it logs the mistake and the right answer. Three similar corrections automatically promote to a named *pattern* with recognition signals and counter-actions, so the failure mode stops recurring. Patterns that stop firing get retired after 180 days.

It also builds a model of how to communicate with you. Positive feedback accumulates into a communication style profile with domain-specific overrides. It tracks its own confidence calibration — when it makes a high-stakes recommendation, it tags it with `[predict|<check-by-date>|<confidence>]`, and the weekly outcome-check job revisits each prediction past its check-by date so calibration is fed by *actual outcomes*, not just self-reports. Every quarter it runs a self-assessment: grading its own responses, checking for the five named conversational tics, and asking you to rate it directly.

### Action states (AUTO / ASK / NEVER)

Instead of a single global "ask before acting" rule, Robin classifies every tool call into one of three classes — AUTO (just do it), ASK (confirm first), NEVER (refuse). Classes live in `policies.md` (you edit them); a deterministic precheck enforces hard rules (privacy, dollar amounts, legal, explicit NEVERs). A separate **action-trust** ledger tracks earned trust per class: 5+ successes with no corrections over 30 days proposes promotion ASK → AUTO; a single user reversal demotes back to ASK. Self-correction is a first-class path — Robin can reverse its own AUTO action and write the correction in the same turn.

### Parallel Claude Code sessions

Open multiple Claude Code sessions against the same workspace and Robin coordinates. A session registry tracks which sessions are active. File-based locks prevent conflicting writes to shared files. Append-only files like the journal and decision log are safe to write concurrently. When you start a session, Robin tells you if another session is already running.

### Security boundaries

Personal data has explicit defenses against prompt injection from sync sources and against the model exfiltrating data through outbound writes:

- **Boundary defenses** — every sync writer wraps untrusted content in `UNTRUSTED-START`/`UNTRUSTED-END` sentinels and stamps `trust:untrusted` frontmatter. Capture tags carry an `origin=` attribution. A pre-filter quarantines inbox lines that don't claim `origin=user`.
- **Outbound write policy** — outbound write paths (github-write, spotify-write, discord reply) run through a three-layer policy: sentence-hash taint check against the untrusted index, sensitive-shape detection (PII patterns + `process.env` value substring scan), and a credential-derived target allowlist.
- **Secrets containment** — secrets are read on demand from `user-data/runtime/secrets/.env` per call without polluting `process.env`. Spawn sites build explicit minimal envs.
- **Bash policy** — seven rules (secrets-read, env-dump, destructive-rm, low-level-fs, git-expose-userdata, eval-injection, misrouted-write) hook the Bash tool and fail closed.
- **Tamper detection** — a manifest baseline + `check-manifest.js` runs on SessionStart; severe drift surfaces in stderr and logs `kind=tamper`.
- **PII scan on memory writes** — PreToolUse hook scans writes to `user-data/memory/` for credentials and high-stakes shapes; blocks and explains.

---

## Features

### Passive capture

Tags facts, preferences, decisions, corrections, tasks, predictions, and watch deltas as you talk — no "remember this" needed. Writes to an inbox; nightly Dream routes to the right file. High-stakes captures (medical, financial, legal) are confirmed before storing.

### Structured memory

Topic directories with per-file frontmatter (description, type, tags, aliases, decay). Files split at 200 lines; per-sub-tree decay drives staleness alerts.

| Path | Holds |
|------|-------|
| `INDEX.md` / `ENTITIES.md` / `LINKS.md` | Generated indexes — read at session start for fast recall |
| `hot.md` | Rolling window of recent session summaries |
| `profile/` | Identity, personality, goals, routines, people |
| `knowledge/` | Reference facts — locations, medical, projects, restaurants, providers |
| `self-improvement/` | Corrections, patterns, preferences, calibration, predictions |
| `watches/` | Per-topic pages for proactive following |
| `tasks.md` / `decisions.md` / `journal.md` / `inbox.md` | Append-only logs |
| `archive/` | Content older than 12 months |

### Wiki-graph (entity linking)

Pages declare `aliases:` in frontmatter. The `PostToolUse` hook converts the first occurrence of every known alias into a wiki-link on every memory write — preserving case, skipping frontmatter / code / URLs, fail-soft. Sync writers and protocols rely on the same hook. Lint flags ambiguous aliases and concepts mentioned 3+ times without a dedicated page.

### Wiki operations

- **Ingest** — process source documents into the knowledge base; extracts facts, ripples updates, links entities, commits for rollback.
- **Lint** — audit for contradictions, dead links, stale claims, orphans, missing pages, ambiguous aliases, conversational tics.
- **Audit** — weekly LLM-pass over candidate file pairs; surfaces contradictions for review. Never auto-edits.
- **Save conversation** — file conversation outcomes as a summary page.
- **Deep-ripple** — agent protocol for ingestions whose ripple exceeds the mechanical pass.

### Self-improvement

Robin tracks what it gets wrong and what works. Each lives in its own file under `self-improvement/`:

- **Corrections** → promote to **patterns** after 3+ similar mistakes (180-day TTL).
- **Preferences** → promote to **communication style** rules.
- **Predictions** tagged `[predict|<check-by>|<confidence>]` feed **calibration** weekly via the outcome-check job.
- **Action-trust** earns ASK→AUTO promotion from a clean 30-day track; demotes on any user reversal.
- **Learning queue** surfaces one question per session at natural moments.

### Dream cycle

Runs nightly via the OS scheduler — no session needed. Routes the inbox, promotes corrections to patterns, regenerates indexes, retires patterns that stopped firing, and escalates unresolvable items (contradictions, calibration drift, tamper findings) in a morning report.

### Job system

Cross-platform scheduler (launchd / cron / Task Scheduler) running independently of AI sessions. Jobs are markdown files with YAML frontmatter (`runtime`, `schedule`, `triggers`, `timeout`). The runner handles atomic locks, active windows, catch-up for missed runs, and OS notifications. Drop a file in `user-data/runtime/jobs/` to add one.

Shipped jobs:

| Job | Schedule | What it does |
|-----|----------|--------------|
| Dream | Daily 4 AM | Memory maintenance, self-improvement, telemetry surfacing, ENTITIES.md regen |
| Daily briefing | Daily 7 AM (disabled) | Calendar, priorities, flagged items, suggested focus |
| Weekly review | Sunday 10 AM (disabled) | Accomplishments, backlog health, goal check-ins, look-ahead |
| Monthly financial | 1st of month (disabled) | Income, recurring outflows, budget variance, anomalies |
| Quarterly self-assessment | Quarterly (disabled) | Effectiveness audit, calibration check, conversational-tic detection, user grading |
| Subscription audit | 15th of month (disabled) | Recurring charges review, cancel/renegotiate candidates |
| System maintenance | On demand (disabled) | Interactive review of stale tasks, pending decisions, pattern effectiveness, prediction resolution, audit findings |
| Backup | Daily 3 AM | Snapshot of user-data to timestamped backup |
| Prune | Monthly (disabled) | Archive content older than 12 months |
| migrate-auto-memory | Hourly | Drain host auto-memory into Robin's inbox |
| Email triage | On demand (disabled) | Classify unread email, surface action items, route receipts |
| Meeting prep | On demand (disabled) | Gather context, attendees, prior history, talking points |
| Todo extraction | On demand (disabled) | Extract action items from forwarded email/documents |
| Receipt tracking | On demand (disabled) | Find and summarize receipts by vendor, time range, or category |
| Ingest | On demand (disabled) | Process source documents into the knowledge base; runs entity linker on every rippled file |
| Lint | On demand (disabled) | Audit memory health |
| Save conversation | On demand (disabled) | File conversation outcomes as summary pages |
| Deep-ripple | On demand (disabled) | Agent protocol for high-impact ingestions whose ripple exceeds the mechanical pass |
| Multi-session coordination | On demand (disabled) | In-session protocol that registers active sessions and acquires file locks |
| Outcome check | Sunday 10 AM (disabled) | Revisit open `[predict]` claims past their check-by date; propose resolution; user confirms in system-maintenance |
| Audit | Sunday 11 AM (disabled) | LLM-pass over candidate file pairs (via LINKS.md cross-references) to surface contradictions and redundancies for user review |
| Watch topics | Hourly (disabled) | Iterate active watches, fetch via WebSearch, dedupe vs per-watch fingerprints, redact, write deltas to inbox with `[watch:<id>]` tag |
| Reconciler heartbeat | Every 6 hours | Pick up new/changed job definitions, update scheduler entries, sweep stale locks |

### Service integrations

Pull data from external services on a schedule so Robin has context without you pasting it in. All ship disabled until you complete auth setup; per-provider walkthroughs in [`system/integrations/`](system/integrations/README.md).

- **Google Calendar** — events (every 30 min)
- **Gmail** — inbox metadata: senders, subjects, labels (every 15 min, no bodies)
- **GitHub** — authored events, notifications, releases (hourly)
- **Spotify** — recently played, top tracks, playlists (every 4 hours)
- **Lunch Money** — transactions and category breakdowns (daily)

Write CLIs (with `--dry-run`) for GitHub (`create-issue`, `comment`, `label`, `mark-read`) and Spotify (`queue`, `skip`, `playlist-add`). Calendar and Gmail writes use your AI tool's native capabilities. Shared library at `system/scripts/sync/lib/` handles OAuth refresh, secrets, retry with backoff, redaction, and atomic writes.

### Chat front-ends

Talk to Robin outside your terminal. The first front-end is a personal **Discord bot** (macOS, launchd-supervised) — `@`-mention or DM and it spawns a Claude Code subprocess against your workspace with full session continuity per thread / DM. Allowlisted to a single user + guild; events log records metadata only. The reply path runs through the outbound write policy (taint check, sensitive-shape scan, target allowlist). Setup: [`system/integrations/discord-setup.md`](system/integrations/discord-setup.md).

### Privacy

Personal data never leaves your machine unless you push it. Four layers:

1. **`.gitignore`** excludes `user-data/` and `docs/`.
2. **Pre-commit hook** refuses commits that stage files in those dirs.
3. **Capture rules** block writes containing government IDs, card numbers, passwords, or API keys. Cannot be overridden.
4. **Redaction module** strips sensitive patterns from sync data before storage.

### Token optimization

The instruction layer loads in tiers to minimize session-start tokens:

- **Tier 1** (always loaded): core rules, identity, indexes, hot cache. Capped at 13,800 tokens / 595 lines.
- **Tier 2** (on demand): protocols, capture rules, security rules.
- **Tier 3** (cold): archived memory, full historical detail.

A token-budget JSON is the single source of truth; a measurement harness and golden-session snapshot enforce caps and catch load-order drift.

### Customization

Four extension points, all in `user-data/` (gitignored, survives `git pull`):

- **`custom-rules.md`** — your own rules, appended to the rule list (can't override immutable privacy / verification rules).
- **`runtime/jobs/`** — overlays `system/jobs/`. Drop a file with `override: <name>` frontmatter to tweak only the fields you want; the rest inherits and keeps tracking upstream changes.
- **`runtime/scripts/`** — per-user integration scripts (templated from `system/scaffold/runtime/scripts/`).
- **`integrations.md`** — declare which integrations are configured; jobs gate on this.

```markdown
<!-- user-data/runtime/jobs/daily-briefing.md — example override -->
---
override: daily-briefing
schedule: "0 6 * * *"
---
```

`robin jobs enable <name>` / `disable <name>` write shallow overrides automatically.

### Memory lifecycle

Content older than 12 months is automatically archived by the prune job. Year-end splits break `decisions.md` and `journal.md` by calendar year. Dry-run preview before any move; pre-prune backups automatic.

### Session handoff

At session end, Robin runs a capture sweep — scans for uncaptured signals, dedupes against the inbox, writes a session summary to `hot.md`. The next session reads it right after the index and picks up where you left off.

---

## Installation

### Prerequisites

- **Node.js 18 or later** — check with `node --version`
- **git**
- **Claude Code** — Robin v5 supports Claude Code only.

### Steps

```bash
# 1. Fork or clone. Forking gives you a private remote for system-side
#    customizations. Personal data stays local regardless (it's gitignored).
git clone git@github.com:kevinkiklee/robin-assistant.git robin
cd robin

# 2. Install. The postinstall step:
#      - copies system/scaffold/* into user-data/
#      - creates user-data/{artifacts/{input,output},backup,sources}/
#      - prompts for your name, timezone, email, assistant name
#      - installs the pre-commit privacy hook
#      - applies migrations and installs scheduler entries
npm install

# 3. Open the repo in Claude Code. CLAUDE.md is auto-discovered from cwd.
#    Robin will introduce itself.
```

That's it. No global CLI. The repo is self-contained.

If you ran `npm install` in a non-interactive shell (CI, no TTY), the prompts are skipped and `user-data/runtime/config/robin.config.json` ships with placeholder values — fill them in before your first session.

---

## Updating

```bash
git pull                    # if you cloned upstream
git pull upstream main      # if you forked
npm install                 # runs migrations, config upgrade, scaffold sync, scheduler reinstall
```

This only touches files in `system/` and root pointer files. **`user-data/` and `docs/` are gitignored — your personal data is never touched by an update.**

Migrations, config upgrades, and scaffold sync run during `npm install` (via the postinstall hook), not at session start. This keeps the AI session's cold start fast.

If `git pull` reports a conflict on a tracked file, run `git checkout -- <path>` — tracked files are upstream-owned. Move any customizations into the extension points (`user-data/custom-rules.md`, `user-data/runtime/jobs/`, `user-data/runtime/scripts/`).

---

## Commands

Most surface lives under `robin <namespace>`. The npm script set is intentionally tiny.

**Tests**

| Command | Purpose |
|---------|---------|
| `npm test` | Unit + e2e tests (default) |
| `npm run test:unit` / `test:e2e` / `test:install` | Run a single test tier individually. `test:install` is the slowest (`npm pack` + install scenario, 120s timeout) |

**Top-level**

| Command | Purpose |
|---------|---------|
| `robin init [--target <dir>] [--no-prompt]` | Bootstrap a fresh workspace from the installed package. Used when installing globally (`npm i -g robin-assistant`) instead of cloning |
| `robin update` | Post-`git pull` check: config migrate, pending migrations, scaffold sync, validate. Also re-snapshots the tamper manifest when an upstream-driven `.claude/settings.json` hook change is detected |
| `robin backup` | Snapshot `user-data/` to `backup/user-data-<timestamp>.tar.gz` |
| `robin restore` | Restore `user-data/` from a backup archive (interactive) |
| `robin run <name>` | Manually invoke a job. `--force` skips gating, `--dry-run` prints the plan |
| `robin run --due` | Cron entry point — run every enabled job whose schedule has elapsed since the last run |

**Jobs**

| Command | Purpose |
|---------|---------|
| `robin jobs list` | Show all jobs with enabled state, schedule, last run, status |
| `robin jobs status <name>` | Detail on one job — last run, log location, next run |
| `robin jobs logs <name>` | Tail the most recent run's summary (`--full` for complete log) |
| `robin jobs upcoming` | 7-day forward calendar of scheduled runs |
| `robin jobs enable <name>` / `disable <name>` | Toggle a job on/off |
| `robin jobs sync` | Force-reconcile OS scheduler with job definitions |
| `robin jobs validate` | Parse and validate every job definition |

**Memory**

| Command | Purpose |
|---------|---------|
| `robin memory regenerate-links` | Rebuild the cross-reference graph in `user-data/memory/LINKS.md` |
| `robin memory index-entities` | Rebuild `user-data/memory/ENTITIES.md` from frontmatter aliases |
| `robin memory lint` | Audit memory: orphans, stale INDEX entries, oversized sub-trees, staleness, ambiguous aliases, candidate entities, conversational tics |
| `robin memory densify [--dry-run \| --apply]` | Audit cross-linking gaps across `user-data/memory/` and write a report. **Always run `--dry-run` first**, review, then `--apply` to commit (auto-backups first; reversible via `robin restore`) |
| `robin memory prune-preview` | Preview what the 12-month archive prune would move |
| `robin memory prune-execute` | Run the archive prune (auto-backups first) |

**Watches**

| Command | Purpose |
|---------|---------|
| `robin watch add "<topic>"` | Add a topic to follow; runs first fetch immediately to seed fingerprints |
| `robin watch list` | List active and disabled watches |
| `robin watch enable <id>` / `disable <id>` | Toggle a watch on/off |
| `robin watch tail [<id>]` | Show recent `[watch]` items from inbox (filtered by id if given) |
| `robin watch run <id> [--dry-run \| --bootstrap]` | Manually trigger a watch (real fetch requires the watch-topics agent-runtime job) |

**Trust ledger**

| Command | Purpose |
|---------|---------|
| `robin trust [status \| pending \| history [--days N] \| class <slug>]` | Inspect the action-trust ledger — current ASK/AUTO/NEVER state per class, pending promotions, recent history |

**Discord**

| Command | Purpose |
|---------|---------|
| `robin discord install` / `uninstall` | Install / remove the Discord bot launchd agent (macOS) |
| `robin discord auth` | Walk through Discord bot OAuth + token storage |
| `robin discord status` / `health` | Inspect bot daemon status / liveness |

**Dev (diagnostics + escape hatches)**

| Command | Purpose |
|---------|---------|
| `robin dev measure-tokens` | Measure tier token counts. `--check` enforces caps, `--diff` shows delta |
| `robin dev measure-prefix-bloat -- <session.jsonl>` | Measure plugin/skill prefix bloat from a Claude Code session JSONL. `--first-turn` for clean session-start signal |
| `robin dev check-plugin-prefix -- <session.jsonl>` | Detect plugins/MCPs not on the diagnostics whitelist. Useful after plugin auto-updates |
| `robin dev check-protocol-triggers` | Audit protocol trigger phrases for collisions / regressions |
| `robin dev check-doc-paths` | Verify doc cross-references resolve |
| `robin dev golden-session` | Snapshot Tier 1 load order; `--check` fails on drift. Catches load-order regressions that affect prompt-cache stability |
| `robin dev tool-call-stats` | Aggregate tool-call statistics across sessions |
| `robin dev migrate-auto-memory` | One-time migration: drain host auto-memory into Robin's inbox |
| `robin dev reset` | DESTRUCTIVE — wipe `user-data/`, recopy scaffold, re-prompt config (auto-backups first) |

---

## Installing community skills

Robin can install external Claude SKILL.md skills from awesome-claude-skills or any GitHub repo:

```bash
robin skill install https://github.com/anthropics/skills/tree/main/skills/pdf
robin skill install https://github.com/owner/skill-repo
robin skill install /path/to/local/skill
```

Installed skills land under `user-data/skills/external/<name>/` and are auto-discovered at the next session via `user-data/skills/external/INDEX.md`. They're treated as `trust: untrusted-mixed` — Robin paraphrases their outputs and routes their actions through its existing PII, outbound, and bash hooks.

Manage installed skills:

```bash
robin skill list                # what's installed
robin skill show <name>         # SKILL.md body + manifest entry
robin skill update [<name>]     # git pull (no re-validation)
robin skill uninstall <name>    # remove
robin skill doctor [--fix]      # validate + regen INDEX.md
robin skill restore             # reinstall from manifest (cross-machine recovery)
```

If a skill ships scripts (Node, Python, Ruby), you may need to install its dependencies manually inside the skill folder.

---

## Workspace structure

```
robin/
├── CLAUDE.md                <- Canonical instructions (auto-discovered by Claude Code from cwd)
├── bin/
│   └── robin.js             <- CLI entry point (init, update, run, jobs, memory, watch, trust, discord, dev, backup, restore)
├── system/                  <- upstream-owned, tracked, never user-edited
│   ├── rules/               <- agent-readable rules (capture, security, self-improvement, startup)
│   ├── jobs/                <- shipped jobs (agent protocols + node scripts)
│   ├── migrations/          <- versioned schema migrations
│   ├── scripts/
│   │   ├── cli/             <- user-facing CLI entry points (invoked by bin/robin.js)
│   │   ├── hooks/           <- claude-code.js (UserPromptSubmit / PreToolUse / Stop / on-pre-bash) + pre-commit.js
│   │   ├── jobs/            <- runner, reconciler, OS-scheduler installer adapters
│   │   ├── memory/          <- index-entities, backfill-entity-links, densify-wiki, lint, prune, regenerate-{index,links}
│   │   ├── capture/         <- ingest guard, dream pre-filter, auto-memory, action classification
│   │   ├── sync/            <- oauth, secrets, http, redact, markdown, cursor (sync state), untrusted-index
│   │   ├── wiki-graph/      <- entity registry, link application, exclusions
│   │   ├── watches/         <- slugify, frontmatter parse, list/state I/O
│   │   ├── migrate/         <- migration apply harness + helpers
│   │   ├── diagnostics/     <- check-manifest, manifest-snapshot, measure-tokens, check-doc-paths, hard-rules-hash
│   │   └── lib/             <- cross-cutting utilities (outbound-policy, bash-sensitive-patterns, manifest)
│   ├── scaffold/            <- first-run templates for user-data/
│   ├── integrations/        <- per-provider setup playbooks
│   └── tests/               <- mirrors system/scripts/ layout
└── user-data/               <- your data, gitignored
    ├── memory/              <- structured memory tree (INDEX, ENTITIES, profile, knowledge, self-improvement, streams, watches, archive)
    ├── runtime/             <- everything that isn't user memory
    │   ├── config/          <- robin.config.json, integrations.md, integrations-setup.md, policies.md
    │   ├── jobs/            <- your custom jobs + shallow overrides
    │   ├── scripts/         <- per-user integration scripts (sync-*, auth-*, *-write, discord-bot)
    │   ├── secrets/         <- credentials (.env, mode 0600 enforced)
    │   ├── security/        <- manifest.json baseline, refusal logs
    │   └── state/           <- sessions, locks, sync cursors, job logs, capture/recall/hook-perf logs
    ├── artifacts/{input,output} <- file pipe (input drop / generated output)
    ├── sources/             <- immutable source document archive
    ├── backup/              <- tar.gz snapshots taken before risky operations
    └── custom-rules.md      <- your appended rules (optional)
```

`docs/` (design notes, specs, plans) is also gitignored if present locally; it does not ship in the package.

---

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for the dev workflow.

## Changelog

See [CHANGELOG.md](CHANGELOG.md).

## License

[MIT](LICENSE)
