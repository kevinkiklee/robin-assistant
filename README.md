# robin-assistant v6 (alpha)

A personal AI memory layer for Claude Code and Gemini CLI, backed by an embedded multi-model database. Robin captures what you talk about, links it into a graph, consolidates it nightly, and serves it back through MCP — so the next session knows what the last one knew.

This is the SurrealDB-first rebuild of Robin. v1 (`robin-assistant@5.x`) remains daily-use Robin until the v1→v2 migrator lands.

## Status

`6.0.0-alpha.7` — Phase 2f (OAuth generalization + spotify-write + headless OAuth + rate limiter + 16 integrations). See [`CHANGELOG.md`](CHANGELOG.md) for the per-phase delta and `docs/superpowers/specs/2026-05-09-robin-v2-foundation-design.md` in the v1 repo for the master design doc.

## How it works

```
Hosts (Claude Code, Gemini CLI)
   │   MCP HTTP+SSE  (44-tool surface — recall, graph, memory shapes,
   │                   integrations, outbound writes, daemon control)
   ▼
robin-mcp daemon  (single owner of the DB)
   ├─ Capture        recordEvent → embed → events table (HNSW dim 384, BGE-small-en-v1.5)
   ├─ Recall         HNSW kNN + recency window + source/trust filters
   ├─ Biographer     1 LLM call per event → entities, edges, episodes (Stage 1–3 cascade)
   ├─ Dream          nightly 5-step batch → knowledge / patterns / profile / threads / rule candidates
   ├─ Heartbeat      60s tick driving integration sync cursors + dream + biographer queue
   ├─ Outbound       PII / secret / verbatim-quote guards + sliding-1h rate limiter (default 10/hr)
   └─ Self-improve   recall_events feedback + heuristic correction loop (corrections → user-approved rules)
   ▼
Embedded SurrealDB v3   (rocksdb:// ~/.robin/db/)
   events · entities · episodes · 6 edge tables ·
   knowledge · patterns · profile · threads ·
   rule_candidates · rules · recall_events · runtime
```

A few non-obvious shapes:

- **Single write primitive** — every capture (CLI, sync integration, Discord, write-tool audit) lands as an `events` row. Content-hash dedupe; embeddings cached on hash.
- **Schema is source of truth** — hand-written `.surql` migrations under `src/schema/migrations/`, applied by a v3-aware runner with a pre-migration tar backup.
- **Daemon owns the DB** — embedded RocksDB is single-process. The `robin-mcp` daemon is the only writer; CLI commands route through it when running, otherwise take a cooperative file lock.
- **Multi-host, no direct API calls** — biographer and dream invoke the LLM through your host's CLI subprocess (Claude Code or Gemini CLI), with `cache_control` annotations on cacheable layers.
- **Three integration kinds** — `sync` (heartbeat-driven pulls: gmail, calendar, drive, youtube, lunch_money, weather, ebird, nhl, linear, whoop, ga, chrome, lrc), `gateway` (long-lived in-process: discord), `tool-only` (write surfaces: github_write, spotify_write).

## Installation

### Prerequisites

- **Node.js ≥ 22**
- **macOS** (launchd) or **Linux** (systemd user services)
- **Claude Code** and/or **Gemini CLI** on PATH for auto-registration
- Provider credentials for whatever integrations you want (Google OAuth, Spotify, Linear API key, etc.)

### Steps

```sh
git clone git@github.com:kevinkiklee/robin-assistant.git robin-v2
cd robin-v2
npm install

# 1. One-shot install: migrate + start daemon + supervise + register with hosts.
node bin/robin install
```

`robin install` runs:

1. `robin migrate` — applies pending `.surql` migrations to `~/.robin/db/`, with a pre-migration tar backup.
2. `robin mcp install` —
   - writes the supervisor file (`~/Library/LaunchAgents/io.robin-assistant.mcp.plist` on macOS, `~/.config/systemd/user/robin-mcp.service` on Linux),
   - `launchctl load` / `systemctl --user enable` so the daemon auto-restarts on crash,
   - starts the daemon and writes the chosen port to `~/.robin/.daemon.state`,
   - runs `claude mcp add --transport sse robin http://127.0.0.1:<port>/sse` (and the Gemini equivalent) for each host CLI it finds on PATH,
   - merges a regenerable `<!-- robin -->` block into `~/.claude/CLAUDE.md` and `~/.gemini/GEMINI.md` so agents see the active rules + integration surface.

Restart your Claude Code / Gemini session afterward so it picks up the new MCP server.

Useful flags: `--no-supervise`, `--no-register`, `--no-agents-md`, `--no-start`.

### 2. Import secrets

v2 keeps a single `${ROBIN_HOME}/secrets/.env` (mode 0600). If you're coming from v1:

```sh
robin secrets import --from ~/workspace/robin/robin-assistant/user-data/runtime/secrets/.env
```

Otherwise:

```sh
robin secrets set GOOGLE_OAUTH_CLIENT_ID
robin secrets set GOOGLE_OAUTH_CLIENT_SECRET
robin secrets set SPOTIFY_CLIENT_ID
# …
robin secrets list   # prints key names only, never values
```

Each integration declares the env keys it needs in its manifest (`secrets.env_keys`); `requireSecret(key)` reads on demand and never pollutes `process.env`.

### 3. Auth the OAuth providers

On a desktop (browser loopback flow):

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

API-key integrations (lunch_money, linear, weather, ebird, nhl, ga, chrome, lrc) just need their env keys set. Manifests with optional `preflight()` mark themselves `unavailable` if the key/file is missing — the daemon stays up.

### 4. Discord (optional)

```sh
robin auth discord
robin integrations discord register-commands
```

### 5. Verify

```sh
robin mcp status              # daemon + port
robin integrations list       # available / unavailable / synced status
robin integrations status     # last-run + cursor + backoff per integration
robin journal                 # recent capture
robin hot                     # hot entities / topics
robin rules pending           # rule candidates awaiting your approval
```

### Uninstall

```sh
robin uninstall
```

Stops the daemon, unregisters from each host, unloads the supervisor, removes the supervisor file. Your `~/.robin/db/` is left in place.

## Daily life

You don't talk to Robin directly — your agent does. A typical turn:

1. Agent's CLAUDE.md/GEMINI.md tells it to call `recall` and check `list_rules({status: 'active'})` early.
2. Agent calls MCP tools (`recall`, `find_entity`, `gmail_search`, …) over SSE; the daemon serves from SurrealDB.
3. After the turn, the host's Stop hook spawns a detached `robin biographer process-pending` subprocess. The biographer reads new events, makes one LLM call per event through `host.invokeLLM`, and UPSERTs entities + edges + episodes.
4. Heartbeat scheduler ticks every 60s — runs due integration syncs, advances quiet-window cursors, drains the biographer queue.
5. Nightly at 4 AM (`process.env.TZ`), Dream runs the 5-step pipeline and produces knowledge / patterns / profile / threads / rule candidates. Corrections that cluster (cosine ≥ 0.85, min 3, 30-day window) become `rule_candidates`.
6. You approve or reject candidates with `robin rules approve <id>` (or via the `update_rule` MCP tool). Approved rules surface in CLAUDE.md/GEMINI.md on the next session.

Outbound writes (`github_write`, `spotify_write`, discord replies) pass through `src/outbound/policy.js` (PII / secrets / verbatim-untrusted-quote guards) and a per-tool sliding-1h rate limiter.

## Develop

```sh
npm install
npm test                  # node --test on tests/**/*.test.js
npm run test:unit
npm run test:integration
npm run lint              # biome check
npm run format            # biome format --write
```

Layout:

```
src/
  schema/migrations/   .surql migrations (0001–0007)
  db/                  SurrealDB connection
  embed/               @huggingface/transformers, lazy-loaded
  capture/  recall/    write + read primitives
  graph/               cascade.js, edges, episodes, Stage 1–3 resolvers
  dream/               5-step pipeline + prompts
  rules/               heuristic correction loop
  memory/              knowledge, patterns, profile, threads readers
  hosts/               Claude Code + Gemini CLI subprocess adapters
  daemon/              server, scheduler, biographer queue, idle embedder, locks, port file, version handshake
  mcp/                 MCP tool definitions (44 tools)
  integrations/<name>/ manifest + sync + tool factories + auth helpers
  outbound/            policy + rate limiter
  secrets/             .env layer + atomic writes
  install/             launchd plist, systemd unit, AGENTS.md generator
  cli/commands/        CLI surface
  runtime/             ROBIN_HOME bootstrap, paths, runtime config

scripts/               dev-recall.js, gen-fixtures.js, bench-embedder.js
tests/                 unit/  integration/  fixtures/
```

## License

[MIT](LICENSE)
