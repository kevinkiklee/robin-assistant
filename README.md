# Arc Assistant

A self-improving personal assistant — portable across AI coding tools.

## Supported Platforms

- Claude Code
- Cursor
- Gemini CLI
- Codex
- Windsurf
- Antigravity

## Quick Start

```bash
npx arc-assistant init my-workspace
cd my-workspace
# Open in your AI coding tool — Arc will introduce itself
```

## Commands

| Command | Description |
|---------|-------------|
| `arc init [dir]` | Scaffold a new workspace |
| `arc configure` | Update config (name, timezone, platform, integrations) |
| `arc update` | Update system files and protocols |
| `arc rollback` | Restore from backup |
| `arc validate` | Check workspace integrity |
| `arc export` | Export user data as tar.gz |
| `arc reset` | Wipe user data to fresh templates |
| `arc migrate-v2` | One-time migration from v1 |
| `arc check-update` | Check for updates |

## Workspace Structure

```
workspace/
  AGENTS.md              <- AI instruction file
  profile.md             <- About the user
  tasks.md               <- Active tasks
  knowledge.md           <- Reference facts
  decisions.md           <- Decision log
  journal.md             <- Reflections
  self-improvement.md    <- Corrections, patterns, handoff
  inbox.md               <- Quick capture
  protocols/             <- Operational workflows
  state/                 <- Session registry, locks
  integrations.md        <- Available capabilities
```

## Privacy

This workspace may contain personal information. It is **local-only by default**:
- A pre-push git hook blocks all pushes to remote repositories
- All data stays on your machine
