# Architecture

How Robin is structured after the database + memory redesign, the
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
       ├─ Reinforcement  5-min internal job: per-hit attribution (explicit -> citation -> similarity) over pending recall_log; bumps signal_count per used hit, queues a reflection trigger on correction
       │                 → signal_count++/decay_anchor=now on hits
       │                 (the keystone effectiveness fix; closes the loop)
       ├─ Biographer     per-event LLM call → entities + edges + memos
       │                 (writes through store.relateAll for batched edges)
       ├─ Dream          nightly multi-step pipeline → knowledge / patterns /
       │                 reflection / profile / arcs / commStyle /
       │                 calibration / scope cleanup / compaction
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
         memos     · distilled cognition; kind ∈ {knowledge, habit, prediction,
                     state_inference, reasoning, session_outcome}
                     (`thread` retired in alpha.16 — arcs are now a separate table)
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
- **Theme 4 — Introspection.** Read-only MCP tools (`explain_recall`,
  `explain_action_trust`, `show_pending_triggers`, `show_step_health`,
  `show_telemetry_rollup`, `recent_refusals`, `archive_history`) plus
  `robin doctor --health`
  (status rollups + exit codes 0/1/2 for cron monitoring). Audit test
  (`audit-introspection-readonly.test.js`) enforces zero write keywords
  in introspection tool source.
- **Cognition C3 — Telemetry umbrella.** `telemetry_hourly` is an hourly
  rollup of hot-tier telemetry — `intuition_telemetry`, `recall_log`
  (via the `evaluated_at` cursor, B1-aware), the hot prefixes of
  `cadence_telemetry` (`dream.%`), and
  `meta_cognition_telemetry`. The aggregator
  (`system/cognition/jobs/internal/telemetry-rollup.js`) runs hourly at :05,
  UPSERTs `telemetry_hourly:{dimensions_hash}` rows over `[$cursor, $cutoff)`,
  advances per-source cursors stored on `runtime:telemetry.cursor`, and
  prunes raw rows past 7d / hourly rows past 90d. Pending recall_log rows
  past 30d are force-pruned; doctor's `pending_recall_log` probe warns at
  >100 pending older than 7d. Cold tables (`compaction_telemetry`,
  `state_inference_telemetry`, `recall_eval_runs`, non-hot
  `cadence_telemetry`) stay raw. `show_telemetry_rollup` MCP tool reads
  rolled-up rows; shipped with `shadow_mode=true` for a one-week soak.
  See `docs/superpowers/specs/2026-05-11-cognition-c3-telemetry-umbrella-design.md`.
- **Cognition D1 — State inference.** Heartbeat-paced 5-min ticker in
  `runtime/daemon/server.js` runs `evaluateStateInference` once per active
  source. Writes `memos.kind = 'state_inference'` via
  `cognition/memory/state_inference.js`. The intuition path surfaces a
  `<!-- current focus -->` block when the latest inference is fresh,
  confident, and not pivoted away from the user's current prompt. Gated by
  `runtime:state_inference.config.enabled` (`false` | `'shadow'` | `true`).
- **Cognition D2 — Recall-failures meta-cognition.** Weekly Sunday-05:00 LOCAL
  internal job in `cognition/jobs/internal/meta-recall-narrative.js`. Pure-JS
  clustering by `about`-edge endpoints; one tier:'fast' LLM call per run;
  writes a `kind='reasoning'`, `meta.dimension='recall_failures'` memo plus
  0–3 `rule_candidates` (`kind='behavior'`, `payload.source='meta_cognition'`,
  distinct from `step-reflection.js`). Gated by
  `runtime:meta_cognition.config.enabled` (`false` | `'shadow'` | `true`).
  Telemetry: `meta_cognition_telemetry` (rollup deferred to C3).
- **Cognition D3 — Calibration meta-narrative.** Weekly Sunday 05:30 LOCAL
  writer (`30 5 * * 0`, staggered 30 min after D2) summarises per-domain
  prediction-calibration drift into one `kind='reasoning'`,
  `meta.dimension='calibration'` memo per domain. When drift is
  sustained-large (≥ `meta_narrative_rule_threshold` over
  `meta_narrative_rule_min_weeks` consecutive weeks, default 0.15 / 2 weeks),
  emits a `rule_candidates` row with
  `payload.source='meta_cognition_calibration'`.

## A typical agent turn

1. **SessionStart hook** registers the session in `runtime_sessions` (with `transcript_path`).
2. **You type a message.** UserPromptSubmit (intuition) reads the transcript tail, POSTs `{query, prior_assistant, source, k:6, recency_days:30}` to the daemon. The handler resolves the latest `state_inference` for the agent's source; if one exists and is fresh + confident, a `<!-- current focus -->` block is prepended (200-token cap; suppression rules cover disabled flag, low confidence, staleness, supersedes leak, pivot detection, and private scope). Intuition pipeline: `store.searchEvents` + `store.searchMemos(kind='knowledge')` → batched `conflicts.fetchContradictors` (when `runtime:recall.value.conflict_surfacing_enabled` is `true`) → `rank.score` (passing `contradictionCount` from the hydrated pairs) → MMR-lite → wire format `<!-- current focus -->` (D1, cap 200) + `<!-- conflicts -->` (B2, cap 300, only when pairs survive suppression) + `<!-- relevant memory -->` (cap 1500). Writes `recall_log{outcome:pending}` (with `meta.focus_block_present` and `meta.focus_block_tokens` for A3 stratification) and `intuition_telemetry` rows. Fail-soft on every error.
3. **The agent reads its instructions** and calls MCP tools (`recall`, `remember`, `note`, `find_entity`, `ingest`, `predict`, `update_action_policy`, etc.).
4. **Bash PreToolUse hook (discretion)** statically checks the command against 7 deny rules. Match → exit 2.
5. **`store.remember` / `store.note`** validates against registries, writes the row + embedding, optionally relates subjects (`about` edges) and lineage (`derived_from` edges).
6. **Stop hook** spawns biographer in detached subprocess. Pending events flow into a source-bucketed accumulator (defaults: `max_batch_size=8`, `debounce_ms=750`, `max_wait_ms=3000`; `disable=false`). One LLM call per batch resolves entities + edges + per-event episode boundaries; the underlying queue serialises batches across sources. UPSERTs entities (deduped per `(type, name_lower)` per batch) + emits `edges` via `store.relateAll(...)`, sets `events.biographed_at` + `events.episode_id` per event under one gated UPDATE *per episode group* in the batch (typically one group; two on mid-batch episode break). Rollback knob: `batch_config.disable=true` reverts the daemon to the per-event path.
7. **Heartbeat** (60s) runs integration syncs, drains biographer queue, marks stale sessions, advances quiet-window cursors, and dispatches due internal jobs (notably `reinforce-recall` every 5 min).
8. **Nightly at 4 AM**, dream runs a layered DAG (`runDag` over `DREAM_DAG_DEPS`): three layers, fan-out across each. **L1** (`knowledge, patterns, reflection, profile, arcs, commStyle`) → **L2** (`scopeCleanup, calibration`) → **L3** (`compaction`). Each step is fail-soft (`summary.<step>.error`). The unified `UPDATE events SET dreamed_at = time::now() WHERE dreamed_at IS NONE` mark is a post-layer barrier — it runs once, after every step settles. Parallelism is flag-gated by `runtime:\`dream.config\`.value.parallelism_enabled` (default `false`); budget is enforced between layers against the unified 24-h `cadence_telemetry` sum. Step-knowledge emits `supersedes` when promoting contradicting facts. See also: R-2's `runtime:\`scheduler.config\`` bucket-scheduler runs *periodic tickers* at the daemon level (`system/runtime/daemon/dispatcher-tick.js`); C2's `runDag` orchestrates step concurrency *within one dream tick* (`system/cognition/dream/scheduler.js`).
9. **Reinforce-recall** (every 5 min) walks `recall_log` rows with `outcome='pending'` and `ts < now - 5min`. For each row: if a `meta.kind='correction'` event landed in the session window -> mark `outcome='corrected'` and emit a `dream_triggers` reflection row. Otherwise -> attribute hits per the `attribute()` pipeline (explicit -> citation -> similarity, with fallback-on-no-reply), and for every hit with `used=true` bump `signal_count += 1` and refresh `decay_anchor`. Outcome is `reinforced` when any hit was used, `evaluated_no_used` when attribution matched zero hits with fallback off, `evaluated_no_signal` for empty `ranked_hits`. The labeled output (per-hit `used`/`used_via`) feeds a future reranker.
10. **Meta-cognition (weekly).** Sunday 05:00 LOCAL: `meta-recall-narrative` (D2) walks `recall_log` for the trailing 7 days of failure patterns and emits a `kind='reasoning'` memo (`meta.dimension='recall_failures'`) plus 0-3 `rule_candidates` (`kind='behavior'`, `payload.source='meta_cognition'`). Skipped when corrections < 5/week. Sunday 05:30 LOCAL (staggered 30 min): `meta-calibration-narrative` (D3) summarises per-domain calibration drift into one `kind='reasoning'` memo per domain (`meta.dimension='calibration'`); when drift is sustained-large (≥ `meta_narrative_rule_threshold` over `meta_narrative_rule_min_weeks` consecutive weeks, default 0.15 / 2 weeks), emits a `rule_candidates` row with `payload.source='meta_cognition_calibration'`. Idempotent on `(meta.dimension, meta.domain, meta.week_starting)`. Subsequent recalls about a cluster's entity can surface either reasoning memo via the widened intuition fan-out (`kind: ['knowledge','reasoning']`).

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
