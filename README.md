# Robin

> Local-first personal AI assistant with long-term memory, background integrations, and a skills system — driven by Claude Code via MCP.

Robin is a daemon that runs on your machine. It captures your Claude Code sessions, pulls data from your accounts (Gmail, Calendar, GitHub, Linear, Spotify, and more), builds an entity–relation knowledge graph in SQLite, and exposes everything as MCP servers that Claude Code talks to. After setup, Robin works in the background — you don't type `robin` commands; Claude does the driving through MCP, and Robin remembers across sessions.

## Quick start

```bash
nvm use 24                       # Node 24 required (.nvmrc)
pnpm add -g robin-assistant      # or: npm i -g robin-assistant
robin init --yes                 # one-time setup
robin daemon install             # launchd agent — auto-starts on login (macOS)
```

Open Claude Code anywhere on your machine. Robin's MCP tools (`mcp__robin__*`) are available automatically.

## Requirements

| Requirement | Notes |
|---|---|
| **Node 24** | Pinned via `.nvmrc`. `better-sqlite3` is a native binding; the ABI must match. |
| **macOS or Linux** | `robin daemon install` is launchd (macOS). On Linux, run the daemon under systemd/runit/etc. |
| **Ollama** (optional) | For local model inference. Default embedding model: `qwen3-embedding:8b`. Install via `brew install ollama` or [ollama.com](https://ollama.com). |

Apple Silicon recommended for local inference. Cloud-only configs work on any platform.

## How it works

Robin has three layers:

```
system/        Framework: kernel (daemon + scheduler), brain (memory + cognition),
               integrations runtime, surfaces (CLI, HTTP, MCP), skills
user-data/     Per-user instance: memory, secrets, extensions, knowledge files (gitignored)
dist/          Compiled output (gitignored); pnpm build to regenerate
```

The **daemon** owns the schedule, the health monitor, and the integration lifecycle. It runs cognition jobs in the background — extracting entities from your conversations (biographer), embedding content for vector search, and writing a daily journal (dream). A power-auto system pauses on battery and respects quiet hours.

**Memory** is tiered: an event firehose, FTS5 full-text search, 4096-dim vector embeddings (Matryoshka), an entity/relation graph, topic-keyed beliefs, predictions with Brier calibration, and corrections. Everything lives in a single SQLite database (`user-data/state/db/robin.sqlite`) backed by `sqlite-vec`.

**LLM dispatch** is role-based: `reasoning`, `summarize`, `embed` — each mapped to a provider + model in `user-data/config/models.yaml`. Default provider is Ollama (local). A dormant DeepSeek provider exists for cloud fallback.

For the full architectural deep dive, see [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

## MCP servers

Robin exposes two MCP servers (stdio transport, configured via `.mcp.json`):

**robin-core** — memory + cognition:
`recall`, `remember`, `believe`, `recall_belief`, `find_entity`, `get`, `list`, `predict`, `record_correction`, `audit`, `explain`, `health`, `metrics`, `journal`, `power`, `skill`

**robin-extension** — integrations + actions:
`gmail`, `google_calendar`, `github`, `linear`, `chrome`, `finance`, `spotify_write`, `run`, `integration_status`, `ingest`, `related_entities`, `resolve_prediction`, `check_action`, `update`

Copy `.mcp.json.example` to `.mcp.json` and adjust paths to set up.

## Skills

Robin has a skills system for reusable, named methodologies. A skill is a directory with a `SKILL.md` (plus optional reference files or scripts). Robin serves the skill content via the `skill` MCP tool — it never executes anything; Claude Code reads and runs bundled scripts itself.

Skills live in two places:
- **System skills** (`system/skills/builtin/`) — ship with the package.
- **User skills** (`user-data/extensions/skills/`) — personal, gitignored. A user skill with the same name shadows a system skill.

Shipped system skills: `skill-authoring`, `memory-curation`, `web-research`.

To create a skill: `skill({ name: "skill-authoring" })` and follow the instructions.

## Extensions

**Integrations** (`user-data/extensions/integrations/<name>/`) connect Robin to external data sources. Each has an `integration.yaml` manifest and an `index.ts` with a `tick()` function. The daemon runs them on a cron schedule. 9 integrations ship built-in; user extensions are loaded identically.

**Jobs** (`user-data/extensions/jobs/<name>/`) handle cognitive work that doesn't fit the read-tick model (e.g. the daily brief). Each has a `job.yaml` manifest and a `run(ctx)` method. The daemon's file watcher hot-reloads both integrations and jobs on change.

See `user-data/extensions/AUTHORING.md` for the extension contract.

## CLI

Robin is designed to be invisible after install. These commands are rare:

| Command | What it does |
|---|---|
| `robin status` | Power, capture, and network state |
| `robin pause` / `resume` | Pause or resume scheduled work |
| `robin incognito --for 1h` | Disable session capture temporarily |
| `robin offline` / `online` | Toggle outbound network |
| `robin doctor` | Diagnostic + invariant check |
| `robin integrations` | List integrations and their health |
| `robin reauth <name>` | Re-run OAuth for an integration |
| `robin reindex` | Backfill embeddings |
| `robin db backup` / `restore` / `vacuum` | Database maintenance |
| `robin upgrade` | Apply pending schema migrations |
| `robin publish --source <file>` | Publish markdown to the web |
| `robin daemon install` / `uninstall` | Manage the launchd agent |

For the `robin publish` workflow details, see [`docs/PUBLISHING.md`](docs/PUBLISHING.md).

## Configuration

All user-editable config lives in `user-data/config/`:

- `models.yaml` — LLM role → provider + model mapping
- `policies.yaml` — power/capture/network state, auto-policies (battery threshold, quiet hours)
- `hardware.yaml` — detected hardware profile (written by `robin init`)
- `secrets/.env` — environment-style secrets (mode 0600); loaded by the daemon at startup

The `system/` directory ships no config files — only TypeScript code.

## Development

```bash
cd robin-assistant
nvm use                                     # Node 24 via .nvmrc
pnpm install
ROBIN_USER_DATA_DIR=./user-data pnpm dev    # daemon in foreground
pnpm test                                   # ~413 tests
pnpm typecheck && pnpm lint                 # tsc --noEmit + biome
```

Before contributing, read:
1. [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — how Robin is built
2. [`docs/STATUS.md`](docs/STATUS.md) — current implementation snapshot
3. [`docs/BACKLOG.md`](docs/BACKLOG.md) — deferred work
4. [`docs/CONTRIBUTING.md`](docs/CONTRIBUTING.md) — workflow, code style, CI

## Open-source posture

- **License:** MIT
- **Reference platform:** M5 Max 64 GB (Apple Silicon, Ollama). Other hardware degrades into smaller models or cloud-only mode.
- **Personal data** lives in `user-data/` (gitignored). For multi-machine sync, use a private companion repo containing `user-data/` minus `state/db/`.
- **Security:** report issues via GitHub private security advisories (see [`docs/SECURITY.md`](docs/SECURITY.md)).

## License

[MIT](./LICENSE)
