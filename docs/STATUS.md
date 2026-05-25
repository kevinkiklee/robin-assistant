# Robin — Implementation Status

> Snapshot: 2026-05-25
> Build state: **766 tests passing**, typecheck clean, lint clean

## What's running

Robin runs as a single-process daemon on macOS via launchd (KeepAlive). Current reference setup: M5 Max 64 GB, Ollama with qwen3.5:35b-a3b (MoE, 3B active params) for reasoning/summarize and qwen3-embedding:8b for embeddings.

The full loop is operational: Claude Code sessions are captured via a session-end hook, the biographer extracts entities and relations, embedder indexes content for vector search, the dream job runs nightly for prediction resolution + journal generation, and 18 integrations tick on their cron schedules.

## Subsystems

### Memory + cognition
- **Event store**: append-only events + events_content with 4096-dim embeddings (sqlite-vec, Matryoshka)
- **Recall**: hybrid FTS5 + vector search, graceful degradation when embedder unavailable
- **Entity graph**: ~5000+ entities, ~14000+ relations, extracted by the biographer
- **Beliefs**: topic-keyed claim supersession via `believe` / `recall_belief` (with ROW_NUMBER ordering for deterministic latest-per-topic). **Belief lifecycle** (P1–P4): provenance classification (`first-party`/`inferred`/`third-party`/`external`/`unknown`), `verified_at` freshness tracking, confidence decay for inferred claims, selective tagging in session-start primer (only suspect beliefs annotated)
- **Predictions**: confidence tracking + Brier calibration (computed at resolution in `resolve_prediction`), resolved by the dream job
- **Corrections**: correction log with optional `topic` link; topic-linked corrections auto-retract the contradicted belief nightly (the ONE sanctioned auto-repair path)

### Cognition jobs
- **biographer.run** — multi-tick entity/relation extraction from captured sessions. Chunks sessions at 10k chars, processes ≤10 chunks per tick, persists progress in `biographer_progress`. Circuit-breaks on unreachable LLM (no empty markers on Ollama outage).
- **embedder.run** — deferred embedding of events_content rows (every minute, single-flight Ollama)
- **dream.run** — nightly at 03:00 local: prediction resolution, metrics rollup, journal generation, **belief-freshness scan** (flags stale beliefs + bounded resolver re-query), **corrections→belief replay** (auto-retracts topic-linked corrected beliefs)

### Surfaces
- **robin-core MCP** (16 tools): recall, remember, believe, recall_belief, find_entity, get, list, predict, record_correction, audit, explain, health, metrics, journal, power, skill
- **robin-extension MCP** (~14 tools): per-integration action dispatchers + run, integration_status, ingest, related_entities, resolve_prediction, check_action, update
- **CLI**: init, doctor, daemon, status, pause/resume, incognito, offline/online, db, import, reindex, upgrade, publish, published, reauth, integrations, hooks, mcp, **beliefs backfill-provenance**, **ingest-archive**
- **HTTP**: health endpoint + session-end hook receiver (port 41273)

### Skills
- System skills (ship with package): `skill-authoring`, `memory-curation`, `web-research`
- User skills: `user-data/extensions/skills/<name>/` (gitignored, user-shadows-system)
- Catalog embedded in the `skill` MCP tool description for progressive disclosure

### Integrations
- **9 built-in**: gmail, google_calendar, github, linear, chrome, weather, finance_quote, claude_code (session capture), notify
- **9 user extensions**: whoop, spotify, ebird, lunch_money, letterboxd, lrc, nhl, shipments, spotify_write
- Hot-reload via chokidar file watcher

### Scheduler reliability
- Cron self-re-arms after completion (Bug C fix — cron never silently dies)
- In-process lease reaper (60s interval, Bug B fix)
- Dead-worker lease recovery at boot (controlled-restart path)
- Heartbeat monitor → 30-min sustained-CRITICAL gate → exit(1) for launchd respawn (Bug A fix)
- withTimeout on every LLM call (Bug E/F fix — no handler can hang indefinitely)

## Test coverage

413 tests across the full stack. Highlights:
- Biographer: multi-tick, user-shadows-system, circuit-breaker, entity filter, disambiguation
- Skills: loader, MCP tool, built-in validity
- Scheduler: cron re-arm, lease recovery, dead-worker recovery
- Memory: recall modes, FTS5 sanitization, belief supersession, embedding pipeline
- Integration: loader, scheduler-glue, init-failure resilience
- End-to-end: foundation smoke (init → doctor → daemon → job → stop)

## Known gaps (deferred)

- **Interactive `robin init`** — TTY prompts + OAuth device flow + model pulling. `--yes` (non-interactive) covers daily use.
- **Kuzu graph projection** — scaffolded in paths.ts; not wired. Use once SQL traversal becomes a bottleneck.
- **APFS snapshots** for `robin db backup` — current VACUUM-INTO backup works; APFS needs elevated permissions.
- **Job retention/pruning** — completed job rows accumulate (~1500/day from embedder). No auto-prune yet.
- **Multi-account integrations** — one instance per integration name.

## Recent changes (2026-05-25)

- **Belief lifecycle (P1–P4)**: provenance policy module (`provenance.ts`), recall enrichment (confidence/provenance/age on belief hits), selective suspect-tagging in primer, formation gate (external claims routed out, class-thresholded promotion), nightly freshness scan with bounded resolver re-query, topic-linked corrections→belief auto-retraction. Migrations 013 (belief_candidates.provenance) + 014 (corrections.topic). 25 files, ~1700 lines, 2 migrations. Key safety fix: explicit-supersede writes append instead of same-day upsert (preserves history + prevents self-referencing supersession chain).
- **ingest-archive**: bulk text archive → recall (sha-deduped, paragraph-chunked, deferred embedding). CLI `robin ingest-archive <dir> --source=name`.
- **CI fixes**: `.npmrc` auto-install-peers (lockfile mismatch), build-essential for native modules, pre-existing formatter/import lint errors resolved.

## Previous changes (2026-05-23)

- Skills system: MCP-surfaced `skill` tool with catalog-in-description, system + user skills, 3 seeded system skills
- Biographer multi-tick: sessions resume across cron ticks via `biographer_progress` table (migration 006)
- Biographer circuit breaker: LLM-unreachable → abort without advancing cursor (prevents empty-marker corruption)
- CHUNK_CHARS raised 6k → 10k, MAX_CHUNKS_PER_TICK 4 → 10
- Belief enumerate: ROW_NUMBER window function for deterministic same-timestamp ordering
- LLM dispatcher: withTimeout on every invoke/embed + per-call timeoutMs override
- MAX_SESSION_BODY_CHARS raised 200k → 1M (multi-tick makes large sessions safe)
- Docs reorganization: CONTRIBUTING/RUNBOOK/SECURITY moved to docs/, ARCHITECTURE.md + PUBLISHING.md created
