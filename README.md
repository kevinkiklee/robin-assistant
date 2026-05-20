# Robin

> Personal AI assistant with tiered memory, async scheduling, and multi-agent collaboration via MCP.

Robin runs as a long-lived daemon that captures sessions, ingests data from your accounts (Gmail, Calendar, GitHub, Linear, Chrome, etc.), builds an entity/relation knowledge graph in SQLite, and exposes itself as MCP servers that Claude Code (and any MCP client) can talk to.

You don't habitually type `robin` commands. After `robin init`, the daemon runs in the background and Claude handles day-to-day interaction.

## Quick start

```bash
pnpm add -g robin-assistant   # or npm i -g robin-assistant
robin init --yes              # one-time setup (non-interactive)
robin mcp install             # register robin in ~/.claude.json (replaces v2 entry transparently)
```

That's it. Open Claude Code anywhere on your system; `mcp__robin__*` tools will be available.

## Requirements

- **Node 24** (pinned via `.nvmrc` — native `better-sqlite3` binding requires version match)
- **macOS or Linux** — Windows tracked but not launch-blocking
- **Apple Silicon recommended** for local model inference via Ollama; cloud-only config works on any platform
- Optional: [**Ollama**](https://ollama.com) for local models on the M-series Mac reference platform (`brew install ollama`)

## Architecture

- **Single Node daemon** owns the schedule, memory, and brain-slot dispatcher
- **SQLite + sqlite-vec** for tiered memory (events firehose, content with embeddings, entities, relations, predictions, corrections, journals)
- **Pluggable LLM providers** — Ollama, Claude Code, DeepSeek, Groq — same interface, swappable per role
- **Two MCP servers** — `robin-core` (always loaded, 13 tools) and `robin-extension` (per-project opt-in, 13 tools)
- **Capture pipeline** with v2-proven skip rules; structured-output biographer (zod-validated; v2's JSON-parse failure class is structurally prevented)
- **Cognition jobs** — biographer every 15 min, dream consolidation at 03:00 local
- **8 built-in integrations** — gmail, google_calendar, github, linear, chrome, weather, finance_quote, notify (macOS notifications)
- **Health monitor + power auto-pause** — invariants run every 60s; battery threshold auto-pauses on macOS

See `docs/specs/2026-05-18-robin-v3-design.md` for the full architectural spec.

## Day-to-day operations

Robin is designed to be invisible after install. Everything below is rare:

```bash
robin pause / resume          # pause scheduled work
robin incognito --for 1h      # disable session capture for a window
robin offline / online        # toggle outbound network
robin status                  # show current power/capture/network state
robin doctor                  # diagnostic + invariant check (also --json, --emit-runbook --write)
robin upgrade                 # apply pending schema migrations (with backup)
robin db backup/restore/vacuum  # local backup ops
robin migrate from-v2 <path>  # one-shot import from a v2 install
```

## Configuration

All user-editable configuration lives in `user-data/config/`:

- `models.yaml` — role → provider mapping (see design doc §6)
- `integrations.yaml` — which integrations enabled, secret refs, granted permissions
- `policies.yaml` — power/capture/network state, auto-policies (battery threshold, low-power-mode, quiet hours)
- `hardware.yaml` — detected hardware profile + runtime defaults (written by `robin init`)
- `profile.yaml` — user identity hints
- `secrets/.env` (mode 0600) — environment-style secret file. Also supports `secrets.age` for committed encrypted form

The `system/` directory ships **no config files** — only TypeScript code. The boundary is enforced by `tests/architecture/boundary.test.ts`.

## Development

```bash
cd robin-assistant-v3
pnpm install
ROBIN_USER_DATA_DIR=./user-data pnpm dev   # daemon in foreground
pnpm test                                   # 195 tests, ~5s
pnpm typecheck && pnpm lint
```

See `docs/STATUS.md` for the current implementation snapshot and `docs/BACKLOG.md` for deferred work organized for future contributors. `docs/companion-repo-template.md` describes the recommended `robin-personal` private-repo pattern.

## Open-source posture

- **License:** MIT
- **Reference platform:** M5 Max 64GB (Apple Silicon, MLX backend for Ollama). Other profiles degrade gracefully into smaller defaults or cloud-only mode.
- **Personal data** lives in `user-data/` (gitignored at the package level). For multi-machine sync, the recommended pattern is a private companion repo (`robin-personal`) that contains the whole `user-data/` tree minus `state/db/` (use `restic` for those — see `docs/companion-repo-template.md`).
- **Security:** report issues via GitHub private security advisories (see `SECURITY.md`).

## License

[MIT](./LICENSE)
