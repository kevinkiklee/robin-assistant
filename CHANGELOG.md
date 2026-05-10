# Changelog

## [6.0.0-alpha.5] — 2026-05-09

Phase 2d: integrations framework + Gmail + Lunch Money + Discord bot.

- New schema (migration 0006 + 0007): `events.external_id` UNIQUE on `(source, external_id)`, `events.trust` marker, embedding relaxed to `option<>`, `outbound_refusals` table; 0007 relaxes the `events.source` ASSERT to allow integration sources and makes `content_hash` optional.
- **Integration framework** under `src/integrations/<name>/` — manifest + sync + tool factories + auth helpers. Heartbeat scheduler now drives per-integration cursors with per-name in-flight tracking. Backoff: 3 consecutive scheduled failures double the cadence (capped at 24h); manual triggers don't feed backoff. Daemon-boot in_flight cleanup clears stale flags from a crashed run. Dream cursor seeded + advanced as a special "__dream__" entry inside the same scheduler loop.
- **Three reference integrations:** gmail (15m, OAuth PKCE), lunch_money (1d, API key, upsert mode for edits), discord (in-process gateway bot, allowlist-gated, replies through outbound-policy).
- **5 new MCP tools** (24 total daemon surface): `gmail_search`, `gmail_get_thread`, `lunch_money_query`, `integration_status`, `integration_run`. `integration_run` enforces 30s min-interval + gateway/in-flight refusals.
- **9 new CLI commands:** `robin auth gmail/lunch_money/discord`, `robin integrations list/status/run`, `robin integrations discord register-commands`.
- **Outbound policy** (`src/outbound/policy.js`): PII / secret / verbatim-untrusted-quote (last 7d) guards. Discord bot replies pass through it; future github/spotify writes will too.
- **AGENTS.md** integrations auto-section: regenerable `<!-- robin-integrations:start/end -->` block with freshness instructions and per-integration tool list.
- **discord.js v14** added as production dependency.

Phase 2e candidates: Calendar/Drive/YouTube reusing Gmail's OAuth (shared `google.json`); github-write + spotify-write through outbound-policy; headless OAuth device flow; `--code` flag for paste-the-code path.

## [6.0.0-alpha.4] — 2026-05-09

Phase 2c: dream agent + memory shapes + heuristic loop.

- New schema (migration 0005): `knowledge`, `patterns`, `profile` (singleton), `threads`, `rule_candidates`, `rules`. `events.dreamed_at` field added.
- **Dream agent** — daemon-internal periodic batch, heartbeat-scheduled (nightly cron at 4 AM via `process.env.TZ` + event-count overflow trigger). Five-step pipeline: knowledge synthesis → pattern detection → correction clustering → profile inference → thread updates. All LLM calls flow through `host.invokeLLM` subprocess (no direct API).
- **9 new MCP tools** (consolidated from 14): `get_knowledge`, `list_patterns`, `get_profile`, `list_threads`, `list_journal`, `get_hot`, `list_rules(status?)`, `update_rule(id, action, options?)`, `run_dream`. Total daemon surface: 19.
- **8 new CLI commands**: `robin dream run`, `robin rules pending/approve/reject/list/deactivate`, `robin journal`, `robin hot`.
- **Heuristic correction loop**: corrections → 30-day rolling cluster (cosine ≥ 0.85, min 3) → LLM proposes rule → user approves via MCP or CLI → rule active. Profile updates same flow but `kind='profile_update'` with `payload.fields` applied on approval.
- **`rules` table preserves `kind` + `payload`** for replayability of approved profile updates.
- **Heartbeat scheduler** (60s tick) replaces fragile setTimeout — robust to laptop sleep + DST.
- **AGENTS.md** updated with active-rules + pending-rules sections instructing agents to call `list_rules({status: 'active'})` at session start.
- **Task 0**: fixed Phase 2a Claude Code adapter args from stub `['invokeLLM']` to real `claude -p` + JSON output.

Phase 2d (integrations: Gmail, Discord, etc.) is the next phase.

## [6.0.0-alpha.3] — 2026-05-09

Phase 2b followups: zero-friction setup + integration test gaps.

- **`robin install`** — one-command full setup (migrate + mcp install + auto-start + auto-register + auto-supervise).
- **`robin uninstall`** — mirror command (stops daemon, unregisters from hosts, unloads supervisor).
- **`robin mcp install` enhanced:** auto-starts daemon, auto-registers with `claude mcp add` and `gemini mcp add` when those CLIs are on PATH, auto-loads launchd / enables systemd. New flags: `--no-supervise`, `--no-register`, `--no-agents-md`, `--no-start`.
- **Integration test for full install flow** — verifies plist + AGENTS.md generation, plus `plutil -lint` validation of the launchd plist on macOS.
- **Daemon-spawn test timeouts** bumped from 8s to 15s for slow CI runners.
- Graceful degradation when host CLIs / supervisors aren't available.

## [6.0.0-alpha.2] — 2026-05-09

Phase 2b: MCP daemon + agent-facing tools + self-improvement feedback infra.

- New schema (migration 0004): `recall_events` for self-improvement feedback capture.
- `robin-mcp` HTTP+SSE daemon owns the embedded SurrealDB; multi-instance Claude Code safe.
- 10 MCP tools exposed via `@modelcontextprotocol/sdk`:
  - **Memory:** `recall` (with auto-capture into recall_events), `remember`, `run_biographer`.
  - **Graph:** `find_entity`, `get_entity`, `related_entities`.
  - **Episodes:** `list_episodes`.
  - **Daemon:** `health`.
  - **Self-improvement:** `mark_recall_used`, `record_correction`.
- Stop hook routes through daemon when running; falls back to spawn-detached subprocess otherwise.
- Migration coordination: `robin migrate` refuses while daemon is running.
- Daemon supervision generators: launchd plist (macOS) + systemd user unit (Linux).
- AGENTS.md template with feedback section installed by `robin mcp install` (writes to `~/.claude/CLAUDE.md` and `~/.gemini/GEMINI.md`, append-with-fenced-section to preserve personal content).
- Implicit-signal detection: repeat-query-within-5min flagged in `recall_events.meta`.
- Idle-embedder unloader: 10-minute timeout.
- Version handshake: daemon refuses requests from version-skew CLI.
- New CLI: `robin mcp start/stop/status/restart/ensure-running/install/uninstall`.

Both Claude Code (2.1.138) and Gemini CLI (0.37.1) confirmed to support HTTP/SSE MCP transport — no stdio shim needed.

Phase 2c (dream + memory shapes) is the immediate follow-on.

## [6.0.0-alpha.1] — 2026-05-09

Phase 2a: graph + biographer foundation.

- New schema (migration 0003): `entities` (HNSW indexed at dim 384), `episodes`, 6 edge tables (`mentions`, `about`, `precedes`, `works_on`, `participates_in`, `co_occurs_with`).
- `events.biographed_at` and `events.episode_id` added; migrator-compatible.
- Biographer pipeline: single LLM call per event extracts entities + edges + episode signals; cascade resolution (Stages 1 + 2 + 3) maps mentions to entity records.
- Multi-host adapters: Claude Code subprocess (lifted from v1) + Gemini CLI subprocess (Path A from verification spike). Both with unified `invokeLLM` interface and `cache_control` annotations.
- Multi-host caching: Anthropic ephemeral cache_control on cacheable layers; Gemini CLI manages caching transparently — `cache_read_tokens` surfaced from `stats.models[*].tokens.cached`.
- Fire-and-forget Stop hook: hook spawns detached `robin biographer process-pending` subprocess; agent never waits.
- New CLI: `robin biographer-catchup [--retry-failed]` (foreground manual catchup); `robin biographer process-pending --since <iso>` (subcommand for hooks).
- `runtime:biographer.config` holds tunable thresholds (Stage 2 high/low at 0.92/0.80, episode window 30min, catalog size 100, cooccur cap 8).
- `runtime:host` records detected adapter.
- Failure handling: 3× retry with exponential backoff; failed events tracked in `runtime:biographer.failed_event_ids`; `--retry-failed` revisits them.
- Concurrency: file lock + entity UPSERT with stable IDs + transactional retry; parallel biographer invocations on the same event don't double-create entities.
- Background subprocess output redirected to `~/.robin/logs/biographer.log`.

Phase 2b (MCP server + agent-facing tools) is the immediate follow-on.

## [6.0.0-alpha.0] — 2026-05-09

Phase 1 foundation. The minimum SurrealDB-first vertical slice:

- New repo, new package version line.
- Embedded SurrealDB v3 via `@surrealdb/node` (rocksdb:// engine; mem:// in tests).
- Schema source-of-truth in `src/schema/migrations/*.surql` with a v3-aware migration runner.
- `events` table (with HNSW vector index pinned to dimension 384) + `runtime` + `_migrations` schemas.
- Embedder pipeline (`@huggingface/transformers`, lazy-loaded; deterministic stub for tests). Default model: `Xenova/bge-small-en-v1.5` (chosen by Phase 1 benchmark).
- Internal `recordEvent` and `recall` functions with content-hash embedding cache.
- CLI surface: `robin migrate`, `robin --version`, `robin --help`. No agent-facing commands yet (deferred to Phase 3 MCP server).
- ROBIN_HOME bootstrap, cooperative file lock, pre-migration tar backup.
- CI: GitHub Actions workflow for unit + integration on ubuntu-latest and macos-latest, plus schema-lint. Activates when v2 merges back into the GitHub-hosted v1 repo.
- Embedder benchmark methodology + chosen model pinned (see `docs/superpowers/specs/2026-05-09-robin-v2-embedder-benchmark.md` in the v1 repo).
- `scripts/dev-recall.js` for manual smoke testing.

No agent integration yet. v1 (`robin-assistant@5.x`) remains daily-use Robin.
