# Arc — A Self-Improving Personal Assistant

Arc is a self-improving personal assistant that runs on **Claude Code**. It automates memory consolidation, learns from your feedback, tracks mistakes and wins, coordinates across concurrent sessions, and keeps everything local and private. Arc lives in your `CLAUDE.md`—Claude Code reads it on startup and hands off control.

## Quick Start

```bash
npx arc-assistant init ~/my-assistant
cd ~/my-assistant
```

Open the workspace in [Claude Code](https://claude.ai/code). Arc takes it from there.

## What You Get

| Directory | Who Owns It | Purpose |
|-----------|-----------|---------|
| `core/` | Arc | Protocols, coordination scripts, rules, integrations, self-improvement framework (read-only, updated via `arc update`) |
| `user-data/` | You | Your data: todos, journal, memory, profile, skills, knowledge, decisions, inbox |
| `scripts/` | Arc | Installation and maintenance scripts |

Your data is in `user-data/`. Arc runs via hooks and Claude Code's session startup. Everything stays local.

## Key Features

- **Dream protocol** — Automatic memory consolidation when 24+ hours have passed or 5 sessions have elapsed. Lightweight, silent on quiet passes, escalates on conflicts.
- **Passive knowledge capture** — Arc learns as you talk. Stable facts → `profile/`; decisions → `decisions/`; feedback → auto-memory; todos → `todos/`.
- **Self-improvement loop** — Tracks mistakes, wins, patterns, and predictions. Calibrates over time with your feedback.
- **Multi-session safety** — Atomic locks and session registry prevent collisions when you run multiple Claude Code tabs concurrently.
- **Privacy-first** — All data stays on your machine. Pre-push git hook blocks remote pushes. Privacy scan strips sensitive data before Arc stores anything. No external logs.
- **Override system** — Customize without editing `core/`. Drop overrides in `user-data/overrides/` (e.g., `overrides/hard-rules.md` to extend rules, `overrides/session-startup.md` for custom hooks).
- **Auto-updates** — Checks once per day, asks before applying. Keeps backups. Rollback in one command.

## How It Works

Arc lives in your workspace's `CLAUDE.md`. On session startup, Claude Code reads it and loads Arc's configuration, rules, and protocols. From there:

1. **Session registration** — Arc registers your session to prevent collisions with other concurrent sessions.
2. **Dream check** — If eligible, Arc consolidates memory automatically.
3. **Passive capture** — As you work, Arc routes facts, todos, decisions, and feedback into the right files.
4. **Multi-session coordination** — Atomic locks ensure concurrent sessions don't corrupt shared state.

Your data never leaves your machine except through Claude's API for message context.

## Customization

Extend Arc without touching `core/` using the override system:

```
user-data/overrides/
├── hard-rules.md         # Extend or override Arc's rules
├── session-startup.md    # Add custom startup hooks
└── ...                   # One file per core/ module you want to customize
```

Configure Arc behavior in `user-data/arc.config.json`:

```json
{
  "user": {
    "name": "Your Name",
    "timezone": "America/New_York",
    "email": "you@example.com"
  },
  "assistant": {
    "name": "Arc"
  },
  "features": {
    "dream_enabled": true,
    "auto_update_enabled": true
  }
}
```

Update via CLI:

```bash
arc configure --name "Your Name" --timezone "America/New_York"
```

## CLI Reference

| Command | Description |
|---------|-------------|
| `arc init [directory]` | Scaffold a new Arc workspace |
| `arc configure` | Update workspace config (name, timezone, email, assistant name) |
| `arc update` | Update `core/` to the latest version |
| `arc check-update` | Check for available updates without applying |
| `arc rollback` | Restore `core/` from the most recent backup |
| `arc validate` | Check workspace integrity (all required files present) |
| `arc export` | Export all user data as a portable .tar.gz archive |
| `arc reset` | Wipe all user data in `user-data/`, keep `core/` |
| `arc version` | Show current Arc version |

## Privacy & Security

- **Local-only git** — Repository lives on your machine. No remotes. No backups to cloud.
- **Pre-push hook** — Blocks `git push` to prevent accidental exposure.
- **Privacy scan** — Before Arc stores any input, it scans for and strips: SSNs, credit card numbers, API tokens, passwords, medical record numbers.
- **No external logs** — Arc is you talking to yourself, with Claude Code. Nothing leaves your machine.

See `core/privacy-scan.md` for details on what's blocked.

## Requirements

- **Node.js 18+**
- **Claude Code** (visit [claude.ai/code](https://claude.ai/code))
- **macOS or Linux** with `bash` (coordination scripts require it)
  - **Windows users** need WSL2 with bash
- **Git** (for version control and rollback)

## License

MIT. See `LICENSE` for details.

---

**Questions?** Start with `user-data/CLAUDE.md` in your workspace—it's Arc's full operating manual. Or check the individual protocol files in `core/protocols/`.
