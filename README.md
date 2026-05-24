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

## Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                        Claude Code (MCP client)                     │
│              ┌──────────────┐          ┌───────────────┐            │
│              │  robin-core  │          │robin-extension│            │
│              │  (16 tools)  │          │  (14 tools)   │            │
│              └──────┬───────┘          └───────┬───────┘            │
└─────────────────────┼──────────────────────────┼────────────────────┘
                      │          stdio           │
┌─────────────────────┼──────────────────────────┼────────────────────┐
│                     ▼          DAEMON          ▼                    │
│  ┌─────────────────────────────────────────────────────────────┐    │
│  │                      SCHEDULER                              │    │
│  │  tick loop (1s) → claim job → run handler → re-arm cron     │    │
│  │  lease TTL (5m) · reaper (60s) · withTimeout (120s/handler) │    │
│  └───────┬────────────────┬───────────────────┬────────────────┘    │
│          │                │                   │                     │
│  ┌───────▼──────┐ ┌──────▼───────┐  ┌────────▼────────┐           │
│  │  COGNITION   │ │ INTEGRATIONS │  │     JOBS         │           │
│  │              │ │              │  │                   │           │
│  │ biographer   │ │ gmail        │  │ daily-brief       │           │
│  │ embed-backfill│ │ calendar     │  │ (user-defined)    │           │
│  │ dream        │ │ github, etc  │  │                   │           │
│  └───────┬──────┘ └──────┬───────┘  └────────┬────────┘           │
│          │               │                    │                     │
│  ┌───────▼───────────────▼────────────────────▼────────────────┐   │
│  │                       BRAIN                                  │   │
│  │                                                              │   │
│  │  Memory         LLM Dispatch        Entity Graph             │   │
│  │  ┌───────────┐  ┌─────────────┐     ┌──────────────────┐    │   │
│  │  │ events    │  │ reasoning   │     │ entities         │    │   │
│  │  │ FTS5      │  │ summarize   │     │ relations        │    │   │
│  │  │ vec 4096d │  │ embed       │     │ biographer       │    │   │
│  │  │ beliefs   │  │   ↓         │     │ disambiguation   │    │   │
│  │  │ predictions│  │ Ollama/cloud│     └──────────────────┘    │   │
│  │  │ corrections│  └─────────────┘                              │   │
│  │  └───────────┘                                                │   │
│  │           ↕                                                   │   │
│  │    SQLite + sqlite-vec (single file, WAL mode)                │   │
│  └───────────────────────────────────────────────────────────────┘   │
│                                                                      │
│  ┌──────────────────┐  ┌──────────────┐  ┌──────────────────────┐   │
│  │  Health Monitor   │  │ Power Auto   │  │ HTTP (hooks, health) │   │
│  │  invariants (60s) │  │ battery/quiet│  │ :41273               │   │
│  │  30m CRIT → exit  │  │ pause/resume │  │ session capture      │   │
│  └──────────────────┘  └──────────────┘  └──────────────────────┘   │
└──────────────────────────────────────────────────────────────────────┘
```

### Three layers

```
system/        Framework: kernel (daemon + scheduler), brain (memory + cognition),
               integrations runtime, surfaces (CLI, HTTP, MCP), skills
user-data/     Per-user instance: memory, secrets, extensions, knowledge files (gitignored)
dist/          Compiled output (gitignored); pnpm build to regenerate
```

### The daemon

A single Node.js process, supervised by launchd (macOS). It owns the scheduler, health monitor, integration lifecycle, and HTTP hook receiver. On startup it loads secrets from `user-data/config/secrets/.env`, applies migrations, wires integrations into cron jobs, and starts the tick loop.

The **scheduler** claims one pending job per tick (1s interval), runs the handler inside a 120s timeout, and re-arms cron jobs on completion — even on failure, so transient errors can't permanently silence a schedule. A 60s lease reaper recovers jobs abandoned by crashed handlers. If the tick loop itself hangs (handler blocks past the timeout), the health monitor escalates through a 30-minute sustained-CRITICAL gate and then `exit(1)`s for launchd respawn.

### Memory

All memory lives in a single SQLite file (`robin.sqlite`) with `sqlite-vec` for vector search:

| Layer | What it stores |
|---|---|
| **Events** | Append-only firehose — every captured session, integration tick, belief-update, prediction, daily briefing |
| **FTS5** | Full-text search index over event content bodies |
| **Vector (4096-dim)** | Matryoshka embeddings via `qwen3-embedding:8b`, deferred from the ingest hot-path into a batch job |
| **Entity graph** | ~5000+ entities (person, place, tool, service) and ~14000+ relations, extracted by the biographer |
| **Beliefs** | Topic-keyed claims with auto-supersession — queryable current truth via `recall_belief` |
| **Predictions** | Confidence-calibrated forecasts with Brier scoring, resolved by the dream job |
| **Corrections** | What Robin said wrong + the correction — feeds the self-learning loop |

**Recall** is hybrid: lexical (FTS5) + vector (cosine similarity) + entity-graph traversal, with mode selection (`lex`, `vec`, `hybrid`). When the embedder is unavailable, recall degrades to FTS5-only rather than failing.

### Cognition

Three background jobs run on cron schedules:

- **Biographer** — extracts entities and relations from captured Claude Code sessions. Multi-tick: chunks sessions at 10k chars, processes ≤10 chunks per tick, and persists progress so sessions resume across cron fires. A circuit breaker aborts without advancing the cursor when the LLM is unreachable, preventing empty-marker corruption.
- **Embed-backfill** — deferred embedding of new content rows. Runs every minute, single-flight against Ollama.
- **Dream** — nightly at 03:00: resolves overdue predictions, rolls up daily metrics, generates a narrative journal entry.

### LLM dispatch

Role-based routing defined in `user-data/config/models.yaml`:

```yaml
roles:
  embed:     { provider: ollama, model: qwen3-embedding:8b }
  reasoning: { provider: ollama, model: qwen3.5:35b-a3b }
  summarize: { provider: ollama, model: qwen3.5:35b-a3b }
```

Every call is wrapped in `withTimeout` (default 5 min, overridable per-call). Providers are registered at startup with `lenient: true` — missing secrets produce a warning, not a crash.

### Capture pipeline

A Claude Code hook (`~/.claude/settings.json`, installed via `robin hooks install`) POSTs session transcripts to the daemon's HTTP server on session end. The daemon projects the JSONL into turns, applies skip rules (short sessions, out-of-scope CWD), deduplicates by content hash, and writes a `session.captured` event. The biographer picks these up on its next cron tick.

For the full deep dive — database schema, integration contract, scheduler internals, and all invariants — see [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

### Integrations

Integrations connect Robin to external data sources. Each is a directory with an `integration.yaml` manifest and an `index.ts` exporting a `tick()` function. The daemon runs them on their cron schedule — every 15 minutes for Gmail, every 30 for Calendar, every 12 hours for eBird, etc.

An integration tick pulls data from an API, normalizes it, and calls `ingest()` to write events into the database. The ingest path handles content-hash dedup, so a tick that returns the same data twice doesn't create duplicate events. Each tick records a heartbeat (`last_attempt_at`, `last_ingest_count`, `consecutive_errors`) that the health monitor and the daily brief read to detect degradation.

**9 ship built-in** (Gmail, Calendar, GitHub, Linear, Chrome history, weather, finance quotes, Claude Code session capture, notifications). **User extensions** live in `user-data/extensions/integrations/` and are loaded identically — the daemon's file watcher hot-reloads them on change, no restart required.

OAuth integrations (Gmail, Calendar) rotate tokens on Google's 7-day testing-mode cycle. `robin reauth <name>` opens a one-shot local OAuth flow: browser consent → localhost callback → new refresh token written to `.env` → daemon bounced.

### Skills

Skills are reusable, named methodologies — a directory with a `SKILL.md` (plus optional reference files). Robin serves skill content via the `skill` MCP tool; it never executes anything — the MCP client (Claude Code) reads and runs bundled scripts itself.

- **System skills** (`system/skills/builtin/`) ship with the package.
- **User skills** (`user-data/extensions/skills/`) are personal, gitignored. A user skill with the same name shadows a system skill.

### MCP servers

Robin exposes two MCP servers (stdio transport, configured via `.mcp.json`):

| Server | Tools | Purpose |
|---|---|---|
| **robin-core** | `recall`, `remember`, `believe`, `recall_belief`, `find_entity`, `get`, `list`, `predict`, `record_correction`, `audit`, `explain`, `health`, `metrics`, `journal`, `power`, `skill` | Memory, cognition, and self-model |
| **robin-extension** | `gmail`, `google_calendar`, `github`, `linear`, `chrome`, `finance`, `spotify_write`, `run`, `integration_status`, `ingest`, `related_entities`, `resolve_prediction`, `check_action`, `update` | Integration actions + daemon control |

Copy `.mcp.json.example` to `.mcp.json` and adjust paths to connect.

### The self-learning loop

Robin improves over time through three feedback mechanisms:

1. **Corrections** — when Robin says something wrong, `record_correction` logs the error and the fix. The biographer's prompt includes recent corrections as few-shot examples, so the same mistake tends not to recur.
2. **Beliefs** — `believe` persists a topic-keyed claim that auto-supersedes the prior belief for that topic. `recall_belief` returns current truth without embedding search. Wrong predictions fold into belief-updates as retractions.
3. **Predictions** — `predict` logs a confidence-calibrated forecast with a deadline. The dream job resolves overdue predictions and computes Brier scores for calibration tracking.

### Configuration

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
