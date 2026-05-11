# Robin v2 — Database and memory layer redesign

**Status:** Design (pre-implementation)
**Date:** 2026-05-11
**Predecessors:** Phases 1–4f shipped 14 hand-written `.surql` migrations (`0001-init.surql` … `0014-predictions.surql` plus three `0008-*` embedder variants). Schema grew by accretion around a single `events` firehose plus per-faculty tables (`knowledge`, `patterns`, `threads`, `predictions`, etc.) and six per-relation edge tables (`mentions`, `about`, `precedes`, `works_on`, `participates_in`, `co_occurs_with`).
**Premise:** This is the last big schema reshape for a long time. No v2 user exists; no v2 data needs to migrate. The v1→v2 migrator (`src/migrate-v1/`) is left in tree but will be rebuilt later — out of scope here. The schema must be **flexible** (open enums everywhere kind/type/source/trust strings appear), **performant** (no kind-filter pushdown gambles, no inline embedding dimension lock-in), and **honest** (names match what the code does).

---

## 1. Goals

1. **One substrate, three tables.** `events` (raw firehose), `memos` (distilled cognition, kind-discriminated), `entities` (graph nouns). Everything else is operational.
2. **One edges table.** Replace 6 per-relation edge tables with a single `edges` table keyed by composite `[kind, from, to]` IDs and validated by an in-code registry.
3. **Embeddings separable from data.** Per-surface, per-profile embedding tables (`embeddings_<profile>_events|memos|entities`). Embedder swaps are zero-downtime and never touch data tables.
4. **Faculty-named memory layer.** Replace `hot.js / journal.js / patterns.js / profile.js / threads.js` with `attention.js / chronicle.js / habits.js / persona.js / narrative.js` plus `foresight.js` and an unchanged `knowledge.js`. All write through one `store.js`.
5. **Open enums everywhere.** `memos.kind`, `entities.type`, `events.source`, `events.trust`, `edges.kind` are unconstrained strings; code-side registries (`MEMO_KIND_REGISTRY`, `EDGE_KIND_REGISTRY`, …) enforce shape.
6. **Recall closes the loop.** Every recall hit is evaluated 5 minutes later; if no correction landed in the session, the hit memos get `signal_count++` and `decay_anchor = now`. Useful memos sharpen with use.
7. **Provenance is graph-native.** `derived_from` edges replace `source_events` array fields. Lineage is recursive (memo → memo → events).
8. **Belief evolution without deletion.** `supersedes` and `contradicts` edges annotate; never destructive UPDATE on old facts.
9. **Capture surfaces are auditable.** Every important capture pathway is enumerated; gaps are flagged and schema-readied.

## 2. Out of scope

- v1→v2 migrator rewrite. (Deferred; `src/migrate-v1/` left in tree with a README noting it's stale.)
- Reranker model training (4e.1). Uses `recall_log` as labeled data; arrives later.
- Knowledge-promotion classifier (4e.2). Same — needs labeled data first.
- Robin's reasoning-trace capture writer. Schema-ready (`kind='reasoning'`); writer is follow-up.
- Code-edit capture writer. Schema-ready (`source='code_edit'` + attachments); writer is follow-up.
- Session-outcome capture writer. Schema-ready (`kind='session_outcome'`); writer is follow-up.
- Multi-user / multi-tenant Robin. Single-user assumption holds.

## 3. Anchoring decisions (why this shape)

**Why three substrate tables, not one or seven:**
- `events` has a fundamentally different write profile from distilled memory (high-rate firehose, biographer-consumed, time-ordered). Folding it into a `memory` table would force every events query to carry `WHERE kind='event' AND biographed_at IS NONE` — discriminator pays no rent.
- `memos` collapses `knowledge`/`patterns`/`threads`/`predictions` (and any future kind) because they share a core shape: content, confidence, lineage, scope, tags, decay. Per-kind divergence lives in `meta` with field-path indexes.
- `entities` stays separate because they are *nouns*, not propositions — different identity model (name-based dedup, type), different traversal patterns.

**Why one edges table, not 6+:**
- Edges share an obvious common shape (kind, from, to, weight, last_seen, valid_from, valid_until, meta). Per-kind tables forced a `DEFINE TABLE` ceremony per relation.
- Composite IDs `edges:[kind, from_id, to_id]` give idempotent UPSERT with no separate UNIQUE index.
- New edge kinds are zero-schema-work: add a `EDGE_KIND_REGISTRY` entry + a code path.

**Why separable embeddings, not inline columns:**
- Inline `embedding` columns hardcode dimension into every data table (today: `events.embedding`, `memos.embedding`, `entities.embedding`, `recall_events.query_vec`). Swapping embedders today requires 3+ table rewrites + a backup + downtime.
- Per-surface, per-profile tables (`embeddings_<profile>_events`, `embeddings_<profile>_memos`, `embeddings_<profile>_entities`) decouple completely. HNSW dimension lives on the embedding table; the data tables are profile-agnostic.
- Per-surface (not one combined table) avoids the HNSW + `WHERE kind=...` pushdown question — recall queries the correct surface table directly.

**Why open enums:**
- The current `events.source` ASSERT was relaxed in migration 0007. Same lesson applies to every other kind/type field: the future will need a kind we haven't named.
- Code-side registries (`MEMO_KIND_REGISTRY`, `EDGE_KIND_REGISTRY`, `ATTACHMENT_KIND_REGISTRY`) give validation, naming consistency, and a single source of truth.

**Why recall reinforcement (the keystone):**
- Today's memos are frozen at the moment of capture. Recall happens; conversations continue; useful memos never strengthen, noisy memos never fade.
- A 5-minute-delayed evaluation against the session's correction history gives a free, conservative reinforcement signal. The same `recall_log` rows become training data for a future reranker.

---

## 4. Schema

All tables and indexes for the new `0001-init.surql`. Order matters for table-event definitions (cascade events reference `edges`, so `edges` must be defined first).

### 4.1 — Substrate tables

```surql
-- events: raw firehose
DEFINE TABLE events SCHEMAFULL TYPE NORMAL;
DEFINE FIELD source         ON events TYPE string;                        -- OPEN; integration name, 'cli', 'stop_hook', 'manual', 'biographer', 'discord', 'ingest', 'action_outcome', …
DEFINE FIELD content         ON events TYPE string ASSERT string::len($value) > 0;
DEFINE FIELD content_hash    ON events TYPE option<string>;
DEFINE FIELD ts              ON events TYPE datetime DEFAULT time::now() READONLY;
DEFINE FIELD trust           ON events TYPE string DEFAULT 'trusted';     -- OPEN; 'trusted'|'untrusted'|'derived'|<future>
DEFINE FIELD scope           ON events TYPE string DEFAULT 'global';      -- OPEN; SCOPE convention prefixes
DEFINE FIELD tags            ON events TYPE array<string> DEFAULT [];
DEFINE FIELD attachments     ON events TYPE array<object> DEFAULT [];      -- [{ kind, ref, hash?, meta? }]
DEFINE FIELD meta            ON events TYPE option<object> FLEXIBLE;
DEFINE FIELD biographed_at   ON events TYPE option<datetime>;
DEFINE FIELD dreamed_at      ON events TYPE option<datetime>;
DEFINE FIELD episode_id      ON events TYPE option<record<episodes>>;
DEFINE INDEX events_ts             ON events FIELDS ts;
DEFINE INDEX events_source         ON events FIELDS source;
DEFINE INDEX events_trust          ON events FIELDS trust;
DEFINE INDEX events_scope          ON events FIELDS scope;
DEFINE INDEX events_scope_ts       ON events FIELDS scope, ts;
DEFINE INDEX events_tags           ON events FIELDS tags;
DEFINE INDEX events_chash          ON events FIELDS content_hash;
DEFINE INDEX events_biographed     ON events FIELDS biographed_at;
DEFINE INDEX events_dreamed        ON events FIELDS dreamed_at;
DEFINE INDEX events_episode        ON events FIELDS episode_id;

-- memos: distilled cognition
DEFINE TABLE memos SCHEMAFULL TYPE NORMAL;
DEFINE FIELD kind            ON memos TYPE string;                         -- OPEN; 'knowledge'|'habit'|'thread'|'prediction'|<future>
DEFINE FIELD content         ON memos TYPE string ASSERT string::len($value) > 0;
DEFINE FIELD content_hash    ON memos TYPE option<string>;
DEFINE FIELD confidence      ON memos TYPE float DEFAULT 0.5 ASSERT $value >= 0 AND $value <= 1;
DEFINE FIELD signal_count    ON memos TYPE int DEFAULT 1;
DEFINE FIELD decay_anchor    ON memos TYPE datetime DEFAULT time::now();
DEFINE FIELD derived_by      ON memos TYPE string;                         -- OPEN; 'biographer'|'dream'|'reflection'|'ingest'|'manual'|<future>
DEFINE FIELD derived_at      ON memos TYPE datetime DEFAULT time::now() READONLY;
DEFINE FIELD updated_at      ON memos TYPE datetime VALUE time::now();
DEFINE FIELD last_active     ON memos TYPE datetime DEFAULT time::now();
DEFINE FIELD scope           ON memos TYPE string DEFAULT 'global';
DEFINE FIELD tags            ON memos TYPE array<string> DEFAULT [];
DEFINE FIELD meta            ON memos TYPE option<object> FLEXIBLE;
DEFINE INDEX memos_kind             ON memos FIELDS kind;
DEFINE INDEX memos_kind_active      ON memos FIELDS kind, last_active;
DEFINE INDEX memos_kind_derived     ON memos FIELDS kind, derived_at;
DEFINE INDEX memos_kind_scope_active ON memos FIELDS kind, scope, last_active;
DEFINE INDEX memos_chash            ON memos FIELDS content_hash;
DEFINE INDEX memos_scope            ON memos FIELDS scope;
DEFINE INDEX memos_tags             ON memos FIELDS tags;
DEFINE INDEX memos_habit_name       ON memos FIELDS kind, meta.name;
DEFINE INDEX memos_prediction_open  ON memos FIELDS kind, meta.resolved_at;
DEFINE INDEX memos_prediction_kind  ON memos FIELDS kind, meta.statement_kind;

-- entities: graph nouns
DEFINE TABLE entities SCHEMAFULL TYPE NORMAL;
DEFINE FIELD name        ON entities TYPE string ASSERT string::len($value) > 0;
DEFINE FIELD name_lower  ON entities TYPE string VALUE string::lowercase(name) READONLY;
DEFINE FIELD type        ON entities TYPE string;                         -- OPEN; 'person'|'place'|'project'|'topic'|'thing'|<future>
DEFINE FIELD scope       ON entities TYPE string DEFAULT 'global';
DEFINE FIELD tags        ON entities TYPE array<string> DEFAULT [];
DEFINE FIELD created_at  ON entities TYPE datetime DEFAULT time::now() READONLY;
DEFINE FIELD meta        ON entities TYPE option<object> FLEXIBLE;
DEFINE INDEX entities_name_lower    ON entities FIELDS name_lower, type;
DEFINE INDEX entities_scope         ON entities FIELDS scope;
DEFINE INDEX entities_tags          ON entities FIELDS tags;

-- episodes: narrative containers
DEFINE TABLE episodes SCHEMAFULL TYPE NORMAL;
DEFINE FIELD started_at  ON episodes TYPE datetime DEFAULT time::now() READONLY;
DEFINE FIELD ended_at    ON episodes TYPE option<datetime>;
DEFINE FIELD source      ON episodes TYPE string;
DEFINE FIELD scope       ON episodes TYPE string DEFAULT 'global';
DEFINE FIELD summary     ON episodes TYPE option<string>;
DEFINE FIELD meta        ON episodes TYPE option<object> FLEXIBLE;
DEFINE INDEX episodes_started   ON episodes FIELDS started_at;
DEFINE INDEX episodes_source    ON episodes FIELDS source;
DEFINE INDEX episodes_active    ON episodes FIELDS source, ended_at;
DEFINE INDEX episodes_scope     ON episodes FIELDS scope;
```

### 4.2 — Edges

```surql
DEFINE TABLE edges SCHEMAFULL TYPE NORMAL;
DEFINE FIELD kind         ON edges TYPE string;                            -- OPEN; registry-enforced
DEFINE FIELD from         ON edges TYPE record;
DEFINE FIELD to           ON edges TYPE record;
DEFINE FIELD weight       ON edges TYPE option<float>;
DEFINE FIELD last_seen    ON edges TYPE option<datetime>;
DEFINE FIELD valid_from   ON edges TYPE option<datetime>;
DEFINE FIELD valid_until  ON edges TYPE option<datetime>;
DEFINE FIELD context      ON edges TYPE option<string>;
DEFINE FIELD created_at   ON edges TYPE datetime DEFAULT time::now() READONLY;
DEFINE FIELD meta         ON edges TYPE option<object> FLEXIBLE;
DEFINE INDEX edges_kind_from   ON edges FIELDS kind, from;
DEFINE INDEX edges_kind_to     ON edges FIELDS kind, to;
DEFINE INDEX edges_kind_valid  ON edges FIELDS kind, valid_from, valid_until;
```

Record IDs are deterministic composites: `edges:[kind, from_id, to_id]`. UPSERTs are idempotent. For symmetric kinds (`occurs_with`, `contradicts`), the registry tells `store.relate()` to canonicalize `from_id < to_id` before computing the ID.

**Why `TYPE NORMAL` with `from`/`to` fields, not `TYPE RELATION` with `in`/`out`:** SurrealDB v3 rejects composite-ID `CREATE` against `TYPE RELATION` tables ("expected a RELATION"); composite IDs require `TYPE NORMAL`. Composite IDs are load-bearing (idempotent `occurs_with` counter UPSERTs, deterministic re-runs from biographer). The cost: graph-arrow traversal (`->edges->entities`) is unavailable. Mitigation: every query path uses explicit indexed `SELECT ... WHERE kind = X AND from = $id` or `WHERE kind = X AND to = $id` — the `edges_kind_from` / `edges_kind_to` indexes match. Verified empirically against SurrealDB v3.0.5 (see `scripts/test-edge-relation.mjs`, removed after verification).

**Initial edge kinds (registry):**

| Kind | From | To | Properties | Semantics |
|---|---|---|---|---|
| `mentions` | events, memos | entities | weight (0..1) | Weak/incidental reference |
| `about` | events, memos | entities | — | Strong/primary subject |
| `before` | events | events | — | Temporal ordering |
| `works_on` | entities | entities | valid_from, valid_until | Person → project/topic |
| `participates_in` | entities | entities, episodes | valid_from, valid_until | Person → event/episode |
| `occurs_with` | entities | entities | weight (counter), symmetric | Co-occurrence |
| `derived_from` | memos | events, episodes, memos, entities | — | Provenance (recursive) |
| `supersedes` | memos | memos | — | New replaces old |
| `contradicts` | memos | memos | symmetric | Both visible, flagged |

### 4.3 — Cascade-on-delete (table events)

```surql
DEFINE EVENT cascade_edges_events    ON events    WHEN $event = "DELETE"
  THEN { DELETE edges WHERE from = $before.id OR to = $before.id; };
DEFINE EVENT cascade_edges_entities  ON entities  WHEN $event = "DELETE"
  THEN { DELETE edges WHERE from = $before.id OR to = $before.id; };
DEFINE EVENT cascade_edges_memos     ON memos     WHEN $event = "DELETE"
  THEN { DELETE edges WHERE from = $before.id OR to = $before.id; };
DEFINE EVENT cascade_edges_episodes  ON episodes  WHEN $event = "DELETE"
  THEN { DELETE edges WHERE from = $before.id OR to = $before.id; };
```

A boot-time verification gate confirms transactional behavior on the active SurrealDB v3 build; fallback (if best-effort only) is an explicit `store.deleteWithEdges(id)` wrapper used by every delete path plus a nightly orphan-edge sweeper.

### 4.4 — Embeddings (separable, per-surface, per-profile)

For each active embedder profile, three tables:

```surql
-- example for profile 'gemini-3072'
DEFINE TABLE embeddings_gemini_3072_events SCHEMAFULL TYPE NORMAL;
DEFINE FIELD record  ON embeddings_gemini_3072_events TYPE record<events>;
DEFINE FIELD vector  ON embeddings_gemini_3072_events TYPE array<float>
  ASSERT array::len($value) = 3072;
DEFINE FIELD ts      ON embeddings_gemini_3072_events TYPE datetime DEFAULT time::now();
DEFINE INDEX embeddings_gemini_3072_events_record ON embeddings_gemini_3072_events FIELDS record UNIQUE;
DEFINE INDEX embeddings_gemini_3072_events_vec    ON embeddings_gemini_3072_events FIELDS vector
  HNSW DIMENSION 3072 DIST COSINE TYPE F32 EFC 200 M 16;

-- mirror for _memos and _entities (record types differ; same shape)
```

Profile name format: `<model>_<dim>` (e.g. `gemini_3072`, `mxbai_1024`, `qwen3_4096`). Embedding-table names are derived deterministically from `(profile, surface)` and matched via a strict regex `^[a-z0-9_]+$`.

### 4.5 — `fn::freshness` SurrealQL function

```surql
DEFINE FUNCTION fn::freshness($memo: record<memos>) {
  LET $m = $memo.*;
  LET $superseded = (
    SELECT count() FROM edges
    WHERE kind = 'supersedes' AND to = $memo
  )[0].count ?? 0;
  IF $superseded > 0 RETURN 0;
  LET $half_life_ms = IF $m.kind = 'knowledge' { 15552000000 }       -- 180d
                     ELSE IF $m.kind = 'habit' { 5184000000 }         -- 60d
                     ELSE IF $m.kind = 'thread' { 2592000000 }        -- 30d
                     ELSE IF $m.kind = 'prediction' { 31536000000 }   -- 365d
                     ELSE { 7776000000 };                              -- 90d default
  LET $age_ms = (time::now() - $m.decay_anchor) / 1ms;
  LET $decay = math::pow(0.5, $age_ms / $half_life_ms);
  LET $reinforced = math::log(1 + $m.signal_count, 2);
  RETURN math::min([1.0, $m.confidence * $decay * $reinforced]);
};
```

Lets recall do `ORDER BY fn::freshness(memo) DESC` server-side instead of fetching and ranking in Node.

### 4.6 — Operational tables

```surql
-- persona: singleton row at persona:singleton (was: 'profile' table)
DEFINE TABLE persona SCHEMAFULL TYPE NORMAL;
DEFINE FIELD name           ON persona TYPE option<string>;
DEFINE FIELD display_name   ON persona TYPE option<string>;
DEFINE FIELD pronouns       ON persona TYPE option<string>;
DEFINE FIELD timezone       ON persona TYPE option<string>;
DEFINE FIELD interests      ON persona TYPE option<array<string>>;
DEFINE FIELD comm_style     ON persona TYPE option<object> FLEXIBLE;
DEFINE FIELD calibration    ON persona TYPE option<object> FLEXIBLE;
DEFINE FIELD updated_at     ON persona TYPE datetime VALUE time::now();
DEFINE FIELD meta           ON persona TYPE option<object> FLEXIBLE;

-- runtime: KV singleton; one row per system-state key
DEFINE TABLE runtime SCHEMAFULL TYPE NORMAL;
DEFINE FIELD value       ON runtime TYPE object FLEXIBLE;
DEFINE FIELD updated_at  ON runtime TYPE datetime VALUE time::now();

-- runtime_sessions: host session registry
DEFINE TABLE runtime_sessions SCHEMAFULL TYPE NORMAL;
DEFINE FIELD session_id      ON runtime_sessions TYPE string;
DEFINE FIELD host            ON runtime_sessions TYPE string;
DEFINE FIELD pid             ON runtime_sessions TYPE option<int>;
DEFINE FIELD transcript_path ON runtime_sessions TYPE option<string>;
DEFINE FIELD started_at      ON runtime_sessions TYPE datetime DEFAULT time::now() READONLY;
DEFINE FIELD last_seen_at    ON runtime_sessions TYPE datetime DEFAULT time::now();
DEFINE FIELD status          ON runtime_sessions TYPE string DEFAULT 'active';
DEFINE INDEX runtime_sessions_status  ON runtime_sessions FIELDS status;
DEFINE INDEX runtime_sessions_session ON runtime_sessions FIELDS session_id UNIQUE;

-- runtime_jobs: cron-driven job state (unchanged from migration 0011)
DEFINE TABLE runtime_jobs SCHEMAFULL;
DEFINE FIELD name              ON runtime_jobs TYPE string;
DEFINE FIELD enabled           ON runtime_jobs TYPE bool;
DEFINE FIELD schedule          ON runtime_jobs TYPE string;
DEFINE FIELD runtime           ON runtime_jobs TYPE string;
DEFINE FIELD catch_up          ON runtime_jobs TYPE bool;
DEFINE FIELD notify            ON runtime_jobs TYPE string;
DEFINE FIELD notify_on_failure ON runtime_jobs TYPE bool;
DEFINE FIELD timeout_minutes   ON runtime_jobs TYPE int;
DEFINE FIELD manually_runnable ON runtime_jobs TYPE bool DEFAULT true;
DEFINE FIELD last_run_at       ON runtime_jobs TYPE option<datetime>;
DEFINE FIELD last_run_ok       ON runtime_jobs TYPE option<bool>;
DEFINE FIELD last_error        ON runtime_jobs TYPE option<string>;
DEFINE FIELD last_duration_ms  ON runtime_jobs TYPE option<int>;
DEFINE FIELD next_run_at       ON runtime_jobs TYPE option<datetime>;
DEFINE FIELD consecutive_failures ON runtime_jobs TYPE int DEFAULT 0;
DEFINE FIELD in_flight         ON runtime_jobs TYPE bool DEFAULT false;
DEFINE FIELD updated_at        ON runtime_jobs TYPE datetime DEFAULT time::now();
DEFINE INDEX runtime_jobs_name ON runtime_jobs FIELDS name UNIQUE;

-- intuition_telemetry: append-only per-fire (renamed from runtime_intuition_telemetry)
DEFINE TABLE intuition_telemetry SCHEMAFULL TYPE NORMAL;
DEFINE FIELD ts              ON intuition_telemetry TYPE datetime DEFAULT time::now() READONLY;
DEFINE FIELD query_chars     ON intuition_telemetry TYPE int;
DEFINE FIELD hits            ON intuition_telemetry TYPE int;
DEFINE FIELD tokens_injected ON intuition_telemetry TYPE int;
DEFINE FIELD latency_ms      ON intuition_telemetry TYPE int;
DEFINE FIELD truncated       ON intuition_telemetry TYPE bool DEFAULT false;
DEFINE INDEX intuition_telemetry_ts ON intuition_telemetry FIELDS ts;

-- recall_log: query→hits, used by reinforcement loop and future reranker (was: recall_events)
DEFINE TABLE recall_log SCHEMAFULL TYPE NORMAL;
DEFINE FIELD ts            ON recall_log TYPE datetime DEFAULT time::now() READONLY;
DEFINE FIELD session_id    ON recall_log TYPE option<string>;
DEFINE FIELD query         ON recall_log TYPE string;
DEFINE FIELD k             ON recall_log TYPE int;
DEFINE FIELD ranked_hits   ON recall_log TYPE array<object>;             -- [{ memo_id|event_id, score_components, rank }]
DEFINE FIELD outcome       ON recall_log TYPE string DEFAULT 'pending';  -- 'pending'|'reinforced'|'corrected'|'evaluated_no_signal'
DEFINE FIELD evaluated_at  ON recall_log TYPE option<datetime>;
DEFINE FIELD meta          ON recall_log TYPE option<object> FLEXIBLE;
DEFINE INDEX recall_log_ts        ON recall_log FIELDS ts;
DEFINE INDEX recall_log_outcome   ON recall_log FIELDS outcome;
DEFINE INDEX recall_log_session   ON recall_log FIELDS session_id;

-- refusals: discretion log (unchanged shape)
DEFINE TABLE refusals SCHEMAFULL TYPE NORMAL;
DEFINE FIELD direction   ON refusals TYPE string DEFAULT 'outbound';
DEFINE FIELD content     ON refusals TYPE string;
DEFINE FIELD reason      ON refusals TYPE string;
DEFINE FIELD tool        ON refusals TYPE option<string>;
DEFINE FIELD created_at  ON refusals TYPE datetime DEFAULT time::now() READONLY;
DEFINE FIELD meta        ON refusals TYPE option<object> FLEXIBLE;
DEFINE INDEX refusals_direction  ON refusals FIELDS direction;
DEFINE INDEX refusals_created    ON refusals FIELDS created_at;

-- action_trust: per-(tool, action_template) policy ledger (unchanged)
DEFINE TABLE action_trust SCHEMAFULL;
DEFINE FIELD class            ON action_trust TYPE string;
DEFINE FIELD state            ON action_trust TYPE string;
DEFINE FIELD set_by           ON action_trust TYPE string;
DEFINE FIELD success_count    ON action_trust TYPE int DEFAULT 0;
DEFINE FIELD correction_count ON action_trust TYPE int DEFAULT 0;
DEFINE FIELD last_used_at     ON action_trust TYPE option<datetime>;
DEFINE FIELD last_state_change_at ON action_trust TYPE datetime DEFAULT time::now();
DEFINE FIELD updated_at       ON action_trust TYPE datetime VALUE time::now();
DEFINE INDEX action_trust_class ON action_trust FIELDS class UNIQUE;

-- rule_candidates, rules: reflection workflow (unchanged shape)
DEFINE TABLE rule_candidates SCHEMAFULL TYPE NORMAL;
DEFINE FIELD content          ON rule_candidates TYPE string;
DEFINE FIELD kind             ON rule_candidates TYPE string;            -- 'behavior'|'profile_update'|'conflict_warning'|'reinforce_behavior'
DEFINE FIELD signal_events    ON rule_candidates TYPE array<record<events>>;
DEFINE FIELD payload          ON rule_candidates TYPE option<object> FLEXIBLE;
DEFINE FIELD confidence       ON rule_candidates TYPE float;
DEFINE FIELD status           ON rule_candidates TYPE string;            -- 'pending'|'approved'|'rejected'|'expired'
DEFINE FIELD created_at       ON rule_candidates TYPE datetime DEFAULT time::now() READONLY;
DEFINE FIELD reviewed_at      ON rule_candidates TYPE option<datetime>;
DEFINE FIELD rejected_reason  ON rule_candidates TYPE option<string>;
DEFINE INDEX rule_candidates_status  ON rule_candidates FIELDS status;
DEFINE INDEX rule_candidates_created ON rule_candidates FIELDS created_at;

DEFINE TABLE rules SCHEMAFULL TYPE NORMAL;
DEFINE FIELD content          ON rules TYPE string;
DEFINE FIELD kind             ON rules TYPE string;
DEFINE FIELD payload          ON rules TYPE option<object> FLEXIBLE;
DEFINE FIELD source_candidate ON rules TYPE option<record<rule_candidates>>;
DEFINE FIELD priority         ON rules TYPE int DEFAULT 50;
DEFINE FIELD active           ON rules TYPE bool DEFAULT true;
DEFINE FIELD created_at       ON rules TYPE datetime DEFAULT time::now() READONLY;
DEFINE FIELD updated_at       ON rules TYPE datetime VALUE time::now();
DEFINE FIELD meta             ON rules TYPE option<object> FLEXIBLE;
DEFINE INDEX rules_active     ON rules FIELDS active, priority;

-- _migrations: bookkeeping (unchanged)
DEFINE TABLE _migrations SCHEMAFULL TYPE NORMAL;
DEFINE FIELD version    ON _migrations TYPE int;
DEFINE FIELD name       ON _migrations TYPE string;
DEFINE FIELD checksum   ON _migrations TYPE string;
DEFINE FIELD applied_at ON _migrations TYPE datetime DEFAULT time::now() READONLY;
DEFINE INDEX _migrations_version ON _migrations FIELDS version UNIQUE;
```

### 4.7 — Schema reset

All 14 existing migrations (`0001-init.surql` … `0014-predictions.surql` plus the three `0008-*` embedder variants) are **deleted** and replaced by one new `0001-init.surql` containing everything above. The migration runner (`src/db/migrate.js`) is unchanged: tar-backup before apply, sequential version tracking via `_migrations`. On first run, any existing DB is backed up and replaced.

---

## 5. Memory layer code structure

```
src/memory/
├── store.js              ← write/read/relate primitives; the only writer to memos/edges
├── decay.js              ← freshness() JS mirror of fn::freshness for in-Node ranking
├── kind-registry.js      ← MEMO_KIND_REGISTRY + ATTACHMENT_KIND_REGISTRY (+ re-export of EDGE_KIND_REGISTRY)
├── edge-registry.js      ← EDGE_KIND_REGISTRY + relate / neighbors helpers
├── scopes.js             ← SCOPE constants for project/session/integration/temp/private/global
│
├── attention.js          ← active episodes + recent events (was hot.js)
├── chronicle.js          ← biographed-event chronology (was journal.js)
├── knowledge.js          ← memos[kind=knowledge] lens (kept name)
├── habits.js             ← memos[kind=habit] lens (was patterns.js)
├── persona.js            ← persona singleton (was profile.js)
├── narrative.js          ← memos[kind=thread] lens (was threads.js)
└── foresight.js          ← memos[kind=prediction] lens (consolidates predictions CLI helpers)
```

### 5.1 — `store.js` API

```js
// Write
remember(db, embedder, { source, content, trust?, scope?, tags?, attachments?, meta? })
  → { id, deduped }                       // captures an event; writes embedding into events surface

note(db, embedder, kind, { content, subjects?, confidence?, scope?, tags?, lineage?, derived_by, meta? })
  → { id, deduped }                       // creates a memo; subjects→`about` edges; lineage→`derived_from` edges; writes embedding into memos surface

upsertEntity(db, embedder, { name, type, scope?, tags?, meta? })
  → { id, created }                       // existing 3-stage cascade (exact→embedding→LLM); writes embedding into entities surface

upsertMemoByName(db, embedder, kind, { name, content, derived_by, lineage?, meta? })
  → { id, signal_increment }              // habit-pattern primitive: match on (kind, meta.name); increment signal_count

relate(db, from, to, kind, { weight?, valid_from?, valid_until?, context?, meta? })
  → { id }                                // registry-validated; self-loop rejected; symmetric kinds canonicalize endpoints; composite ID UPSERT (MERGE or counter-SET)

relateAll(db, rows[])                     // bulk variant used by biographer for batched edge emission
  → { ids[] }

supersede(db, oldId, newId)
  → { superseded: oldId, by: newId }      // adds supersedes edge; fn::freshness returns 0 for oldId thereafter

flagContradiction(db, idA, idB, { context })
  → { id }                                // symmetric contradicts edge; both memos visible, recall penalizes

// Read
getMemo(db, id)
  → row with subjects[] / lineage[] / contradictions[] / freshness hydrated

searchMemos(db, embedder, query, { kind?, scope?, scopes?, tags?, since?, limit })
  → { hits: [{ memo, distance, score_components, rank }] }

searchEvents(db, embedder, query, { source?, scope?, since?, until?, limit })
  → { hits: […] }

searchEntities(db, embedder, query, { type?, scope?, limit })
  → { hits: […] }

listMemos(db, { kind, scope?, since?, until?, limit })
neighbors(db, recordId, kind, { limit, direction?: 'in'|'out'|'both' })
```

### 5.2 — `kind-registry.js`

```js
export const MEMO_KIND_REGISTRY = {
  knowledge:  { required: ['content','derived_by'], dedup_by: 'content_hash' },
  habit:      { required: ['content','derived_by'],
                meta_schema: { name: 'string!', description: 'string?' } },
  thread:     { required: ['content','derived_by'],
                meta_schema: { title: 'string?', summary: 'string?',
                              episode_ids: 'array?', entity_ids: 'array?' } },
  prediction: { required: ['content','derived_by'],
                meta_schema: {
                  statement_kind: 'string!',
                  expected_resolution_at: 'datetime?',
                  resolved_at: 'datetime?',
                  correct: 'boolean?',
                  actual_outcome: 'string?' } },
};

export const ATTACHMENT_KIND_REGISTRY = {
  file:  { required: ['ref'], optional: ['hash', 'mime', 'size'] },
  image: { required: ['ref'], optional: ['hash', 'mime', 'size', 'alt', 'width', 'height'] },
  audio: { required: ['ref'], optional: ['hash', 'mime', 'size', 'duration_ms'] },
  video: { required: ['ref'], optional: ['hash', 'mime', 'size', 'duration_ms'] },
  url:   { required: ['ref'], optional: ['title', 'description'] },
};
```

### 5.3 — `edge-registry.js`

```js
export const EDGE_KIND_REGISTRY = {
  mentions:        { from: ['events','memos'], to: ['entities'] },
  about:           { from: ['events','memos'], to: ['entities'] },
  before:          { from: ['events'],        to: ['events']   },
  works_on:        { from: ['entities'],      to: ['entities'] },
  participates_in: { from: ['entities'],      to: ['entities','episodes'] },
  occurs_with:     { from: ['entities'],      to: ['entities'], symmetric: true, counter: true },
  derived_from:    { from: ['memos'],         to: ['events','episodes','memos','entities'] },
  supersedes:      { from: ['memos'],         to: ['memos']    },
  contradicts:     { from: ['memos'],         to: ['memos'],    symmetric: true },
};
```

### 5.4 — `scopes.js`

```js
export const SCOPE = {
  GLOBAL: 'global',
  PRIVATE: 'private',
  project: (name) => `project:${name}`,
  session: (id) => `session:${id}`,
  integration: (name) => `integration:${name}`,
  temp: (reason) => `temp:${reason}`,
};

export const EPHEMERAL_SCOPE_PREFIXES = ['session:', 'temp:'];
```

### 5.5 — Faculty lenses (representative)

```js
// knowledge.js
import * as store from './store.js';
export const add = (db, e, input) =>
  store.note(db, e, 'knowledge', { derived_by: input.derived_by ?? 'dream', ...input });
export const search = (db, e, q, opts = {}) =>
  store.searchMemos(db, e, q, { kind: 'knowledge', ...opts });
export const list = (db, opts = {}) =>
  store.listMemos(db, { kind: 'knowledge', ...opts });

// habits.js
import * as store from './store.js';
export const upsert = (db, e, { name, description, lineage, strength = 1.0 }) =>
  store.upsertMemoByName(db, e, 'habit', {
    name, content: description, derived_by: 'dream', lineage,
    meta: { name, description, strength }
  });
export const list = (db, { activeOnly, limit } = {}) =>
  store.listMemos(db, {
    kind: 'habit',
    filter: activeOnly ? { 'meta.strength': { gt: 0 } } : undefined,
    limit
  });

// foresight.js
import * as store from './store.js';
export const predict = (db, e, { statement, statement_kind, confidence, expected_resolution_at }) =>
  store.note(db, e, 'prediction', {
    content: statement, confidence, derived_by: 'manual',
    meta: { statement_kind, expected_resolution_at }
  });
export const resolve = (db, id, { correct, actual_outcome }) =>
  store.updateMemoMeta(db, id, { resolved_at: new Date(), correct, actual_outcome });
export const listOpen = (db, { statement_kind, older_than_days } = {}) =>
  store.listMemos(db, {
    kind: 'prediction',
    filter: {
      'meta.resolved_at': { is: null },
      ...(statement_kind && { 'meta.statement_kind': statement_kind }),
      ...(older_than_days && { derived_at: { lt: cutoff(older_than_days) } })
    }
  });
```

---

## 6. Embedder swap protocol

**State:**

```js
runtime:embedder = {
  value: {
    active_profile: 'gemini_3072',
    read_profile: 'gemini_3072',              // == active in steady state
    available_profiles: ['gemini_3072', 'mxbai_1024'],
    history: [{ profile, activated_at, deactivated_at?, reason? }]
  }
}

runtime:embedder_backfill = {                  // exists only during a backfill
  value: {
    profile: 'mxbai_1024',
    started_at: <ts>,
    cursors: {
      events:   { last_processed_id, count, total_estimated },
      memos:    { ... },
      entities: { ... }
    },
    errors: [{ id, message, ts }],   // last 100
  }
}
```

**Lifecycle:**

1. `robin embeddings prepare --profile mxbai_1024` → `DEFINE TABLE embeddings_mxbai_1024_events|memos|entities ...`.
2. `robin embeddings backfill --profile mxbai_1024` → resumable batch job. Reads cursor, embeds rows in chunks of 200, UPSERTs by deterministic record IDs, advances cursor. Reports progress.
3. (Optional) `robin embeddings dual-read --on --profile mxbai_1024` for a verification window. New captures dual-write; recall stays on the old profile until cutover.
4. `robin embeddings activate mxbai_1024` → atomic `runtime:embedder.value.active_profile = mxbai_1024`. Recall flips.
5. (Later, optional) `robin embeddings drop gemini_3072` → drops the three old tables.

**Daemon startup** reads `runtime:embedder.value.active_profile` and configures the recall path before serving requests.

---

## 7. Recall pipeline

### 7.1 — Query flow

```
intuition / recall MCP / agent ──► store.searchMemos / searchEvents
                                       │
                                       ├─ resolve active profile from runtime:embedder
                                       ├─ embed(query) once
                                       ├─ HNSW kNN on embeddings_<profile>_<surface>
                                       ├─ JOIN back to memos / events / entities
                                       ├─ rank.score() per hit
                                       ├─ MMR-lite diversity pass
                                       ├─ recall_log row written {pending}
                                       └─ return ranked hits
```

### 7.2 — `rank.score()`

```js
score = (
    (1 - distance)                      // cosine similarity 0..1
    * freshness(record)                 // 0..1; 0 if superseded
    * (1 - 0.3 * contradiction_count)   // 0.3 penalty per contradiction (floored at 0.1)
    * trust_factor(derived_by|source)   // manual:1.0, biographer:0.95, dream:0.9, agent-derived:0.85
    * scope_boost(record.scope, query)  // 1.2 if matches caller's session/project, else 1.0
);
```

### 7.3 — MMR-lite diversity

After ranking top-K, suppress any hit whose cosine to a higher-ranked hit > 0.92. Returns a more informative top-list without re-querying.

### 7.4 — Reinforcement loop

**Heartbeat job `reinforce-recall`, schedule `*/5 * * * *`:**

```
for each recall_log row where outcome='pending' AND ts < now - 5min:
  correction = SELECT * FROM events
                WHERE meta.kind = 'correction'
                  AND meta.session_id = $row.session_id
                  AND ts BETWEEN $row.ts AND $row.ts + 5min;
  if correction: row.outcome = 'corrected'
  else if row.ranked_hits.length === 0: row.outcome = 'evaluated_no_signal'
  else:
    for each hit in row.ranked_hits:
      UPDATE hit.record SET signal_count += 1, decay_anchor = now;
    row.outcome = 'reinforced'
  row.evaluated_at = now
```

Useful memos sharpen; noisy memos stay where they are. `recall_log` becomes labeled-ish training data for the future reranker (phase 4e.1).

---

## 8. Capture surfaces

All capture surfaces emit into `events` with consistent fields. Per-surface defaults:

| Surface | `source` | `scope` default | `trust` default | Attachments? |
|---|---|---|---|---|
| Manual `remember` (CLI/MCP) | `manual` | `global` | `trusted` | yes (caller-supplied) |
| Stop-hook conversation capture | `stop_hook` | `session:<id>` | `trusted` | no |
| Integration sync (gmail, calendar, …) | `<integration_name>` | `integration:<name>` | `trusted` (configurable) | yes (when source carries them) |
| Discord inbound | `discord` | `integration:discord` | `untrusted` | optional |
| `ingest` MCP tool (url/file/content) | `ingest` | `global` | `trusted` | yes |
| Biographer correction signals | `manual` + `meta.kind='correction'` | inherits | `trusted` | no |
| Action-outcome events (NEW writer) | `action_outcome` | inherits from caller | `derived` | no |

**New writers wired in this redesign:**
- `action_outcome` events emitted by outbound-tool wrappers (`discord_send`, `github_write`, `spotify_write`) after each call. Schema: `meta: { tool, action, ok, ms, args_summary, error? }`.
- `state_inference` memos emitted by `dream/step-comm-style` when tone-shift > threshold across recent corrections.

**Schema-ready (writer deferred):**
- `kind='reasoning'` memos (Robin's decision trace via a future Stop-hook variant).
- `kind='session_outcome'` memos at session end.
- `source='code_edit'` events for file modifications.
- `events.meta.geo`, `events.tags: ['geo:lat,lng']` for location-aware capture.

---

## 9. Scope semantics + lifecycle

| Scope pattern | Lifetime |
|---|---|
| `global` (default) | persistent; no automatic cleanup |
| `project:<name>` | persistent; cleared by explicit `robin scope drop project:<name>` |
| `integration:<name>` | persistent; tied to integration lifecycle |
| `session:<id>` | **ephemeral**; dream prunes after 7d if no inbound `derived_from` from persistent memos |
| `temp:<reason>` | **ephemeral**; dream prunes after 24h |
| `private` | persistent; outbound discretion always refuses to forward |

**Scope promotion:** dream's `step-scope-cleanup` walks ephemeral memos; any with a `derived_from` edge inbound from a `global` or `project:*` memo is *promoted* to `global` before the prune sweep. Prevents losing facts that turned out to matter.

**Scope filter default:** `store.searchMemos` without an explicit `scopes` excludes ephemeral scopes (`session:*`, `temp:*`). Override with `{ scopes: ['*'] }` for admin queries.

---

## 10. Belief evolution: supersedes and contradicts

- `supersedes` is directed: `new_memo → old_memo`. `fn::freshness` returns 0 for any memo with an inbound `supersedes` edge.
- `contradicts` is symmetric and non-resolving. Both memos visible; recall applies a 0.7 multiplier per contradiction.
- Old memos are never UPDATEd or DELETEd by belief evolution — they remain as historical records, addressable by audit queries (`derived_at <= $t AND id NOT IN (SELECT to FROM edges WHERE kind='supersedes' AND created_at <= $t)`).

---

## 11. Pipeline changes

| Pipeline | Change |
|---|---|
| `capture/biographer.js` | Emits `mentions`/`about` edges (events→entities) and `works_on`/`participates_in`/`occurs_with` (entities→entities) via `store.relateAll([...])`. Also emits `derived_from` from any memo it creates back to source events. |
| `capture/record-event.js` | Routes through `store.remember`. Passes `trust`, `scope`, `tags`, `attachments` through. |
| `capture/ingest` | Writes events with `attachments` for the source artifact. Knowledge emission via `store.note('knowledge', ...)`. |
| `dream/pipeline.js` | Step rename: `step-patterns` → `step-habits`; `step-threads` → `step-narrative`. New step `step-scope-cleanup`. |
| `dream/step-knowledge.js` | Emits `supersedes` when a new knowledge memo contradicts an existing one with higher confidence. Old memo preserved. |
| `dream/step-habits.js` | Uses `habits.upsert` → `store.upsertMemoByName('habit', ...)`. |
| `dream/step-narrative.js` | Uses `narrative.add` → `store.note('thread', { meta: { title, summary, episode_ids, entity_ids } })`. |
| `dream/step-reflection.js` | Unchanged behavior; now also generates `kind='reinforce_behavior'` candidates from positive-signal clusters. |
| `dream/step-comm-style.js` | Call site renames to `persona.updateCommStyle`. Also emits `state_inference` memos on tone shifts. |
| `dream/step-calibration.js` | Call site rename to `persona.updateCalibration`. |
| `dream/step-scope-cleanup.js` | NEW: promotes referenced ephemerals; prunes the rest per §9. |
| `recall/index.js` | Queries `embeddings_<profile>_events` HNSW + JOIN-back to events. |
| `recall/intuition.js` | Composes `searchEvents` + `searchMemos(kind=knowledge)` results, applies `rank.score`, MMR-lite, writes `recall_log` row with `outcome='pending'`. Returns block with contradiction annotations. |
| `outbound/policy.js` (discretion outbound) | After tool call resolution, emits `events` row with `source='action_outcome'` capturing outcome. |
| `graph/cascade.js` | DELETED. Replaced by `DEFINE EVENT cascade_edges_*` SurrealQL triggers. |
| `graph/edges.js` | Becomes a thin wrapper over `store.relate`. |
| MCP tool handlers (`recall`, `remember`, `find_entity`, `ingest`, `predict`, `resolve_prediction`, `list_open_predictions`, `lint`, `audit`, `update_action_policy`, `check_action`, `get_comm_style`, `run_dream`) | Signatures preserved; internals route through new store. `predict`/`resolve_prediction`/`list_open_predictions` go through `foresight.js`. |

---

## 12. Naming sweep

| Old | New | Why |
|---|---|---|
| Table `profile` | Table `persona` | Aligns with `persona.js` module |
| Table `runtime_intuition_telemetry` | `intuition_telemetry` | Drop redundant `runtime_` (specific, not generic KV) |
| Table `recall_events` | `recall_log` | It's a log, not events; reduces overload with `events` substrate |
| Edge kind `precedes` | `before` | Natural language; `<-before<-` = "after" |
| Edge kind `co_occurs_with` | `occurs_with` | User-requested; cleaner |
| Memo kind `pattern` (table) | Memo kind `habit` | Matches `habits.js` |
| Module `hot.js` | `attention.js` | What Robin is attending to now |
| Module `journal.js` | `chronicle.js` | The chronicle of significant events |
| Module `patterns.js` | `habits.js` | Habits (avoiding confusion with `intuition` faculty) |
| Module `profile.js` | `persona.js` | The persona Robin holds of its user |
| Module `threads.js` | `narrative.js` | The user's ongoing narrative |
| (no module) | `foresight.js` | Predictions faculty |
| `MEMO_VALIDATORS` | `MEMO_KIND_REGISTRY` | Mirrors `EDGE_KIND_REGISTRY` |
| `createMemo` (store) | `note` | Verb-natural lens API |
| `captureEvent` (store) | `remember` | Same |
| `markContradict` | `flagContradiction` | More natural English |

**Convention to document (in `docs/architecture.md`):** faculty modules are named for the cognitive *function* (what Robin does); memo kinds are named for the data *shape*. Pairs: `habits.js` ↔ `kind='habit'`; `foresight.js` ↔ `kind='prediction'`; `narrative.js` ↔ `kind='thread'`. The two-name pattern is intentional — code does, data is.

---

## 13. Verification gates (run before plan execution begins)

Scratch script `scripts/verify-design-assumptions.js` runs these in order against a throwaway SurrealDB:

1. **`DEFINE EVENT` transactionality** — DELETE an entity with attached edges in a transaction, ROLLBACK, confirm edges still exist. Then COMMIT, confirm gone.
2. **Composite ID UPSERT idempotence** — `UPSERT edges:['x', a, b] ...` twice; confirm one row.
3. **Field-path index usability** — `EXPLAIN` a query with `WHERE kind='habit' AND meta.name='X'`; confirm `memos_habit_name` is selected.
4. **`fn::freshness` correctness** — create a memo, supersede it, query `fn::freshness`; expect 0. Refresh signal_count; confirm score increases.

If any fails, design adjusts before plan execution.

---

## 14. Test strategy

**Unit tests (new + adapted):**

- `tests/unit/store-remember.test.js`
- `tests/unit/store-note.test.js` — kind validation, dedup by hash, lineage edge emission, multi-subject as `about` edges
- `tests/unit/store-relate.test.js` — registry validation, self-loop rejection, symmetric canonicalization, counter semantics, bulk `relateAll`
- `tests/unit/edge-cascade.test.js` — DELETE endpoint table row → edges gone in tx
- `tests/unit/decay-freshness.test.js` — JS + DB freshness parity; supersedes → 0
- `tests/unit/kind-registry-coverage.test.js` — every kind in production code has a registry entry
- `tests/unit/scope-filter.test.js` — default excludes ephemerals; explicit `scopes:['*']` admin works
- `tests/unit/scope-cleanup.test.js` — promotion of referenced ephemerals; prune of unreferenced
- `tests/unit/rank-score.test.js` — score components compose correctly
- `tests/unit/mmr-diversity.test.js` — duplicates suppressed
- `tests/unit/foresight-resolve.test.js` — meta.resolved_at lifecycle
- `tests/unit/habits-upsert.test.js` — increment signal_count on re-upsert
- `tests/unit/audit-no-old-tables.test.js` — grep for `knowledge`, `patterns`, `threads`, `predictions`, `co_occurs_with`, `precedes`, `runtime_intuition_telemetry`, `recall_events`, `profile` (as table) outside legacy paths

**Integration tests (rewritten):**

- biographer integration → entities + edges + `derived_from` emissions
- dream → knowledge promotion, habit upsert, narrative emission; supersedes when contradicting
- recall → embeddings table JOIN, score components, MMR
- intuition → contradiction annotations, rank applied
- reinforce-recall job → pending recall_log + no correction → memos reinforced
- embeddings backfill → resumable across kill mid-run
- profile swap → prepare/backfill/activate cycle

**Acceptance:** parity or better with pre-existing unit suite (~1067 tests, minus those tied to defunct table names). Integration suite passes end-to-end.

---

## 15. File-by-file change plan

**Created:**

```
src/schema/migrations/0001-init.surql           (new single init)
src/memory/store.js
src/memory/decay.js
src/memory/kind-registry.js
src/memory/edge-registry.js
src/memory/scopes.js
src/memory/attention.js
src/memory/chronicle.js
src/memory/habits.js
src/memory/persona.js
src/memory/narrative.js
src/memory/foresight.js
src/embed/profile-router.js
src/recall/rank.js
src/recall/reinforcement.js
src/jobs/internal/reinforce-recall.js
src/jobs/builtin/reinforce-recall.md
src/jobs/internal/embeddings-backfill.js
src/cli/commands/embeddings.js
src/dream/step-habits.js                        (renamed from step-patterns.js)
src/dream/step-narrative.js                     (renamed from step-threads.js)
src/dream/step-scope-cleanup.js
scripts/verify-design-assumptions.js
```

**Deleted:**

```
src/schema/migrations/0001-init.surql           (old)
src/schema/migrations/0002-pin-embedding-dim.surql
src/schema/migrations/0003-graph-biographer.surql
src/schema/migrations/0004-recall-events.surql
src/schema/migrations/0005-dream-and-memory.surql
src/schema/migrations/0006-integrations.surql
src/schema/migrations/0007-events-source-relax.surql
src/schema/migrations/0008-embedder-gemini-3072.surql
src/schema/migrations/0008-embedder-mxbai-1024.surql
src/schema/migrations/0008-embedder-qwen3-4096.surql
src/schema/migrations/0009-migrator-v1.surql
src/schema/migrations/0010-safety-floor.surql
src/schema/migrations/0011-jobs.surql
src/schema/migrations/0012-action-trust.surql
src/schema/migrations/0013-comm-style.surql
src/schema/migrations/0014-predictions.surql
src/memory/hot.js                               (→ attention.js)
src/memory/journal.js                           (→ chronicle.js)
src/memory/patterns.js                          (→ habits.js)
src/memory/profile.js                           (→ persona.js)
src/memory/threads.js                           (→ narrative.js)
src/graph/cascade.js                            (replaced by DEFINE EVENT triggers)
src/dream/step-patterns.js                      (→ step-habits.js)
src/dream/step-threads.js                       (→ step-narrative.js)
```

**Modified:**

```
src/db/migrate.js                               (no logic change; sees only new 0001)
src/capture/biographer.js                       (writes via store.note + store.relateAll)
src/capture/biographer-output.js
src/capture/record-event.js                     (routes through store.remember)
src/capture/session-capture.js                  (passes scope/tags/attachments)
src/capture/ingest (new helpers)                (uses store.note for knowledge)
src/graph/edges.js                              (wrapper over store.relate)
src/graph/episodes.js                           (unchanged behavior)
src/graph/stage1-exact.js, stage2-embedding.js, stage3-disambig.js (no change)
src/recall/index.js                             (queries embeddings_<profile>_events)
src/recall/intuition.js                         (uses rank.score, MMR, recall_log)
src/dream/pipeline.js                           (step renames + new step)
src/dream/step-knowledge.js                     (emits supersedes)
src/dream/step-reflection.js                    (also generates reinforce_behavior candidates)
src/dream/step-comm-style.js                    (persona.updateCommStyle; state_inference emission)
src/dream/step-calibration.js                   (persona.updateCalibration)
src/embed/factory.js                            (active profile router-aware)
src/embed/backfill.js                           (rewires to embeddings tables)
src/mcp/tool-handlers/* (predict, recall, ingest, find_entity, lint, audit, …) (signatures preserved; route through new modules)
src/cli/commands/predictions.js                 (uses foresight)
src/cli/commands/lint.js                        (single edges table; memos shape)
src/cli/commands/audit.js                       (memos table)
src/outbound/policy.js                          (action_outcome event emission)
src/migrate-v1/README.md                        (mark stale; no rebuild yet)
docs/architecture.md                            (rewrite for new shape)
docs/faculties.md                               (update for renamed modules + new namings)
docs/development.md                             (extending Robin: new kinds, lenses, edges)
docs/troubleshooting.md                         (table name updates)
AGENTS.md                                       (capture/recall surface updates if any agent-facing changes)
README.md                                       (alpha version bump; one-line redesign note)
CHANGELOG.md                                    (new entry)
```

---

## 16. Implementation waves

1. **Wave 1 — Foundation.** New `0001-init.surql`; `src/memory/{store,decay,kind-registry,edge-registry,scopes}.js`; `src/embed/profile-router.js`. Pure additive; existing code untouched. Verification gates run here.
2. **Wave 2 — Faculty lenses.** `attention/chronicle/knowledge/habits/persona/narrative/foresight.js`. Old `hot/journal/knowledge/patterns/profile/threads.js` deleted in this wave.
3. **Wave 3 — Capture rewrites.** `record-event.js`, `biographer.js`, `ingest`, `outbound/policy.js` (action_outcome) route through the new store. Old `graph/cascade.js` deleted.
4. **Wave 4 — Recall + dream + reinforcement.** `recall/{index,intuition,rank,reinforcement}.js`; dream step renames + new step-scope-cleanup; reinforce-recall job.
5. **Wave 5 — MCP + CLI surface.** Tool handlers and CLI commands wired to new modules; predictions consolidated under foresight.
6. **Wave 6 — Embedder lifecycle.** `cli/commands/embeddings.js`; `jobs/internal/embeddings-backfill.js`.
7. **Wave 7 — Tests + docs + cleanup.** Test rewrites, doc rewrites, audit grep tests.

Each wave: subagent-parallelized where files don't overlap; serial when they do. After each wave, full unit suite must pass before proceeding.

---

## 17. Open follow-ups (post-redesign)

- **v1→v2 migrator rewrite** (separate spec, separate sprint).
- **Reranker training (4e.1)** — uses `recall_log` reinforcement outcomes.
- **Knowledge-promotion classifier (4e.2)** — uses reinforcement outcomes + dream's existing promotion decisions.
- **Reasoning-trace capture writer** — Stop-hook variant emitting `kind='reasoning'` memos.
- **Code-edit capture writer** — observes file modifications in Robin sessions, emits `source='code_edit'` events.
- **Session-outcome capture writer** — agent-self-evaluation at session end, emits `kind='session_outcome'` memos.
- **Quota / TTL policies** beyond scope lifecycle (e.g., per-integration cap on integration:* memos).
- **Materialized views** for hot read paths (intuition's top-N, dashboard's today digest), defined via SurrealDB `LIVE SELECT` over base tables.
- **Multi-modal embedders** (CLIP, audio) — plug into the same per-surface, per-profile embedding-table pattern.
