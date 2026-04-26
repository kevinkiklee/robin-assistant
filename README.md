# Robin Assistant

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
npx robin-assistant init my-workspace
cd my-workspace
# Open in your AI coding tool — Robin will introduce itself
```

## Commands

| Command | Description |
|---------|-------------|
| `robin init [dir]` | Scaffold a new workspace |
| `robin configure` | Update config (name, timezone, platform, integrations) |
| `robin update` | Update system files and protocols |
| `robin rollback` | Restore from backup |
| `robin validate` | Check workspace integrity |
| `robin export` | Export user data as tar.gz |
| `robin reset` | Wipe user data to fresh templates |
| `robin migrate-v2` | One-time migration from v1 |
| `robin check-update` | Check for updates |

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
