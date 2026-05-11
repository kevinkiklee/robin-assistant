# Architecture

How Robin v2 is structured after the database + memory redesign, the
surrealdb-improvements pass, and the seven-theme evolution roadmap
(alpha.16).

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
   Embedded SurrealDB v3   (surrealkv:// at <robin-home>/db/)
       Substrate (3 tables):
         events    · raw firehose; biographed_at/dreamed_at flags
         memos     · distilled cognition; kind ∈ {knowledge, habit, thread,
                     prediction, state_inference, reasoning, session_outcome}
         entities  · graph nouns; open `type` enum
       Edges (1 generic RELATION table, composite-ID `edges:[kind, in, out]`):
         kind ∈ {mentions, about, before, works_on, participates_in,
                 occurs_with, derived_from, supersedes, contradicts}
         Arrow traversal available: `<-edges[WHERE kind='X']<-source` plus
         recursive `{1..N}`, `+shortest`, `+collect`, `+path`.
       Embeddings (per-(profile, surface)):
         embeddings_<profile>_{events,memos,entities}
         (HNSW; profile swap = new tables + reindex; data tables untouched)
       Operational:
         episodes, persona (singleton), runtime (KV), runtime_sessions,
         runtime_jobs, intuition_telemetry, recall_log, refusals,
         action_trust, rule_candidates, rules, _migrations
       Evolution layer (alpha.16):
         arcs              · multi-episode containers (active/paused/closed)
         evidence_ledger   · append-only corroborate/refute rows;
                             fn::derived_confidence computes from these
         action_trust_ledger · audit history for action-trust state changes
         dream_triggers    · queue for trigger-eligible dream steps
         cadence_telemetry · per-step cost; basis for daily token budget
         archive_memos/_edges/_log · cold tier (out of hot recall, audited)
         compaction_telemetry · per-run summary of step-compaction
```

## Why it's shaped this way

- **One substrate, three tables.** Events (raw), memos (distilled, kind-discriminated), entities (graph nouns). Anything memorable maps to a `memo` kind — adding a new kind is a code change (validator + lens), not a schema migration.
- **One edges RELATION table.** Composite IDs `edges:[kind, in, out]` give idempotent `INSERT RELATION ... ON DUPLICATE KEY UPDATE` semantics. Registry (`EDGE_KIND_REGISTRY`) enforces endpoint types, self-loop rejection, and symmetric canonicalization at write time. TYPE RELATION enables `->edges[WHERE kind=X]->target` arrow traversal everywhere, plus recursive depth-bounded paths and shortest-path queries.
- **Embeddings separable from data.** Per-(profile, surface) tables (`embeddings_<profile>_{events,memos,entities}`). Swapping embedders never touches the data tables; just create a new profile's tables, backfill, flip `runtime:embedder.active_profile`.
- **Open enums throughout.** `memos.kind`, `entities.type`, `events.source`, `events.trust`, `edges.kind` are unconstrained strings. Code-side registries enforce shape.
- **Recall closes the loop.** Every recall hit is evaluated 5 min later; if no correction landed, `signal_count++` and `decay_anchor=now`. Useful memos sharpen with use. `recall_log` becomes labeled-ish training data for a future reranker.
- **Belief evolution without deletion.** `supersedes` and `contradicts` edges annotate; old memos remain queryable. `fn::freshness` returns 0 for any memo with an inbound `supersedes` edge.
- **The daemon owns the DB.** Embedded RocksDB is single-process. `robin-mcp` is the only writer; CLI commands route through it.

## Evolution layer (alpha.16)

Seven themes layered on top of the substrate:

- **Theme 1c — Scope rework.** `system/cognition/memory/scope-registry.js` is the single
  source of truth for scope policy: `policyFor`, `validateScope`,
  `scopeMatches`, `persistentScopesSqlFilter`. Hierarchical scopes via `/`
  path notation (`project:robin/v2` matches descendants). `private` scope
  now actually enforced — `checkOutboundScope` refuses payloads referencing
  private memos directly or transitively via `<-derived_from<-memos[WHERE scope='private']`.
- **Theme 2a — Evidence ledger.** Confidence is derivable, not frozen.
  `fn::derived_confidence($memo)` = `(initial × prior_weight + Σcor)/(prior_weight + Σcor + Σref)`.
  Reinforcement loop writes corroborates on reinforce AND refutes on
  correction (the missing symmetric path). Stored `memos.confidence`
  updated lazily by `step-confidence-recompute` (nightly dream step).
- **Theme 2b — Action-trust ledger.** Every state change of `action_trust`
  mirrors to `action_trust_ledger`. Decay sweep (6h heartbeat) demotes
  stale `AUTO` classes. Three consecutive corrections → state escalates
  to `DENY` automatically.
- **Theme 3 — Cognition cadence.** Trigger queue (`dream_triggers`) +
  heartbeat consumer (60s). Three steps are trigger-eligible (`reflection`,
  `comm-style`, `calibration`). Cost-budget enforced via 7-day rolling
  median of `cadence_telemetry` × safety margin (default 20%). Live
  decrement halts the loop within one tick of budget exhaustion.
- **Theme 1a — Compaction.** `step-compaction` (nightly, after
  step-scope-cleanup): dedup via `supersedes` (canonical from each
  content_hash cluster) + archive tier (per-kind eligibility moves stale
  memos to `archive_memos`+`archive_edges` with audit in `archive_log`).
  Recall structurally cannot reach archive (no FTS / vector index).
- **Theme 1b — Arcs.** First-class multi-episode containers. `step-arcs`
  (nightly) clusters episodes by shared participating entities, dedups
  against existing arcs via Jaccard ≥ 0.7. State machine
  active→paused→closed by idle time. `closeStaleEpisodes` heartbeat (10
  min) closes episodes whose `last_event_at` exceeds per-source idle.
- **Theme 4 — Introspection.** Seven read-only MCP tools (`explain_recall`,
  `explain_belief`, `explain_action_trust`, `show_pending_triggers`,
  `show_step_health`, `recent_refusals`, `archive_history`) plus
  `robin doctor --health` (status rollups + exit codes 0/1/2 for cron
  monitoring). Audit test (`audit-introspection-readonly.test.js`)
  enforces zero write keywords in introspection tool source.

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

The substrate + edges + per-surface embeddings live in one SurrealDB v3 instance. The edges table is `TYPE RELATION`, so arrow traversal works alongside the index-backed `(kind, in)` / `(kind, out)` lookups: recall, biographer, and dream use arrow paths where they help (`<-edges[WHERE kind='about']<-memos`, recursive `{1..N}`, `+shortest`) and explicit `SELECT ... WHERE kind = X AND in = $id` where the projection wants direct field access.

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
  AND id IN (SELECT VALUE in FROM edges WHERE kind = 'about' AND out = $entity_id)
ORDER BY derived_at DESC LIMIT 10;

-- All entities that co-occur with $entity, sorted by counter weight.
SELECT IF in = $entity THEN out ELSE in END AS other, weight
FROM edges
WHERE kind = 'occurs_with' AND (in = $entity OR out = $entity)
ORDER BY weight DESC LIMIT 10;

-- Server-side freshness ranking for distilled memos in the last 7d.
SELECT id, content, fn::freshness(id) AS fresh
FROM memos
WHERE kind = 'knowledge' AND derived_at > time::now() - 7d
ORDER BY fresh DESC LIMIT 10;

-- "What did Robin believe about $entity at time $t?" — supersedes-aware.
SELECT * FROM memos
WHERE id IN (SELECT VALUE in FROM edges WHERE kind = 'about' AND out = $entity)
  AND derived_at <= $t
  AND id NOT IN (SELECT VALUE out FROM edges WHERE kind = 'supersedes' AND created_at <= $t)
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
