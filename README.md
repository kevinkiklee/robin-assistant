# Robin Assistant

A personal AI assistant that remembers, learns, and improves over time — portable across AI coding tools.

Most AI tools start fresh every session. Robin gives them persistent memory, structured workflows, and a self-improvement loop, turning any supported AI coding tool into a personal assistant that gets better the more you use it.

## How it works

Robin is a **workspace** — a set of markdown files that your AI tool reads on startup. The repo *is* the workspace. When you open it in Claude Code, Cursor, Antigravity, or any supported tool, the AI reads `AGENTS.md` (or its tool-specific pointer) and becomes your personal assistant with access to everything it has learned about you.

The workspace splits cleanly into two parts:

- **`core/`** — the system. Tracked, owned by upstream, never user-edited. You get updates by running `git pull`.
- **`user-data/`** — your personal memory. Gitignored. Owned by you. Robin reads and writes here during conversations.

Plus three sibling directories at the repo root:

- **`artifacts/`** — file pipe in/out of conversations. `artifacts/input/` for files you give Robin (not auto-read), `artifacts/output/` for files Robin generates. Gitignored.
- **`backup/`** — `npm run backup` writes tar.gz archives here. Gitignored.
- **`docs/`** — internal design notes. Gitignored.

### Memory

Robin stores what it learns across structured files under `user-data/`:

| File | What it holds |
|------|---------------|
| **profile.md** | Who you are — identity, preferences, goals, routines, people |
| **knowledge.md** | Reference facts — vendors, medical info, locations, subscriptions |
| **tasks.md** | Active tasks organized by category |
| **decisions.md** | Append-only log of significant decisions and reasoning |
| **journal.md** | Dated reflections and daily notes |
| **inbox.md** | Quick capture — unclassified items routed later |
| **self-improvement.md** | Corrections, behavioral patterns, calibration log |
| **integrations.md** | Available integrations (email, calendar, etc.) |

Facts get captured silently during conversation — Robin writes them to the right file in the same turn as its response. See `core/capture-rules.md` for routing rules.

### Operations (renamed from "protocols")

Robin ships with operational workflows triggered by natural language. The catalog is auto-generated at `core/operations/INDEX.md` from each operation's frontmatter. Examples:

- Morning Briefing — "good morning", "brief me"
- Weekly Review — "weekly review"
- Email Triage — "triage my inbox"
- Meeting Prep — "prep for my meeting with..."
- Subscription Audit — "what am I paying for"
- Receipt Tracking — "track my receipts"
- System Maintenance — "clean up the workspace"
- Quarterly Self-Assessment — "how have you been doing"
- Dream — automatic daily maintenance on first session each day

### Customization

Extension points live in `user-data/`, so they survive `git pull` cleanly:

- **`user-data/custom-rules.md`** — your own rules, appended to AGENTS.md's rule list. Overrides operational rules where they conflict (Immutable Rules cannot be overridden).
- **`user-data/operations/`** — overlays `core/operations/`. Same-named file overrides the system version; new files extend the catalog.

Don't edit files under `core/` directly — `git pull` will conflict.

## Quick start

```bash
git clone <repo> robin
cd robin
npm install         # populates user-data/, prompts for config, installs the pre-commit hook
# open the repo in your AI coding tool — Robin will introduce itself
```

`npm install` runs `core/scripts/setup.js` as a postinstall step. It copies `core/skeleton/*` into `user-data/`, prompts for your name / timezone / email / platform / assistant name, and installs the privacy pre-commit hook. In CI or non-TTY contexts, prompts are skipped and you edit `user-data/robin.config.json` manually.

## Updating

```bash
git pull            # or: git pull upstream main (if you forked)
```

Touches only tracked files. `user-data/`, `artifacts/`, `backup/`, `docs/` are untouched. On the next session start, Robin auto-applies any new schema migrations and surfaces a CHANGELOG notice for whatever changed.

If `git pull` reports a conflict, you've modified a tracked file. Default recovery:

```bash
git checkout -- <conflicting-path>     # discard local edits, accept upstream
```

Move whatever customization you intended into `user-data/custom-rules.md` or `user-data/operations/`.

## Commands

All operate on the cloned repo from inside it. There is no global `robin` binary.

| Command | Description |
|---------|-------------|
| `git pull` | Update — pulls system file changes from upstream |
| `npm run backup` | Tar.gz `user-data/` into `backup/user-data-<ISO-timestamp>.tar.gz` |
| `npm run restore` | Restore `user-data/` from a `backup/*.tar.gz` (interactive) |
| `npm run reset` | Wipe `user-data/`, recopy skeleton, re-prompt config (auto-backups first) |
| `npm run install-hooks` | (Re)install the pre-commit privacy hook |
| `npm run migrate -- --dry-run` | Preview pending migrations (normally auto-applied on session start) |
| `npm run migrate-v3 -- --from <path>` | One-time migration from a v2.x workspace |

## Workspace structure

```
robin/
├── AGENTS.md                   <- Canonical instructions (read natively by Antigravity & Codex)
├── CLAUDE.md                   <- Pointer → AGENTS.md (Claude Code)
├── .cursorrules                <- Pointer → AGENTS.md (Cursor)
├── GEMINI.md                   <- Pointer → AGENTS.md (Gemini CLI)
├── .windsurfrules              <- Pointer → AGENTS.md (Windsurf)
├── core/                       <- system, tracked, never user-edited
│   ├── startup.md
│   ├── capture-rules.md
│   ├── manifest.md
│   ├── self-improvement-rules.md
│   ├── operations/             <- 13 operational workflows
│   ├── migrations/             <- versioned schema migrations
│   ├── scripts/                <- npm-run targets + lib/
│   └── skeleton/               <- pristine first-run stubs for user-data/
├── user-data/                  <- your data, gitignored
├── artifacts/{input,output}/   <- file pipe, gitignored
├── backup/                     <- tar.gz archives, gitignored
└── docs/                       <- design notes, gitignored
```

## Privacy

Personal data never leaves your machine unless you explicitly push it to a remote you control:

- **`.gitignore`** excludes `user-data/`, `artifacts/`, `backup/`, `docs/`. Source of truth.
- **Pre-commit hook** (`.git/hooks/pre-commit`, installed by `npm install`) refuses commits that stage anything under those directories or that remove `user-data/` from `.gitignore`.
- **Privacy rules** (in `AGENTS.md`) prevent Robin from storing full government IDs, payment card numbers, passwords, API keys, or credentials.

## Supported platforms

| Platform | Pointer file at root | How it works |
|----------|----------------------|---------------|
| Antigravity | (none) | Reads `AGENTS.md` natively |
| Codex | (none) | Reads `AGENTS.md` natively |
| Claude Code | `CLAUDE.md` | Pointer → `AGENTS.md` |
| Cursor | `.cursorrules` | Pointer → `AGENTS.md` |
| Gemini CLI | `GEMINI.md` | Pointer → `AGENTS.md` |
| Windsurf | `.windsurfrules` | Pointer → `AGENTS.md` |

Pointer files are generated from `core/scripts/lib/platforms.js`. Adding a new tool is one entry there + `npm run regenerate-pointers`.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for the dev workflow — how to add a migration, a new operation, or a new platform.

## Changelog

See [CHANGELOG.md](CHANGELOG.md).

## License

[MIT](LICENSE)
