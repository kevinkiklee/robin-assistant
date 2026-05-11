# Architecture

How Robin is structured, why it's structured that way, and what happens during a typical agent turn.

## The big picture

```
Claude Code / Gemini CLI session
   │
   ├─ SessionStart hook ────────────► registers session + introspection warnings
   ├─ UserPromptSubmit hook ────────► intuition: injects relevant memory
   ├─ PreToolUse(Bash) hook ────────► discretion: refuses risky commands
   ├─ MCP tool calls (SSE) ─────────► recall, remember, find_entity, etc.
   └─ Stop hook ────────────────────► biographer processes new events
       │
       ▼
   robin-mcp daemon  (single owner of the embedded DB)
       ├─ Capture        recordEvent → embed → events table
       │                 (HNSW vector index — dim depends on embedder profile)
       │                 + inbound discretion refuses credential-shaped writes
       ├─ Recall         HNSW kNN + recency window + source/trust filters
       ├─ Biographer     1 LLM call per event → entities, edges, episodes
       ├─ Dream          nightly 5-step batch → knowledge / patterns /
       │                 profile / threads / rule candidates
       ├─ Heartbeat      60s tick: integration syncs, biographer queue,
       │                 stale-session sweeper
       ├─ Discretion     outbound: PII / secret / verbatim-quote guards +
       │                 sliding-1h rate limiter (default 10/hr)
       ├─ Reflection     corrections → 30-day cluster → rule candidates →
       │                 user approval → DB-backed rules surfaced to agents
       └─ Introspection  manifest-baseline integrity check at boot;
                         multi-session registry; refusals audit table
       │
       ▼
   Embedded SurrealDB v3   (rocksdb:// at <package_root>/user-data/db/)
       events · entities · episodes · 6 edge tables ·
       knowledge · patterns · profile · threads ·
       rule_candidates · rules · recall_events · refusals · runtime_*
       (sessions, introspection_state, intuition_telemetry, scheduler,
       embedder)
```

## Why it's shaped this way

- **Single write primitive.** Every capture — CLI, sync integration, Discord, manual `remember` — lands as a row in the `events` table. Content-hash dedupe; embeddings cached on hash; inbound discretion runs at the entry point.
- **Schema is the source of truth.** Hand-written `.surql` migrations under `src/schema/migrations/` (0001–0012), applied by a v3-aware runner with a pre-migration tar backup.
- **The daemon owns the DB.** Embedded RocksDB is single-process. The `robin-mcp` daemon is the only writer; CLI commands route through it when running, otherwise take a cooperative file lock.
- **Multi-host, no direct API calls.** The biographer and dream pipelines invoke the LLM through your host's CLI subprocess (Claude Code or Gemini CLI), with `cache_control` annotations on cacheable layers. No Anthropic / Google API key required for memory operations.
- **Three integration kinds:**
  - `sync` — heartbeat-driven pulls (gmail, calendar, drive, youtube, lunch_money, weather, ebird, nhl, linear, whoop, ga, chrome, lrc, github, spotify, letterboxd)
  - `gateway` — long-lived in-process (discord)
  - `tool-only` — write surfaces invoked by the agent (github_write, spotify_write)
- **Safety faculties:** host-side hooks installed into `~/.claude/settings.json` (discretion on bash, intuition on prompt, session-start registry, biographer Stop hook) plus inbound discretion on every memory write, daemon-boot introspection, and a standalone pre-commit privacy hook for personal repos.

## A typical agent turn

1. **SessionStart hook** registers the session in `runtime_sessions` (with `transcript_path` so other hooks can read prior turns). If introspection found drift at the last daemon boot, the warnings surface in stderr at session start.
2. **You type a message.** UserPromptSubmit hook (intuition) reads the last 8 KB of the transcript, extracts the previous assistant message, POSTs `{query, prior_assistant, k:6, recency_days:30}` to the daemon's `/internal/intuition`. The daemon runs the recall pipeline and returns a `<!-- relevant memory -->` block formatted under a 1500-token budget. The host injects it into the model's context. Fail-soft on every error.
3. **The agent reads its instructions** in `~/.claude/CLAUDE.md` (and the regenerable `<!-- robin -->` block inside it), calls `recall` / `find_entity` / `gmail_search` / etc. via MCP over SSE.
4. **If the agent runs Bash**, the PreToolUse hook (discretion) checks the command against 7 deny rules (secrets-read, env-dump, destructive-rm, low-level-fs, git-expose-userdata, eval-injection, db-direct-access). Match → exit 2, command refused. Static — no daemon round-trip.
5. **If the agent calls `remember` / `record_correction`**, inbound discretion checks the content against credential / secret / private-key / JWT / password-assignment patterns. Match → refused, logged to `refusals(direction='inbound')`, agent sees a structured error.
6. **Stop hook** spawns a detached `robin biographer process-pending` subprocess. The biographer reads new events, makes one LLM call per event through `host.invokeLLM`, and UPSERTs entities + edges + episodes.
7. **Heartbeat** ticks every 60s — runs due integration syncs, drains the biographer queue, marks stale sessions, advances quiet-window cursors.
8. **Nightly at 4 AM** (`process.env.TZ`), Dream runs the 5-step pipeline and produces knowledge / patterns / profile / threads / rule candidates. Inside that pipeline, **reflection** clusters correction events (cosine ≥ 0.85, min 3, 30-day window) into `rule_candidates`.
9. **You approve or reject candidates** with `robin rules approve <id>` (or via the `update_rule` MCP tool). Approved rules surface in CLAUDE.md/GEMINI.md on the next session.

## Database shape and example queries

The graph edges, document tables, vector indexes, and runtime/KV rows live in one SurrealDB v3 instance, addressable through one query language. Recall, biographer, and dream all rely on composing graph traversal with vector kNN inside a single statement rather than stitching results across stores.

| Layer | Tables |
|---|---|
| Capture | `events` (768-dim HNSW), `episodes`, `recall_events` |
| Entities + graph | `entities` (384-dim HNSW), `mentions`, `about`, `precedes`, `works_on`, `participates_in`, `co_occurs_with` |
| Long-term memory | `knowledge` (384-dim HNSW), `patterns`, `profile`, `threads` |
| Reflection | `rule_candidates`, `rules` |
| Runtime / safety | `runtime_*` (sessions, introspection_state, intuition_telemetry, scheduler, embedder), `refusals` |

A small slice of the graph the biographer builds from a single event:

```
                       ┌──── event:e1 ─────┐
                       │ "talked to bob    │
                       │  about auth for   │
                       │  project-x"       │
                       └─────────┬─────────┘
                                 │ mentions
              ┌──────────────────┼──────────────────┐
              ▼                  ▼                  ▼
         entity:bob        entity:auth        entity:project-x
          (person)            (topic)            (project)
              │                                     ▲
              │             works_on                │
              └─────────────────────────────────────┘

  entity:project-x ── co_occurs_with (strength = 4.2) ──► entity:robin

  Vector index events_vec  (HNSW, dim 768)  ── used by recall (`<|K, EF|>`)
  Vector index entities_vec (HNSW, dim 384)  ── used by find_entity stage 2
```

Example SurrealQL — these mirror the shapes Robin's own pipelines run:

```surql
-- HNSW vector recall: 6 nearest events to a query embedding.
-- The KNN operator `<|K, EF|>` uses the events_vec HNSW index;
-- `vector::distance::knn()` reads back the per-row distance.
SELECT content, ts, vector::distance::knn() AS dist
FROM events WHERE embedding <|6, 64|> $qvec;

-- Graph traversal: every event that mentioned an entity named "robin".
SELECT <-mentions<-events.{content, ts} AS occurrences
FROM entities WHERE name_lower = 'robin';

-- Co-occurrence: top 10 entities most often seen alongside a given one.
SELECT out.name AS entity, strength
FROM co_occurs_with
WHERE in = $entity
ORDER BY strength DESC LIMIT 10;

-- Two-hop: projects worked on by entities that appear in a given episode.
SELECT ->works_on->entities.name AS projects
FROM entities WHERE id IN (
  SELECT VALUE out FROM about WHERE in IN (
    SELECT VALUE id FROM events WHERE episode_id = $episode
  )
);

-- Hybrid (vector + filter): dreamed knowledge most similar to a query,
-- restricted to the last 7 days.
SELECT content, created_at, vector::distance::knn() AS dist
FROM knowledge
WHERE embedding <|5, 64|> $qvec
  AND created_at > time::now() - 7d;
```

## See also

- [`faculties.md`](faculties.md) — per-faculty deep dive
- [`development.md`](development.md) — extending Robin (new MCP tools, integrations, hooks, migrations)
- [`troubleshooting.md`](troubleshooting.md) — common problems
