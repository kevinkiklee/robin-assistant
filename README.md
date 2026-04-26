# Robin Assistant

A personal AI assistant that remembers, learns, and improves over time — portable across AI coding tools.

Most AI tools start fresh every session. Robin gives them persistent memory, structured workflows, and a self-improvement loop, turning any supported AI coding tool into a personal assistant that gets better the more you use it.

## How It Works

Robin is a **workspace** — a set of markdown files that your AI tool reads on startup. The CLI scaffolds and maintains this workspace. When you open it in Claude Code, Cursor, or any supported tool, the AI reads Robin's instruction file and becomes your personal assistant with access to everything it has learned about you.

### Memory

Robin stores what it learns across eight structured files:

| File | What it holds |
|------|---------------|
| **profile.md** | Who you are — identity, preferences, goals, routines, people |
| **knowledge.md** | Reference facts — vendors, medical info, locations, subscriptions |
| **tasks.md** | Active tasks organized by category |
| **decisions.md** | Append-only log of significant decisions and reasoning |
| **journal.md** | Dated reflections and daily notes |
| **inbox.md** | Quick capture — unclassified items routed later |
| **self-improvement.md** | Corrections, behavioral patterns, session handoff notes |
| **integrations.md** | Available capabilities (email, calendar, etc.) |

Facts are captured **silently during conversation** — Robin writes them to the right file in the same turn as its response, without announcing it. A set of capture rules decides what's worth remembering and where it goes.

### Self-Improvement

Robin tracks its own mistakes and learns from them:

1. **Corrections** — when you correct Robin, it logs what went wrong and what to do instead
2. **Patterns** — corrections that recur get promoted to named patterns with recognition signals and counter-actions
3. **Calibration** — Robin tracks its prediction accuracy (confidence vs. actual outcomes)
4. **Quarterly Self-Assessment** — audits effectiveness, calibration drift, and sycophancy

### Dream Protocol

Once per day, Robin runs an automatic maintenance pass called **Dream** that handles both memory management and self-improvement:

- **Memory**: routes inbox items, promotes durable facts from the journal, prunes old tasks, flags stale profile/knowledge entries
- **Self-improvement**: promotes recurring corrections into behavioral patterns, reviews whether existing patterns are working, updates calibration accuracy, checks for sycophancy signals, cleans up session handoff notes

This happens automatically at the start of the first session each day — no user action required.

### Protocols

Robin ships with 13 operational workflows triggered by natural language:

| Protocol | Trigger examples |
|----------|-----------------|
| Morning Briefing | "good morning", "brief me" |
| Weekly Review | "weekly review" |
| Email Triage | "triage my inbox" |
| Meeting Prep | "prep for my meeting with..." |
| Monthly Financial | "month-end review" |
| Subscription Audit | "what am I paying for" |
| Receipt Tracking | "track my receipts" |
| Todo Extraction | "extract todos from this" |
| System Maintenance | "clean up the workspace" |
| Dream | Automatic on session start |
| Multi-Session Coordination | Automatic on session start |
| Quarterly Self-Assessment | "how have you been doing" |

### Multi-Session Safety

Multiple sessions (e.g., Claude Code + Cursor open at the same time) are handled via file-based locking. Pillar files require locks before editing; append-only files like the journal and decision log are safe to write concurrently.

## Supported Platforms

| Platform | Pointer file |
|----------|-------------|
| Claude Code | `CLAUDE.md` |
| Cursor | `.cursorrules` |
| Gemini CLI | `GEMINI.md` |
| Windsurf | `.windsurfrules` |
| Codex | — |
| Antigravity | — |

Each platform gets a pointer file that redirects to the shared `AGENTS.md` instruction file, so the same workspace works everywhere.

## Quick Start

```bash
npx robin-assistant init my-workspace
cd my-workspace
# Open in your AI coding tool — Robin will introduce itself
```

The init command scaffolds the workspace, creates the config file, sets up a pre-push git hook (to keep your data local), and generates the appropriate pointer file for your platform.

## Commands

| Command | Description |
|---------|-------------|
| `robin init [dir]` | Scaffold a new workspace |
| `robin configure` | Update config (name, timezone, platform, integrations) |
| `robin update` | Update system files and protocols (backs up previous versions) |
| `robin rollback` | Restore from the most recent backup |
| `robin validate` | Check workspace integrity |
| `robin export` | Export all user data as tar.gz |
| `robin reset` | Wipe user data to fresh templates |
| `robin migrate-v2` | One-time migration from v1 layout |
| `robin check-update` | Check for available updates |

## Workspace Structure

```
workspace/
  AGENTS.md              <- Core instruction file (how Robin behaves)
  robin.config.json      <- User settings, platform, integrations
  profile.md             <- About the user (built up over time)
  tasks.md               <- Active tasks by category
  knowledge.md           <- Reference facts (vendors, medical, etc.)
  decisions.md           <- Decision log (append-only)
  journal.md             <- Reflections and daily notes (append-only)
  self-improvement.md    <- Corrections, patterns, calibration
  inbox.md               <- Quick capture (routed by Dream)
  integrations.md        <- Available platform capabilities
  capture-rules.md       <- How facts get routed to files
  protocols/             <- Operational workflows (13 protocols)
  state/                 <- Session registry, dream state, locks
  trips/                 <- Trip planning files (auto-created)
```

## Privacy

Robin workspaces contain personal information and are **local-only by default**:

- A pre-push git hook blocks all pushes to remote repositories
- All data stays on your machine
- Privacy rules are immutable — Robin will never store full government IDs, payment card numbers, passwords, API keys, or credentials
- High-stakes facts (financial, medical, legal) require user confirmation before storage

## Hard Rules

Robin enforces behavioral rules that cannot be overridden:

- **Privacy** — blocks storage of sensitive data (SSNs, card numbers, credentials)
- **Verification** — verifies before declaring something urgent, missing, or at-risk
- **Ask vs. Act** — acts on reversible low-stakes changes, asks before irreversible or high-impact ones
- **Disagree** — surfaces disagreements with established data before complying
- **Stress Test** — runs pre-mortems on high-stakes recommendations
- **Sycophancy** — flags suspicious agreement patterns and zero-disagreement streaks

## License

[MIT](LICENSE)
