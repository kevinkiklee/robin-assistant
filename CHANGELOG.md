# Changelog

## [6.0.0-alpha.8b] — 2026-05-10

Phase 3b: v1→v2 migrator + missing read-sync integrations + cleanup. Builds on Phase 3a (`v6.0.0-alpha.8a`) embedder profiles.

- **`robin migrate-from-v1`** — top-level CLI: idempotent (`sha256('v1:'+v1_id)` dedup via `events_from_v1_hash`/`entities_from_v1_hash`/`episodes_from_v1_hash` indexes), resumable (per-phase progress in `runtime:migration_progress`), audit-friendly (`meta.from_v1` provenance on every migrated row). Phase order: entity → episode → capture → edges → lossy. v1 `mentions` migrates lossy-as-events (the naive amplification would emit ~42K false-positive `events→entities` edges); biographer can re-derive proper edges as it processes captures.
- **5 phases × ~2,400 v1 captures + 950 entities + 38 episodes + ~3,800 lossy rows** map cleanly to v2 schema. v1 `transaction` and `watch` lossy-preserved (manual edits would have been overwritten by Lunch Money's API resync otherwise).
- **Audit/rework surface (§12 of spec)** — `--status`, `--show-failures [--phase X]`, `--reset [--phase X] [--dry-run]` with cascade rules, `--export-mappings <path>`, `--phase X` for selective re-run. Native data is never touched: every destructive op filters on `meta.from_v1.source_hash IS NOT NONE`. Cascade for `--reset --phase entity`: edges → lossy v1-edge events → entities. `docs/AUDIT.md` walkthrough + `scripts/audit-fixup.js.example` template.
- **`embed_backfill` daemon job** — singleton-cron drains rows where `embedding IS NONE AND meta.embed_failed IS NOT true`, batches of 64, every tick. Wired into `src/daemon/server.js` scheduler alongside `__dream__`. Embedder lazily loaded via 3a's `createEmbedder()` (mxbai/qwen3/gemini profile). Poison rows get `meta.embed_failed = true` and are excluded from future ticks.
- **`github` read-sync** — issues / PRs / notifications / releases-of-starred via `GITHUB_PAT`. Reuses `github_write/client.js` REST helpers. 1h cadence. 2 MCP tools: `github_recent_activity`, `github_notifications`.
- **`spotify` read-sync** — recently-played + top tracks/artists via existing `SPOTIFY_*` PROVIDERS entry. **Month-bucketed top-items external_ids** (`spotify:top_track:<window>:<YYYY-MM>:<id>`) preserve monthly snapshots instead of forever-deduping the first occurrence. Gap detection (>50 plays since last sync). 4h cadence. 2 MCP tools.
- **`letterboxd` CSV ingest** — drop `letterboxd-*.csv` into `<package_root>/user-data/upload/`. Diary-format detection by header columns; non-Diary CSVs moved aside with `.error.txt`. Processed files → `upload/processed/`. **No daemon restart needed** when dropping a CSV after install — preflight only ensures the upload dir exists; CSV check is a soft no-op inside `sync()`.
- **30-day backup auto-prune** — `src/db/backup.js` deletes archives older than 30 days before writing new tar. Override via `ROBIN_BACKUP_RETENTION_DAYS=N` (set to 0 to disable).
- **No encryption at rest** — explicit `## Security posture` section in AGENTS.md (regenerable via `<!-- robin-security:start/end -->`). RocksDB has no built-in encryption; rely on FileVault / LUKS at the filesystem layer. Threat model: single-user local install, device itself is trusted.
- **`0009-migrator-v1.surql`** — adds `meta.from_v1.source_hash` indexes on events/entities/episodes; `participates_in.meta` (FLEXIBLE) so v1 fields v2 doesn't define (confidence, valid_from, etc.) survive in `meta.v1_payload`; `events.embedded_at` field + `meta.embed_failed` for backfill tracking.
- **5 new MCP tools** (github×2, spotify×2, letterboxd×1) → integrations now total 19 (`gmail, google_calendar, google_drive, youtube, ga, lunch_money, weather, ebird, nhl, linear, whoop, chrome, lrc, discord, github_write, spotify_write, github, spotify, letterboxd`).
- **Cutover runbook** — see `docs/superpowers/specs/2026-05-10-robin-v2-phase-3b-migrator-design.md` §10. v6.0.0 publish stays gated on Phase 4 daily-use parity, not 3b.
- **Several SurrealDB v3 type-coercion gotchas** discovered during integration testing and documented in code comments: JS `null` ≠ SurrealDB `NONE` for `option<T>` fields (omit the field instead); `ts: time::now()` requires a `Date` object via `surql` template, not an ISO string; `episode_id: record<episodes>` requires reconstructing the RecordId from the resolver's string id; `ORDER BY <field>` requires `<field>` to appear in `SELECT`.
- **Test count**: 580/590 passing on full suite (10 pre-existing better-sqlite3 native-binding failures unrelated to 3b). All 3b-specific unit + integration tests pass.

Phase 3b candidates that didn't ship: forward-looking biographer hint replay from `v1_mentions` lossy events; reranker training-set bootstrapping from `v1_preference` + `v1_correction` (Phase 4 work).

## [6.0.0-alpha.7] — 2026-05-10

Phase 2f: OAuth generalization + spotify-write + headless OAuth + rate limiter + 8 read-sync integrations.

- **OAuth2 generalization**: `_auth/oauth2-google.js` → `_auth/oauth2.js` with PROVIDERS registry (google/spotify/whoop). `google-token-cache.js` → `token-cache.js` keyed per-provider. Refresh-token rotation handled when provider declares `rotatesRefreshToken: true`.
- **Headless OAuth `--code` flag**: `robin auth google --code [<VALUE>]` for VM/SSH cases. Re-introduces `auth google/spotify/whoop` CLIs (removed in 2e). `--code=<VALUE>` inline; `--code` alone interactive prompt.
- **Per-tool rate limiter**: `runtime:outbound_rate.<tool>` sliding 1-hour window. Default 10/hr. Per-tool env override (`GITHUB_WRITE_RATE_LIMIT`, `SPOTIFY_WRITE_RATE_LIMIT`).
- **spotify-write**: tool-only with 3 actions (queue, skip, playlist-add). First integration to exercise refresh-token rotation roundtrip.
- **8 new read-sync integrations**: weather (6h), ebird (12h), nhl (12h), linear (1h), whoop (30m, 4-9am EDT only via quiet_window), ga (1d, requires `analytics.readonly` re-auth), chrome (1d, local SQLite), lrc (1w, local SQLite).
- **Manifest preflight**: optional `manifest.preflight()` async export. Failed preflight → `unavailable` list; daemon stays up; `integrations list` shows the row.
- **Quiet-window scheduler**: manifests can declare `quiet_window: { tz, active_hours }`. After each sync, `runIntegrationSync` advances `next_run_at` past inactive hours.
- **better-sqlite3** added as dep (transient client lib for chrome/lrc local SQLite reads; never used as storage — SurrealDB remains sole datastore).
- **13 new MCP tools** (44 baseline daemon surface; some preflight-gated by env / file presence).
- **AGENTS.md** updated with 16 integrations + spotify_write outbound caveat. Outbound writes section now covers both github_write and spotify_write with rate-limit semantics.
- **v1 env var compatibility verified at Task 0**: linear uses `LINEAR_API_KEY` (not `PAT`), ga uses `GA_PROPERTIES` (multi-property comma-sep), whoop adds `read:body_measurement` and `offline` scopes.
- **Apple Photos NOT included** (dropped per user directive during brainstorm).

Phase 2g candidates: `integration_run` MCP tool (deferred since Phase 2d), per-integration filtering in `integrations list`, `discord_send` MCP tool, additional v1 integrations as needed.

## [6.0.0-alpha.6] — 2026-05-09

Phase 2e: .env secrets layer + Calendar/Drive/YouTube + github_write.

- **Secrets layer rework:** Phase 2d's per-integration JSON files at `~/.robin/secrets/<name>.json` replaced with a single `${ROBIN_HOME}/secrets/.env`. Lazy `requireSecret(key)` reads, atomic write-temp-then-rename for `saveSecret` and `importFrom`. No `process.env` pollution. Each manifest declares `secrets.env_keys: [...]`.
- **`robin secrets import --from <path>`** copies v1's `user-data/runtime/secrets/.env` into v2's location with 0600 perms. **Required upgrade step from 2d.** Plus `robin secrets list` (key names only, never values) and `robin secrets set <KEY>` (interactive, no echo).
- **3 new sync integrations** all reusing `GOOGLE_OAUTH_*` env keys via a `google-token-cache.js` singleton (refresh-promise dedup):
  - `google_calendar` (30m, ±14d window, upsert)
  - `google_drive` (4h, 30d/200-cap first sync, upsert)
  - `youtube` (24h, three-kind capture: sub/playlist/liked, insert-or-skip)
- **`github_write` tool-only integration** — third manifest kind alongside sync and gateway. 4 actions (create-issue, comment, label, mark-read). Text actions through outbound-policy; non-text skip. create-issue and comment captures audit events to the events table; label and mark-read are daemon-log only.
- **7 new MCP tools** (31 total daemon surface): `calendar_list_events`, `calendar_get_event`, `drive_search`, `drive_get_file`, `youtube_list_subscriptions`, `youtube_list_liked`, `github_write`. `integration_run` gains `tool_only_no_sync` refusal reason.
- **Removed:** `auth gmail/lunch_money/discord` CLIs and `_auth/secrets-io.js`. OAuth loopback helper retained for 2f's headless flow.
- **AGENTS.md** restructured into three regenerable sub-blocks: Integration data freshness, Outbound writes (github_write), Available integrations.
- **Daemon boot warning** if `${ROBIN_HOME}/secrets/.env` is missing.
- **`integrations list`** now merges manifest registry with runtime row, displaying gateway/tool-only kinds correctly alongside synced integrations.

Phase 2f candidates: spotify-write, headless OAuth `--code` flag, rate limiter, remaining v1 integrations (weather, ebird, chrome, whoop, lrc, linear, nhl, photos, ga).

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
