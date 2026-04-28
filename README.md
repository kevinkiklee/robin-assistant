# Robin Assistant

A personal AI assistant with persistent memory and a daily self-improvement loop, portable across AI coding tools.

Most AI assistants forget you the moment a session ends. Robin doesn't. Tell it your home is in Seattle on Monday; on Friday when you ask "what's a good coffee shop near home?" it just knows. Correct it twice on the same thing and it adds a permanent rule. Once a day it cleans up its own memory while you sleep. Switch from Claude Code to Cursor mid-week — same Robin, same memory.

The repo *is* the workspace. You clone it, open it in your AI tool, and Robin is alive.

---

## What Robin does

### It remembers, silently

You don't say "remember this." You just talk. Robin watches the conversation for capturable signals — facts about you, recurring contacts, durable preferences, decisions, dated reflections — and writes them to the right file in `user-data/` in the same turn it answers you. The capture rules live in `system/capture-rules.md`; you can read and tune them.

The memory is structured, not a chat log. Eight pillar files, each with a clear job:

| File | Holds |
|------|-------|
| `profile.md` | Identity, preferences, goals, routines, the people in your life |
| `knowledge.md` | Reference facts — vendors, doctors, locations, subscriptions |
| `tasks.md` | Active tasks grouped by category |
| `decisions.md` | Append-only log of significant decisions and their reasoning |
| `journal.md` | Dated reflections and daily notes |
| `inbox.md` | Quick-capture items waiting to be routed |
| `self-improvement.md` | Corrections, patterns, calibration log |
| `integrations.md` | Which integrations you've configured (email, calendar, etc.) |

### It runs operations on demand

Say "good morning" and Robin runs the Morning Briefing — calendar, weather, today's tasks, inbox highlights, anything urgent. Say "weekly review" and it pulls the week into focus. The full catalog is in `system/operations/INDEX.md`, generated automatically. A few of them:

| Trigger | What runs |
|---------|-----------|
| "good morning", "brief me" | Morning Briefing |
| "weekly review" | Weekly Review |
| "triage my inbox" | Email Triage |
| "prep for my meeting with…" | Meeting Prep |
| "what am I paying for" | Subscription Audit |
| "track my receipts" | Receipt Tracking |
| "month-end review" | Monthly Financial |
| "extract todos from this" | Todo Extraction |
| "how have you been doing" | Quarterly Self-Assessment |

Operations are just markdown files. You can override any of them or add your own under `user-data/operations/`.

### It learns from corrections

When you correct Robin — "no, I don't want X, I want Y" — it logs what went wrong and the right response. Three similar corrections promote to a named *pattern* with a recognition signal and a counter-action, so the failure mode stops happening. Over time, the corrections-to-wins ratio falls and Robin stops needing the same nudge twice.

It also tracks how confident it should be. When it makes a high-stakes recommendation it records the outcome later, and uses the running accuracy to calibrate future confidence statements.

### It maintains itself daily

The first session each day kicks off **Dream** automatically — a maintenance pass that routes your inbox, promotes durable facts from the journal, prunes finished tasks, retires stale knowledge, promotes recurring corrections to patterns, retires patterns that stopped firing, and updates calibration. You don't run it. You don't see most of it. You just notice that the workspace stays tidy without effort.

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
- An AI coding tool that reads project-level instructions: Claude Code, Cursor, Antigravity, Codex, Windsurf, or Gemini CLI

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

# 3. Open the repo in your AI coding tool of choice. The tool reads the
#    appropriate pointer file at the root (CLAUDE.md, .cursorrules, etc.)
#    which redirects to AGENTS.md. Robin will introduce itself.
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

### What you'll see on the next session start

When you open the repo in your AI tool after pulling, Robin runs `system/scripts/startup-check.js` automatically. It:

1. Adds any new fields to `user-data/robin.config.json` with safe defaults (additive config migration — never overwrites your values)
2. Applies any pending versioned migrations from `system/migrations/`, taking a `backup/pre-migration-<timestamp>.tar.gz` snapshot first
3. Copies any new skeleton files from `system/skeleton/` into `user-data/` (e.g., if upstream added a new pillar file)
4. Surfaces the latest `CHANGELOG.md` entry as a one-line notice — once, not every session

You'll see something like:

```
INFO: migrations: applied 0007-rename-knowledge-to-reference
INFO: new files from upstream: user-data/health.md
INFO: CHANGELOG: ## [3.1.0] - 2026-05-15
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

Three extension points let you customize Robin without ever editing files under `system/`. They all live in `user-data/` (gitignored), so they survive `git pull` cleanly:

- **`user-data/custom-rules.md`** — your own rules, appended to AGENTS.md's rule list. They override operational rules when they conflict, but cannot override Immutable Rules (Privacy, Verification, etc.).
  Examples: language preference, persona overrides, custom Ask-vs-Act thresholds, additional capture rules.

- **`user-data/operations/`** — overlays `system/operations/`. A file with the same name overrides the system version; new files extend the catalog.
  Examples: customize `morning-briefing.md` to include your crypto portfolio, add an `investment-review.md` operation.

- **`user-data/integrations.md`** — declare which platform integrations you've configured (email, calendar, etc.). Operations check this before assuming a capability is available.

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

All operate on the cloned repo from inside it. There is no global `robin` binary.

| Command | Purpose |
|---------|---------|
| `git pull` | Update — pulls system file changes from upstream |
| `npm run backup` | tar.gz `user-data/` into `backup/user-data-<ISO-timestamp>.tar.gz` |
| `npm run restore` | Restore `user-data/` from a `backup/*.tar.gz` (interactive) |
| `npm run reset` | Wipe `user-data/`, recopy skeleton, re-prompt config (auto-backups first) |
| `npm test` | Run the test suite |

---

## Workspace structure

```
robin/
├── AGENTS.md                <- Canonical instructions (read natively by Antigravity & Codex)
├── CLAUDE.md                <- Pointer → AGENTS.md (Claude Code)
├── .cursorrules             <- Pointer → AGENTS.md (Cursor)
├── GEMINI.md                <- Pointer → AGENTS.md (Gemini CLI)
├── .windsurfrules           <- Pointer → AGENTS.md (Windsurf)
├── system/                  <- upstream-owned, tracked, never user-edited
│   ├── startup.md
│   ├── capture-rules.md
│   ├── manifest.md
│   ├── self-improvement-rules.md
│   ├── operations/          <- 13 operational workflows + auto-generated INDEX.md
│   ├── migrations/          <- versioned schema migrations applied on session start
│   ├── scripts/             <- npm-run targets + lib/
│   ├── skeleton/            <- pristine first-run stubs for user-data/
│   └── tests/               <- 98 tests
├── user-data/               <- your data, gitignored
├── artifacts/{input,output} <- file pipe, gitignored
├── backup/                  <- tar.gz archives, gitignored
└── docs/                    <- design notes, gitignored
```

---

## Supported platforms

| Tool | Pointer file at root | How it works |
|------|----------------------|---------------|
| Antigravity | (none) | Reads `AGENTS.md` natively |
| Codex | (none) | Reads `AGENTS.md` natively |
| Claude Code | `CLAUDE.md` | Pointer → `AGENTS.md` |
| Cursor | `.cursorrules` | Pointer → `AGENTS.md` |
| Gemini CLI | `GEMINI.md` | Pointer → `AGENTS.md` |
| Windsurf | `.windsurfrules` | Pointer → `AGENTS.md` |

Pointer files are generated from `system/scripts/lib/platforms.js`. Adding a new tool is one entry there + `npm run regenerate-pointers`.

---

## Multi-session safety

If you have Claude Code and Cursor open at the same time, both pointing at the same workspace, Robin uses file-based locks under `user-data/state/locks/` to coordinate writes to pillar files. Append-only files (`journal.md`, `decisions.md`, `inbox.md`) are safe to write concurrently; pillars (`profile.md`, etc.) take a lock first. Stale locks (>5 min old) are auto-cleared by Dream.

---

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for the dev workflow — adding a migration, a new operation, or a new platform.

## Changelog

See [CHANGELOG.md](CHANGELOG.md).

## License

[MIT](LICENSE)
