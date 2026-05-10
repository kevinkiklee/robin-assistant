# robin-assistant v6 (alpha)

A personal AI memory layer for Claude Code and Gemini CLI, backed by an embedded multi-model database. Robin captures what you talk about, links it into a graph, consolidates it nightly, and serves it back through MCP — so the next session knows what the last one knew.

This is the SurrealDB-first rebuild of Robin. v1 (`robin-assistant@5.x`) remains daily-use Robin until cutover is comfortable; the migrator + safety floor shipped in alpha 8b/9.

## Status

`6.0.0-alpha.9` — Phase 4a (daily-use safety floor: bash policy, PII guard inside MCP, tamper detection, auto-recall on prompt, multi-session registry, pre-commit hook, host-side hook installation).

See [`CHANGELOG.md`](CHANGELOG.md) for the per-phase delta and the design docs under [`docs/superpowers/specs/`](docs/superpowers/specs/) for architecture rationale.

## How Robin works

### The big picture

```
Claude Code / Gemini CLI session
   │
   ├─ SessionStart hook ────────────► registers session + tamper warnings
   ├─ UserPromptSubmit hook ────────► auto-recall: injects relevant memory
   ├─ PreToolUse(Bash) hook ────────► bash policy: refuses risky commands
   ├─ MCP tool calls (SSE) ─────────► recall, remember, find_entity, etc.
   └─ Stop hook ────────────────────► biographer processes new events
       │
       ▼
   robin-mcp daemon  (single owner of the embedded DB)
       ├─ Capture        recordEvent → embed → events table
       │                 (HNSW vector index — dim depends on embedder profile)
       │                 + inbound PII guard refuses credential-shaped writes
       ├─ Recall         HNSW kNN + recency window + source/trust filters
       ├─ Biographer     1 LLM call per event → entities, edges, episodes
       ├─ Dream          nightly 5-step batch → knowledge / patterns /
       │                 profile / threads / rule candidates
       ├─ Heartbeat      60s tick: integration syncs, biographer queue,
       │                 stale-session sweeper
       ├─ Outbound       PII / secret / verbatim-quote guards + sliding-1h
       │                 rate limiter (default 10/hr)
       ├─ Self-improve   corrections → 30-day cluster → rule candidates →
       │                 user approval → DB-backed rules surfaced to agents
       └─ Safety floor   manifest-baseline tamper check at boot;
                         multi-session registry; refusals audit table
       │
       ▼
   Embedded SurrealDB v3   (rocksdb:// at <package_root>/user-data/db/)
       events · entities · episodes · 6 edge tables ·
       knowledge · patterns · profile · threads ·
       rule_candidates · rules · recall_events · runtime_* (sessions,
       tamper_state, auto_recall_telemetry, scheduler, embedder)
```

### Why it's shaped this way

- **Single write primitive.** Every capture — CLI, sync integration, Discord, manual `remember` — lands as a row in the `events` table. Content-hash dedupe; embeddings cached on hash; PII guard runs at the entry point.
- **Schema is the source of truth.** Hand-written `.surql` migrations under `src/schema/migrations/` (currently 0001–0010), applied by a v3-aware runner with a pre-migration tar backup.
- **The daemon owns the DB.** Embedded RocksDB is single-process. The `robin-mcp` daemon is the only writer; CLI commands route through it when running, otherwise take a cooperative file lock.
- **Multi-host, no direct API calls.** The biographer and dream pipelines invoke the LLM through your host's CLI subprocess (Claude Code or Gemini CLI), with `cache_control` annotations on cacheable layers. No Anthropic / Google API key required for memory operations.
- **Three integration kinds:**
  - `sync` — heartbeat-driven pulls (gmail, calendar, drive, youtube, lunch_money, weather, ebird, nhl, linear, whoop, ga, chrome, lrc, github, spotify, letterboxd)
  - `gateway` — long-lived in-process (discord)
  - `tool-only` — write surfaces invoked by the agent (github_write, spotify_write)
- **Safety floor (alpha.9):** host-side hooks installed into `~/.claude/settings.json` (Bash policy, auto-recall on prompt, session-start registry, biographer Stop hook) plus an in-MCP PII guard on every memory write, daemon-boot tamper check, and a standalone pre-commit privacy hook for personal repos.

### A typical agent turn

1. **SessionStart hook** registers the session in `runtime_sessions` (with `transcript_path` so other hooks can read prior turns). If a previous tamper check found drift, the warnings surface in stderr at session start.
2. **You type a message.** UserPromptSubmit hook reads the last 8 KB of the transcript, extracts the previous assistant message, POSTs `{query, prior_assistant, k:6, recency_days:30}` to the daemon's `/internal/auto-recall`. The daemon runs the recall pipeline and returns a `<!-- relevant memory -->` block formatted under a 1500-token budget. The host injects it into the model's context. Fail-soft on every error.
3. **The agent reads its instructions** in `~/.claude/CLAUDE.md` (and the regenerable `<!-- robin -->` block inside it), calls `recall` / `find_entity` / `gmail_search` / etc. via MCP over SSE.
4. **If the agent runs Bash**, the PreToolUse hook checks the command against 7 deny rules (secrets-read, env-dump, destructive-rm, low-level-fs, git-expose-userdata, eval-injection, db-direct-access). Match → exit 2, command refused. Static — no daemon round-trip.
5. **If the agent calls `remember` / `record_correction`**, the in-MCP PII guard checks the content against credential / secret / private-key / JWT / password-assignment patterns. Match → refused, logged to `outbound_refusals(direction='inbound')`, agent sees a structured error.
6. **Stop hook** spawns a detached `robin biographer process-pending` subprocess. The biographer reads new events, makes one LLM call per event through `host.invokeLLM`, and UPSERTs entities + edges + episodes.
7. **Heartbeat** ticks every 60s — runs due integration syncs, drains the biographer queue, marks stale sessions, advances quiet-window cursors.
8. **Nightly at 4 AM** (`process.env.TZ`), Dream runs the 5-step pipeline and produces knowledge / patterns / profile / threads / rule candidates. Corrections that cluster (cosine ≥ 0.85, min 3, 30-day window) become `rule_candidates`.
9. **You approve or reject candidates** with `robin rules approve <id>` (or via the `update_rule` MCP tool). Approved rules surface in CLAUDE.md/GEMINI.md on the next session.

## Installation

### Prerequisites

- **Node.js ≥ 22**
- **macOS** (launchd) or **Linux** (systemd user services). Windows daemon supervision is not yet supported.
- **Claude Code** and/or **Gemini CLI** on PATH for auto-registration.
- Provider credentials for whatever integrations you want (Google OAuth, Spotify, Linear API key, etc.) — set later, not at install time.

### Step 1 — Clone and install dependencies

```sh
git clone git@github.com:kevinkiklee/robin-assistant.git robin-v2
cd robin-v2
npm install
```

### Step 2 — Run `robin install`

One command sets up everything Robin needs.

```sh
node bin/robin install
```

Interactively prompts for an embedder profile:

| Profile | Cost | Tradeoff |
|---|---|---|
| `mxbai-1024` *(default)* | Free, ~1.3 GB local model | In-process, no external dependency. Recommended unless you have a reason. |
| `qwen3-4096` | Free, ~16 GB local model | Best retrieval quality. Requires Ollama running and `qwen3-embedding:8b` pulled. |
| `gemini-3072` | Google AI Studio API | Cloud-hosted. Free tier trains on input — paid tier or AI Studio opt-out does not. Requires `GEMINI_API_KEY` and an `--i-understand` acknowledgement. |

Non-interactive form:

```sh
node bin/robin install --profile mxbai-1024
```

What it does (in order):

1. **Embedder profile validation** — checks Ollama is reachable / Gemini key is present where required.
2. **Persists config** to `<package_root>/user-data/config.json`.
3. **Runs migrations** (`runMigrations`) against `<package_root>/user-data/db/` — applies any pending `.surql` files, including the profile-specific `0008-embedder-<profile>.surql`.
4. **Writes the tamper baseline** to `<package_root>/user-data/manifest.json` — content hashes of key handler files, permission bits on the secrets/db directories, supervisor file checksum. The daemon checks against this on boot.
5. **Installs host-side hooks** into `~/.claude/settings.json` and `~/.gemini/settings.json` — Bash policy, UserPromptSubmit auto-recall, SessionStart registry, Stop hook. Hooks invoke `<package_root>/bin/robin-hook.sh`, a POSIX shim that finds `node` even under nvm/asdf where `/bin/sh` may not have it on PATH. Foreign hook entries in those files are preserved byte-for-byte; the manifest of robin-owned entries lives at `<package_root>/user-data/installed-hooks.json`.
6. **Installs the daemon supervisor** — writes `~/Library/LaunchAgents/io.robin-assistant.mcp.plist` (macOS) or `~/.config/systemd/user/robin-mcp.service` (Linux) and `launchctl load` / `systemctl --user enable` so the daemon auto-restarts on crash.
7. **Starts the daemon** and writes the chosen port to `<package_root>/user-data/.daemon.state`.
8. **Registers with each host CLI** on PATH: `claude mcp add --transport sse robin http://127.0.0.1:<port>/sse` and the Gemini equivalent.
9. **Merges the `<!-- robin -->` block** into `~/.claude/CLAUDE.md` and `~/.gemini/GEMINI.md` so agents see the active rules + integration surface on next session start.

**Restart your Claude Code / Gemini CLI session afterward** so it picks up the new MCP server and hooks.

Useful flags:

- `--no-supervise` skip launchd/systemd registration
- `--no-register` skip `mcp add` calls
- `--no-agents-md` skip CLAUDE.md/GEMINI.md merge
- `--no-start` install everything but don't start the daemon yet
- `--no-hooks` skip host-side hook installation
- `--hooks-only` only run the hook-install step (use after manual settings.json edits)
- `--force` re-run even if Robin is already configured

### Step 3 — Add your secrets

v2 keeps a single `<package_root>/user-data/secrets/.env` (mode 0600). If you're coming from v1:

```sh
robin secrets import --from ~/workspace/robin/robin-assistant/user-data/runtime/secrets/.env
```

Otherwise, set keys one by one (echo suppressed in interactive mode):

```sh
robin secrets set GOOGLE_OAUTH_CLIENT_ID
robin secrets set GOOGLE_OAUTH_CLIENT_SECRET
robin secrets set SPOTIFY_CLIENT_ID
# …
robin secrets list   # prints key names only, never values
```

Each integration declares the env keys it needs in its manifest (`secrets.env_keys`); the daemon reads them on demand via `requireSecret(key)` and never pollutes `process.env`.

### Step 4 — Authenticate OAuth providers (as needed)

Desktop (browser loopback flow):

```sh
robin auth google      # gmail, calendar, drive, youtube share GOOGLE_OAUTH_*
robin auth spotify
robin auth whoop
```

Headless / VM / SSH:

```sh
robin auth google --code            # prints the URL, prompts for the pasted code
robin auth google --code=<value>    # one-shot
```

API-key integrations (lunch_money, linear, weather, ebird, nhl, ga, chrome, lrc, letterboxd, github, spotify-read) just need their env keys set. Manifests with optional `preflight()` mark themselves `unavailable` if the key/file is missing — the daemon stays up.

### Step 5 — Discord bot (optional)

```sh
robin auth discord
robin integrations discord register-commands
```

### Step 6 — Pre-commit privacy hook (optional, per-repo)

For personal repos you want Robin to help keep clean of credentials. Run from inside the repo:

```sh
robin pre-commit install
```

Writes `.git/hooks/pre-commit` only if no hook is already present. The hook scans staged diffs for `.env`/`secrets/` paths and credential shapes; refuses commit on hit. Idempotent — re-running is a no-op. Remove with `robin pre-commit uninstall`.

### Step 7 — Verify the install

```sh
robin doctor              # status overview (ROBIN_HOME, manifest, daemon, secrets)
robin mcp status          # daemon port + tool count
robin integrations list   # available / unavailable / synced status
robin integrations status # last-run + cursor + backoff per integration
robin sessions            # active host sessions
robin journal             # recent capture
robin hot                 # hot entities / topics
robin rules pending       # rule candidates awaiting your approval
```

### Uninstall

```sh
robin uninstall
```

Stops the daemon, removes hook entries from host settings, unregisters from each host CLI, unloads the supervisor, removes the supervisor file. Your `<package_root>/user-data/` (DB, secrets, backups, telemetry) is left in place — remove manually if desired.

## Daily life

You don't talk to Robin directly — your agent does. After install, just use Claude Code or Gemini CLI normally. Robin:

- Injects relevant memory at the start of every turn (auto-recall on UserPromptSubmit)
- Refuses dangerous Bash commands (secrets-read, destructive-rm, `surreal sql` against the local DB, etc.)
- Refuses memory writes that contain credentials or secrets (via the in-MCP PII guard)
- Captures the turn's content into events, biographs them into entities + edges + episodes, and consolidates nightly into long-term knowledge
- Surfaces rule candidates from your corrections after they cluster

Outbound writes (`github_write`, `spotify_write`, discord replies) pass through `src/outbound/policy.js` (PII / secrets / verbatim-untrusted-quote guards) and a per-tool sliding-1h rate limiter (default 10/hr).

## Command reference

### Daemon

```
robin install [--profile P] [--no-hooks] [--hooks-only] [--no-supervise] [--no-register] [--no-agents-md] [--no-start] [--force]
robin uninstall
robin mcp <start|stop|status|restart|ensure-running|install|uninstall>
robin doctor [--rebaseline|--purge-stale-sessions|--lint-hooks]
```

### Memory

```
robin remember [--force] <content>       # CLI memory write; --force bypasses inbound PII guard
robin journal                            # recent capture
robin hot                                # hot entities / topics
robin rules pending                      # rule candidates awaiting approval
robin rules approve <id>
robin rules reject <id>
robin rules list
robin rules deactivate <id>
robin dream run                          # trigger nightly consolidation now
robin biographer-catchup [--retry-failed]
robin migrate                            # apply pending schema migrations
robin migrate-from-v1                    # one-shot import from v1
robin embedder switch <profile>          # switch + resumable re-embed
```

### Safety / sessions

```
robin sessions [--stale]                 # list active sessions, or purge stale
robin refusals list                      # recent in/outbound refusal audit
robin hooks <disable|enable> <phase>     # kill-switch a single hook (bash-policy, auto-recall, session-start, stop)
robin pre-commit <install|uninstall>     # per-repo privacy hook
robin hook <phase>                       # internal — invoked by host hook entries; not for direct use
```

### Integrations

```
robin integrations <list|status|run>
robin integrations discord register-commands
robin auth <google|spotify|whoop> [--code [<VALUE>]]
robin secrets <import --from <path>|list|set <KEY>>
```

## Develop

```sh
npm install
npm test                  # node --test on tests/**/*.test.js
npm run test:unit
npm run test:integration
npm run lint              # biome check
npm run format            # biome format --write
```

### Layout

```
src/
  schema/migrations/    .surql migrations (0001–0010)
  db/                   SurrealDB connection + migration runner
  embed/                pluggable embedder factory (mxbai / qwen3 / gemini)
  capture/              recordEvent + errors
  recall/               HNSW search + auto-recall endpoint
  graph/                cascade.js, edges, episodes, Stage 1–3 resolvers
  dream/                5-step nightly pipeline + prompts
  rules/                heuristic correction loop
  memory/               knowledge / patterns / profile / threads readers
  hosts/                Claude Code + Gemini CLI subprocess adapters
  daemon/               server, scheduler, biographer queue, sessions,
                        tamper-check, idle embedder, locks, port file
  mcp/                  MCP tool definitions
  hooks/                bash-patterns, pii-patterns, inbound-guard,
                        cli dispatcher, disabled.txt reader,
                        handlers/ (bash-policy, auto-recall,
                                   session-start, stop-hook)
  integrations/<name>/  manifest + sync + tool factories + auth helpers
  outbound/             policy + rate limiter + patterns
  secrets/              .env layer + atomic writes
  install/              launchd plist, systemd unit, AGENTS.md generator,
                        hook-shim, hooks-settings, manifest, pre-commit
  cli/commands/         CLI surface
  runtime/              ROBIN_HOME bootstrap, paths, runtime config

bin/                    robin (the executable) + robin-hook.sh (PATH shim)
scripts/                dev-recall.js, gen-fixtures.js, bench-embedder.js
tests/                  unit/ · integration/ · fixtures/
docs/superpowers/specs/ per-phase design docs
```

## License

[MIT](LICENSE)
