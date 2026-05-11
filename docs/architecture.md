# Architecture

How Robin v2 is structured after the database + memory redesign.

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
       ├─ Capture        store.remember → events table + embeddings
       │                 (inbound discretion refuses credential-shaped writes)
       ├─ Recall         HNSW kNN on per-surface embeddings → rank.score
       │                 (cosine × freshness × contradiction × trust × scope)
       │                 → MMR-lite diversity → recall_log{outcome:pending}
       ├─ Reinforcement  5-min internal job: pending recall_log + no correction
       │                 → signal_count++/decay_anchor=now on hits
       │                 (the keystone effectiveness fix; closes the loop)
       ├─ Biographer     per-event LLM call → entities + edges + memos
       │                 (writes through store.relateAll for batched edges)
       ├─ Dream          nightly 5-step pipeline → knowledge / habits /
       │                 narrative / persona / rule candidates / scope cleanup
       ├─ Heartbeat      60s tick: integration syncs, biographer queue,
       │                 stale-session sweeper, internal jobs (reinforce-recall)
       ├─ Discretion     outbound: PII / secret / verbatim-quote guards +
       │                 sliding-1h rate limiter (default 10/hr)
       ├─ Reflection     corrections + reinforcements → rule_candidates
       └─ Introspection  manifest-baseline integrity check at boot
       │
       ▼
   Embedded SurrealDB v3   (rocksdb:// at <robin-home>/db/)
       Substrate (3 tables):
         events    · raw firehose; biographed_at/dreamed_at flags
         memos     · distilled cognition; kind ∈ {knowledge, habit, thread,
                     prediction, state_inference, reasoning, session_outcome}
         entities  · graph nouns; open `type` enum
       Edges (1 generic table, composite-ID `edges:[kind, from, to]`):
         kind ∈ {mentions, about, before, works_on, participates_in,
                 occurs_with, derived_from, supersedes, contradicts}
       Embeddings (per-(profile, surface)):
         embeddings_<profile>_{events,memos,entities}
         (HNSW; profile swap = new tables + reindex; data tables untouched)
       Operational:
         episodes, persona (singleton), runtime (KV), runtime_sessions,
         runtime_jobs, intuition_telemetry, recall_log, refusals,
         action_trust, rule_candidates, rules, _migrations
```

## Why it's shaped this way

- **One substrate, three tables.** Events (raw), memos (distilled, kind-discriminated), entities (graph nouns). Anything memorable maps to a `memo` kind — adding a new kind is a code change (validator + lens), not a schema migration.
- **One edges table.** Composite IDs `edges:[kind, from, to]` give idempotent UPSERT. Registry (`EDGE_KIND_REGISTRY`) enforces endpoint types, self-loop rejection, and symmetric canonicalization at write time.
- **Embeddings separable from data.** Per-(profile, surface) tables (`embeddings_<profile>_{events,memos,entities}`). Swapping embedders never touches the data tables; just create a new profile's tables, backfill, flip `runtime:embedder.active_profile`.
- **Open enums throughout.** `memos.kind`, `entities.type`, `events.source`, `events.trust`, `edges.kind` are unconstrained strings. Code-side registries enforce shape.
- **Recall closes the loop.** Every recall hit is evaluated 5 min later; if no correction landed, `signal_count++` and `decay_anchor=now`. Useful memos sharpen with use. `recall_log` becomes labeled-ish training data for a future reranker.
- **Belief evolution without deletion.** `supersedes` and `contradicts` edges annotate; old memos remain queryable. `fn::freshness` returns 0 for any memo with an inbound `supersedes` edge.
- **The daemon owns the DB.** Embedded RocksDB is single-process. `robin-mcp` is the only writer; CLI commands route through it.

## A typical agent turn

1. **SessionStart hook** registers the session in `runtime_sessions` (with `transcript_path`).
2. **You type a message.** UserPromptSubmit (intuition) reads the transcript tail, POSTs `{query, prior_assistant, k:6, recency_days:30}` to the daemon. Intuition pipeline: `store.searchEvents` + `store.searchMemos(kind='knowledge')` → `rank.score` → MMR-lite → format as `<!-- relevant memory -->` block under a 1500-token budget. Writes `recall_log{outcome:pending}` and `intuition_telemetry` rows. Fail-soft on every error.
3. **The agent reads its instructions** and calls MCP tools (`recall`, `remember`, `note`, `find_entity`, `ingest`, `predict`, `update_action_policy`, etc.).
4. **Bash PreToolUse hook (discretion)** statically checks the command against 7 deny rules. Match → exit 2.
5. **`store.remember` / `store.note`** validates against registries, writes the row + embedding, optionally relates subjects (`about` edges) and lineage (`derived_from` edges).
6. **Stop hook** spawns biographer in detached subprocess. Reads new events, makes one LLM call per event, UPSERTs entities + emits `edges` via `store.relateAll(...)`, sets `events.biographed_at`.
7. **Heartbeat** (60s) runs integration syncs, drains biographer queue, marks stale sessions, advances quiet-window cursors, and dispatches due internal jobs (notably `reinforce-recall` every 5 min).
8. **Nightly at 4 AM**, dream runs the pipeline: step-knowledge → step-habits → step-narrative → step-persona → step-reflection → step-scope-cleanup. Each step is fail-soft. Step-knowledge emits `supersedes` when promoting contradicting facts.
9. **Reinforce-recall** (every 5 min) walks `recall_log` rows with `outcome='pending'` and `ts < now - 5min`. If a `meta.kind='correction'` event landed in the session window → mark `outcome='corrected'`. Otherwise → for each hit memo, `signal_count += 1` and `decay_anchor = time::now()`; mark `outcome='reinforced'`. The labeled-ish output feeds a future reranker.

## Database shape and example queries

The substrate + edges + per-surface embeddings live in one SurrealDB v3 instance. Recall, biographer, and dream all compose explicit `SELECT` over `edges` indexed by `(kind, from)` and `(kind, to)` — graph-arrow traversal is unavailable (TYPE NORMAL trade-off for composite-ID idempotence).

Example SurrealQL — mirroring shapes Robin's pipelines run:

```surql
-- HNSW vector recall against the active profile's events surface.
SELECT record, vector::distance::knn() AS dist
FROM embeddings_mxbai_1024_events
WHERE vector <|6, 64|> $qvec
ORDER BY dist
LIMIT 6;

-- Memos about a given entity (the new shape of subject lookup).
SELECT id, content, confidence FROM memos
WHERE kind = 'knowledge'
  AND id IN (SELECT VALUE from FROM edges WHERE kind = 'about' AND to = $entity_id)
ORDER BY derived_at DESC LIMIT 10;

-- All entities that co-occur with $entity, sorted by counter weight.
SELECT IF from = $entity THEN to ELSE from END AS other, weight
FROM edges
WHERE kind = 'occurs_with' AND (from = $entity OR to = $entity)
ORDER BY weight DESC LIMIT 10;

-- Server-side freshness ranking for distilled memos in the last 7d.
SELECT id, content, fn::freshness(id) AS fresh
FROM memos
WHERE kind = 'knowledge' AND derived_at > time::now() - 7d
ORDER BY fresh DESC LIMIT 10;

-- "What did Robin believe about $entity at time $t?" — supersedes-aware.
SELECT * FROM memos
WHERE id IN (SELECT VALUE from FROM edges WHERE kind = 'about' AND to = $entity)
  AND derived_at <= $t
  AND id NOT IN (SELECT VALUE to FROM edges WHERE kind = 'supersedes' AND created_at <= $t)
ORDER BY derived_at DESC;

-- Reinforcement pending rows ready for evaluation.
SELECT id, session_id, ranked_hits FROM recall_log
WHERE outcome = 'pending' AND ts < time::now() - 5m;
```

## See also

- [`faculties.md`](faculties.md) — per-faculty deep dive (attention, chronicle, knowledge, habits, persona, narrative, foresight, biographer, dream, intuition, discretion, reflection, introspection).
- [`development.md`](development.md) — extending Robin (new memo kind = registry entry + lens; new edge kind = registry entry; no migration).
- [`troubleshooting.md`](troubleshooting.md) — common problems.
- `docs/superpowers/specs/2026-05-11-robin-v2-database-and-memory-redesign-design.md` — design rationale.
