# Robin Assistant

A personal AI assistant with persistent memory and a daily self-improvement loop, portable across AI coding tools.

Most AI assistants forget you the moment a session ends. Robin doesn't. Tell it your home is in Seattle on Monday; on Friday when you ask "what's a good coffee shop near home?" it just knows. Correct it twice on the same thing and it adds a permanent rule. Once a day it cleans up its own memory while you sleep. Switch from Claude Code to Cursor mid-week — same Robin, same memory.

The repo *is* the workspace. You clone it, open it in your AI tool, and Robin is alive.

---

## What Robin does

### It remembers, silently

You don't say "remember this." You just talk. Robin watches the conversation for capturable signals — facts about you, recurring contacts, durable preferences, decisions, dated reflections — and writes them to the right file in `user-data/` in the same turn it answers you. The capture rules live in `system/capture-rules.md`; you can read and tune them.

The memory is structured, not a chat log. Topic folders for content that grows over time, flat files for time-ordered logs, and a generated `INDEX.md` so Robin loads only what it needs.

| Path | Holds |
|------|-------|
| `INDEX.md` | Generated directory of every memory file — read at session start to map what's where |
| `hot.md` | Rolling window of last 3 session summaries for seamless continuation |
| `LINKS.md` | Cross-reference graph between memory files |
| `profile/` | Identity, personality, interests, goals, routines, the people in your life (one file per area) |
| `knowledge/` | Reference facts — locations, medical, projects, restaurants, recipes |
| `knowledge/sources/` | Source pages created by the Ingest operation |
| `knowledge/conversations/` | Filed conversation outcomes |
| `tasks.md` | Active tasks grouped by category |
| `decisions.md` | Append-only log of significant decisions and their reasoning |
| `journal.md` | Dated reflections and daily notes |
| `inbox.md` | Quick-capture items waiting to be routed by Dream |
| `self-improvement/` | Corrections, preferences, calibration, communication style, domain confidence, learning queue, session handoff |
| `archive/` | Content older than 12 months, pruned automatically |

Topic files are split when they exceed `memory.split_threshold_lines` (default 200) at the next Dream cycle — the structure scales as content grows.

You can feed Robin documents, URLs, or inline text with the **Ingest** command. It creates source pages under `knowledge/sources/`, ripples updates across related knowledge files, and maintains a cross-reference graph in `LINKS.md`. A **Lint** command audits memory health: contradictions, dead links, stale claims, orphans, and oversized files.

### It learns from corrections

When you correct Robin — "no, I don't want X, I want Y" — it logs what went wrong and the right response. Three similar corrections promote to a named *pattern* with a recognition signal and a counter-action, so the failure mode stops happening. Over time, the corrections-to-wins ratio falls and Robin stops needing the same nudge twice.

It also tracks how confident it should be. When it makes a high-stakes recommendation it records the outcome later, and uses the running accuracy to calibrate future confidence statements.

### It maintains itself daily

**Dream** runs every night at 04:00 — a maintenance pass that routes your inbox, promotes durable facts from the journal, prunes finished tasks, retires stale knowledge, promotes recurring corrections to patterns, retires patterns that stopped firing, and updates calibration. It runs from your OS scheduler (launchd / cron / Task Scheduler), not from your AI session, so you don't have to open a session for it to fire. You don't run it manually, you don't see most of it — you just notice that the workspace stays tidy without effort.

### It syncs with your services

Robin can pull data from external services on a schedule so it has context about your life without you having to paste things in. Shipped integrations:

- **Calendar** — upcoming and recent events from Google Calendar (every 30 min)
- **Gmail** — inbox metadata: senders, subjects, labels (every 15 min, no message bodies)
- **GitHub** — authored events, notifications, releases from starred repos (hourly)
- **Spotify** — recently played, top tracks/artists, playlists (hourly)
- **Lunch Money** — financial transactions and category breakdowns

Each integration is a standalone script in `user-data/scripts/` with a corresponding job def in `user-data/jobs/`. Enable one by running its auth script, bootstrapping the initial sync, and enabling the job:

```bash
node user-data/scripts/auth-google.js        # one-time OAuth
node user-data/scripts/sync-calendar.js --bootstrap
robin jobs enable sync-calendar
```

Integrations ship disabled by default and only run after you complete per-provider auth setup. Sync data stays local in `user-data/` — credentials live in `user-data/secrets/.env`.

### It enforces hard rules

A small set of immutable rules can never be overridden — even by your own custom rules:

- **Privacy.** Robin refuses to store full government IDs, payment card numbers, passwords, API keys, or credentials.
- **Verification.** Before declaring anything urgent, missing, or at-risk, it verifies the underlying data instead of pattern-matching cue words.
- **Stress test.** High-stakes recommendations (finance > $1k, health, legal) get a silent pre-mortem before delivery.
- **Sycophancy guard.** Suspicious agreement streaks get flagged.

The full rule list is in `AGENTS.md` at the repo root.

---

## Installation

### Prerequisites

- **Node.js 18 or later** — check with `node --version`
- **git**
- An AI coding tool that reads project-level instructions: Claude Code, Cursor, Antigravity, Codex, or Gemini CLI

### Steps

```bash
# 1. Get the repo. Forking is recommended — you'll have a private remote
#    you can push system-side customizations back to. Your personal data
#    stays local regardless of fork-vs-clone (it's gitignored).
git clone git@github.com:kevinkiklee/robin-assistant.git robin
cd robin

# 2. Install. The postinstall step runs setup.js, which:
#      - copies system/skeleton/* into user-data/ (your starting templates)
#      - creates artifacts/input, artifacts/output, backup/
#      - prompts for your name, timezone, email, platform, assistant name
#      - installs .git/hooks/pre-commit (the privacy guard)
#      - applies the baseline migration
npm install

# 3. Open the repo in your AI coding tool of choice. The tool reads
#    AGENTS.md directly (Cursor, Antigravity, Codex) or via a pointer
#    file (CLAUDE.md, GEMINI.md). Robin will introduce itself.
```

That's it. There is no global CLI to install. The repo is self-contained.

If you ran `npm install` in a non-interactive shell (CI, no TTY), the prompts are skipped and `user-data/robin.config.json` ships with placeholder values — open it and fill in your name/timezone/etc. before your first session.

---

## Updating

The repo *is* the workspace, so updating is just `git pull`:

```bash
git pull                    # if you cloned upstream
# or
git pull upstream main      # if you forked
```

This only touches files in `system/` and the root pointer files. **`user-data/`, `artifacts/`, `backup/`, and `docs/` are gitignored, so your personal data is never touched by an update.**

### What happens after you pull

Migrations, config upgrades, and skeleton sync run during `npm install` (via the postinstall hook), not at session start. This keeps the AI session's cold start fast — no subprocess overhead on every launch.

The postinstall hook:

1. Adds any new fields to `user-data/robin.config.json` with safe defaults (additive — never overwrites your values)
2. Applies any pending versioned migrations from `system/migrations/`, taking a `backup/pre-migration-<timestamp>.tar.gz` snapshot first
3. Copies any new skeleton files from `system/skeleton/` into `user-data/` (e.g., if upstream added a new integration template)

You'll see something like:

```
INFO: migrations: applied 0008-split-self-improvement
INFO: new files from upstream: user-data/scripts/sync-calendar.js
```

If anything goes wrong with a migration, the pre-migration backup is one command away (`npm run restore`).

### What to do if `git pull` reports a conflict



Conflicts only happen when you've modified a tracked file (anything outside the gitignored directories). If that happens:

```bash
git checkout -- <conflicting-path>     # discard local edits, accept upstream
```

Then move whatever customization you wanted into the right extension point (see [Customization](#customization) below). Tracked files are upstream-owned by design — you should never need to edit them directly.

---

## Customization

Four extension points let you customize Robin without ever editing files under `system/`. They all live in `user-data/` (gitignored), so they survive `git pull` cleanly:

- **`user-data/custom-rules.md`** — your own rules, appended to AGENTS.md's rule list. They override operational rules when they conflict, but cannot override Immutable Rules (Privacy, Verification, etc.).
  Examples: language preference, persona overrides, custom Ask-vs-Act thresholds, additional capture rules.

- **`user-data/jobs/`** — overlays `system/jobs/`. A file with the same name does a full override; or write a shallow override (`override: <name>` + only the fields you want to change) to inherit the rest from the system def. New files extend the catalog.
  Examples: customize `morning-briefing.md` to include your crypto portfolio, add a daily `rangers-news.md` job that only fires during NHL season.

- **`user-data/scripts/`** — per-user integration scripts (sync, auth, write CLIs). Templates are scaffolded from `system/skeleton/scripts/` on first install. Add a new integration by dropping a job def in `user-data/jobs/` and a script in `user-data/scripts/`, importing from `system/scripts/lib/sync/`.

- **`user-data/integrations.md`** — declare which platform integrations you've configured (email, calendar, etc.). Jobs check this before assuming a capability is available.

**Don't edit files under `system/` directly.** They're upstream-owned; the next `git pull` will conflict.

---

## Privacy

Personal data never leaves your machine unless you explicitly push it to a remote you control. Three layers enforce this:

1. **`.gitignore`** excludes `user-data/`, `artifacts/`, `backup/`, `docs/`. Source of truth.
2. **`.git/hooks/pre-commit`** (installed by `npm install`) refuses any commit that stages files in those directories or that removes `user-data/` from `.gitignore`.
3. **Privacy rules in `AGENTS.md`** prevent Robin from writing full government IDs, payment card numbers, passwords, API keys, or credentials into any memory file in the first place.

If you forked the repo: you can `git push` system-side contributions back to your fork and the upstream — `user-data/` is never staged.

---

## Commands

All operate on the cloned repo from inside it. The `robin` binary is wired up via `bin/robin.js`; running `npm install` adds it to your `PATH` (or invoke directly with `node bin/robin.js`).

| Command | Purpose |
|---------|---------|
| `git pull` | Update — pulls system file changes from upstream |
| `npm run backup` | tar.gz `user-data/` into `backup/user-data-<ISO-timestamp>.tar.gz` |
| `npm run restore` | Restore `user-data/` from a `backup/*.tar.gz` (interactive) |
| `npm run reset` | Wipe `user-data/`, recopy skeleton, re-prompt config (auto-backups first) |
| `npm test` | Run the test suite |
| `npm run lint-memory` | Check for orphan files, stale INDEX entries, oversized sub-trees, orphan .tmp files |
| `npm run measure-tokens` | Measure Tier 1/2/3 token counts. `--check` enforces budget caps, `--diff` shows delta vs baseline |
| `npm run prune-preview` | Preview what the 12-month archive prune would move (dry run) |
| `npm run prune-execute` | Run the archive prune for real (auto-backups first) |
| `robin run <name>` | Manually invoke a job — bypasses scheduler. `--force` skips gating, `--dry-run` prints the plan |
| `robin jobs list` | Show all jobs: enabled state, schedule, last run, status, next run |
| `robin jobs status <name>` | Detail on one job — when it last ran, where its log lives, when it next fires |
| `robin jobs logs <name>` | Tail the most recent run's summary (`--full` for the full log, `--list` to enumerate) |
| `robin jobs upcoming` | 7-day forward calendar of scheduled runs |
| `robin jobs enable <name>` | Turn on a disabled job (writes a shallow override under `user-data/jobs/`) |
| `robin jobs disable <name>` | Turn off an enabled job |
| `robin jobs sync` | Manually reconcile OS scheduler with `system/jobs/` + `user-data/jobs/`. Runs every 6h automatically; this just makes it instant |
| `robin jobs validate` | Parse + cron-validate every job def — useful before committing a new one |

---

## Workspace structure

```
robin/
├── AGENTS.md                <- Canonical instructions (read natively by Cursor, Antigravity, Codex)
├── CLAUDE.md                <- Pointer → AGENTS.md (Claude Code)
├── GEMINI.md                <- Pointer → AGENTS.md (Gemini CLI)
├── bin/
│   └── robin.js             <- CLI entry point (`robin run`, `robin jobs ...`)
├── system/                  <- upstream-owned, tracked, never user-edited
│   ├── startup.md
│   ├── capture-rules.md
│   ├── manifest.md
│   ├── jobs/                <- shipped jobs (agent protocols + node scripts)
│   ├── migrations/          <- versioned schema migrations applied at install
│   ├── scripts/
│   │   ├── jobs/            <- runner, reconciler, CLI dispatcher, installer adapters
│   │   ├── lib/jobs/        <- frontmatter, cron, atomic locks, state, notify
│   │   └── lib/sync/        <- shared sync infrastructure (secrets, cursor, http, redact, oauth)
│   ├── skeleton/            <- pristine first-run stubs for user-data/
│   └── tests/               <- ~290 tests
├── user-data/               <- your data, gitignored
│   ├── memory/              <- structured memory tree (INDEX, profile/, knowledge/, etc.)
│   ├── jobs/                <- your custom jobs + overrides of system jobs
│   ├── scripts/             <- per-user integration scripts (sync, auth, write CLIs)
│   ├── secrets/             <- credentials (.env) — gitignored within gitignored
│   ├── sources/             <- immutable source document archive
│   ├── state/               <- runtime state: sessions, locks, sync cursors, job logs
│   └── robin.config.json
├── artifacts/{input,output} <- file pipe, gitignored
├── backup/                  <- tar.gz archives, gitignored
└── docs/                    <- design notes, gitignored
```

---

## Supported platforms

| Tool | Pointer file at root | How it works |
|------|----------------------|---------------|
| Claude Code | `CLAUDE.md` | Pointer → `AGENTS.md` |
| Gemini CLI | `GEMINI.md` | Pointer → `AGENTS.md` |
| Cursor | (none) | Reads `AGENTS.md` natively |
| Antigravity | (none) | Reads `AGENTS.md` natively |
| Codex | (none) | Reads `AGENTS.md` natively |

Pointer files are generated from `system/scripts/lib/platforms.js`. Adding a new tool is one entry there + `npm run regenerate-pointers`.

---

## Multi-session safety

If you have Claude Code and Cursor open at the same time, both pointing at the same workspace, Robin uses file-based locks under `user-data/state/locks/` to coordinate writes. Append-only files (`journal.md`, `decisions.md`, `inbox.md`) are safe to write concurrently; topic files under `profile/` and `knowledge/` take a lock first. Stale locks (>5 min old) are auto-cleared by Dream.

---

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for the dev workflow — adding a migration, a new operation, or a new platform.

## Changelog

See [CHANGELOG.md](CHANGELOG.md).

## License

[MIT](LICENSE)
