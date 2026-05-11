# Robin v2 — Theme 1b: Episode model expansion + Arcs

**Status:** Design (working draft; impl waits for `feat/surrealdb-improvements` merge)
**Date:** 2026-05-11
**Umbrella:** `2026-05-11-robin-v2-evolution-roadmap.md` (Theme 1b)
**Depends on:** `2026-05-11-surrealdb-improvements-design.md` (post-merge edge field names `in`/`out`, arrow traversal, FTS analyzers)

## Why

Current episodes are *time-and-source bins*: events from the same `source` (e.g. `claude-code`) clustered within `config.episode_window_minutes`. That's a useful low-level container but doesn't match how arcs of activity actually run — across sources, across days, with pauses and resumes.

Specific gaps:

- **No multi-source arcs.** A "chromascope project arc this week" spans Claude Code + Discord + Linear edits. The current model gives three disconnected episodes per session.
- **Episodes aren't recall-targetable.** No FTS / vector index on episode summaries. You can list episodes but not search them.
- **Summaries are set once at close-time only.** Closed too early → bad summary. Long-running episode never closed → no summary.
- **Threads loosely linked.** `kind='thread'` memos carry `meta.episode_ids: []` — discoverable only via memo recall, not first-class.
- **Stale episodes leak.** If biographer never sees a closing signal, `findActiveEpisode` keeps returning the same one indefinitely.

## Goals

- Make multi-episode arcs first-class: a new `arcs` table with its own lifecycle, recall surface, and graph relationships.
- Give episodes incremental summaries at zero LLM cost.
- Make both episodes and arcs recall-targetable via new MCP tools.
- Reliable episode close-out via a heartbeat sweep.
- Dissolve `kind='thread'` memos into arcs cleanly (no v2 users → drop existing thread rows).

## Non-goals

- Hierarchical arcs (`arc_continues: arcs → arcs`) — Jaccard dedup on entity sets covers the common case; revisit if data shows multi-week arcs need explicit chaining.
- Episode-level `precedes` edges — current `episode_id` scalar pointer + temporal `started_at` ordering suffice.
- `continues_after` edges between episodes — deferred; not used by recall in v1.
- Implicit `arc_boost` in `rank.score` — too expensive to compute per-hit; scoped recall is opt-in via MCP only.
- Manual arc creation / editing via MCP (`create_arc`, `update_arc`) — auto-creation suffices for v1.
- Episode names (auto-generated containers stay nameless; the summary is the surface).

## Anchoring decisions

**Why a new `arcs` table, not recursive episodes (`parent_id`):**

- Episodes have an unambiguous identity (one source, one time window). Recursing parent_id means "what level is this episode at?" — a question the biographer would have to answer per-event, costing LLM tokens or hand-crafted heuristics. A separate table keeps episodes simple and adds containers above them.
- Recall is cleaner: `searchArcs` vs `searchEpisodes` are distinct intents. Nested same-table queries would need a `WHERE depth = N` filter on every read.
- Arc lifecycle (active/paused/closed) is different from episode lifecycle (open/closed). Different vocab → different tables.

**Why arcs aren't memos:**

- Memos are propositions ("Kevin works on chromascope"). Arcs are containers of activity ("the chromascope arc Oct–Dec").
- Memos accumulate evidence (`signal_count`, `confidence`); arcs accumulate *membership* (`arc_contains` edges) and *recency* (`last_activity_at`).
- Conflating them forces awkward semantics: what does `signal_count` mean for an arc? Different lifecycle vocab → different table.

**Why the entity-set Jaccard dedup, not embedding similarity:**

- Entity sets are small, discrete, fast to compare. Jaccard on `[entity_id_1, entity_id_2, ...]` is microseconds.
- Embedding similarity on arc summaries would couple arc identity to summary wording, which itself depends on which entities clustered. Indirect.
- Threshold 0.7 means "overlap most of the entity set" — conservative; tuneable.

**Why no implicit recall boost for arc membership:**

- The boost would require recall to chain session → active episode → arc → sibling episodes → per-hit membership check. That's expensive on every recall.
- Scoped recall (`recall_in_arc(arc_id, query)`) puts the cost in the explicit case where it matters.
- Can add the implicit boost later if telemetry shows it's worth the cost.

## Section 1 — Schema additions

```surql
-- arcs: multi-episode containers
DEFINE TABLE arcs SCHEMAFULL TYPE NORMAL;
DEFINE FIELD name             ON arcs TYPE option<string>;            -- LLM-derived from entity cluster
DEFINE FIELD summary           ON arcs TYPE option<string>;
DEFINE FIELD started_at        ON arcs TYPE datetime DEFAULT time::now() READONLY;
DEFINE FIELD last_activity_at  ON arcs TYPE datetime DEFAULT time::now();
DEFINE FIELD ended_at          ON arcs TYPE option<datetime>;
DEFINE FIELD status            ON arcs TYPE string DEFAULT 'active';  -- 'active'|'paused'|'closed'
DEFINE FIELD scope             ON arcs TYPE string DEFAULT 'global';
DEFINE FIELD tags              ON arcs TYPE array<string> DEFAULT [];
DEFINE FIELD entity_ids        ON arcs TYPE array<record<entities>> DEFAULT []; -- for Jaccard dedup
DEFINE FIELD meta              ON arcs TYPE option<object> FLEXIBLE;
DEFINE INDEX arcs_status        ON arcs FIELDS status;
DEFINE INDEX arcs_last_activity ON arcs FIELDS last_activity_at;
DEFINE INDEX arcs_name_fts      ON arcs FIELDS name    FULLTEXT ANALYZER english BM25 HIGHLIGHTS;
DEFINE INDEX arcs_summary_fts   ON arcs FIELDS summary FULLTEXT ANALYZER english BM25 HIGHLIGHTS;

-- per-profile embedding surface for arcs — added to `0002-embeddings-<profile>.surql`
-- alongside the existing events|memos|entities tables (now four surfaces per profile)
DEFINE TABLE embeddings_<profile>_arcs SCHEMAFULL TYPE NORMAL;
DEFINE FIELD record ON embeddings_<profile>_arcs TYPE record<arcs>;
DEFINE FIELD vector ON embeddings_<profile>_arcs TYPE array<float> ASSERT array::len($value) = <dim>;
DEFINE FIELD ts     ON embeddings_<profile>_arcs TYPE datetime DEFAULT time::now();
DEFINE INDEX embeddings_<profile>_arcs_record ON embeddings_<profile>_arcs FIELDS record UNIQUE;
DEFINE INDEX embeddings_<profile>_arcs_vec    ON embeddings_<profile>_arcs FIELDS vector
  HNSW DIMENSION <dim> DIST COSINE TYPE F32 EFC 200 M 16;

-- episodes: small additions
DEFINE FIELD last_event_at ON episodes TYPE option<datetime>;
DEFINE FIELD summary_log   ON episodes TYPE array<string> DEFAULT [];   -- bounded; see §3
DEFINE INDEX episodes_last_event_at ON episodes FIELDS last_event_at;
```

## Section 2 — Edge registry additions

```js
arc_contains: { from: ['arcs'], to: ['episodes'] },
// composite ID edges:[kind, in, out] for idempotence; no counter weight
```

`participates_in` (entity → entity|episodes) extended to allow `arcs`:

```js
participates_in: { from: ['entities'], to: ['entities', 'episodes', 'arcs'] },
```

Additive registry change. No producer of entity → arc edges in v1; the registry extension lets future code emit them without a registry edit.

## Section 3 — Episode lifecycle additions

### 3.1 Per-event biographer updates

After the existing emit-edges path in `src/capture/biographer.js`:

```js
// Update episode tracking fields. No new LLM calls.
const preview = (event.content ?? '').slice(0, 80);
await db.query(surql`
  UPDATE ${episodeId} SET
    last_event_at = ${eventTs},
    summary_log = array::slice(
      array::insert(summary_log, ${preview}, 0),
      0, 20
    )
`).collect();
```

`summary_log` is a bounded LIFO of the most recent 20 event previews. Used by `step-arcs` and `recall_in_episode` for context without re-reading events. Cap (20) lives in `runtime:episode.config.summary_log_size`.

### 3.2 Stale-episode sweep

New heartbeat job `closeStaleEpisodes` (every 10 min):

```surql
UPDATE episodes SET
  ended_at = time::now(),
  status_reason = 'idle_timeout'
WHERE ended_at IS NONE
  AND last_event_at < time::now() - $idle_threshold * 1m;
```

Idle thresholds in `runtime:episode.config`:

```json
{
  "summary_log_size": 20,
  "idle_minutes_by_source": {
    "claude-code": 360,
    "gemini": 360,
    "integration": 1440,
    "default": 720
  }
}
```

Sweep iterates per-source-class to apply different thresholds.

### 3.3 Episode close-out summary

Unchanged from current behavior: biographer's existing close-time LLM judgement writes `episodes.summary`. The `summary_log` array is the cheap incremental view; `summary` is the richer one-line LLM summary at close.

## Section 4 — Arc lifecycle

### 4.1 `runtime:arc.config`

```json
{
  "auto_create_enabled": true,
  "min_episodes": 2,
  "min_shared_entities": 3,
  "dedup_jaccard_threshold": 0.7,
  "pause_after_idle_days": 14,
  "close_after_idle_days": 60,
  "name_derive_from_top_n_entities": 3
}
```

### 4.2 `step-arcs` (renamed from `step-threads`)

Nightly dream step. Idempotent. Reads recently-closed episodes, clusters by shared participating entities, creates or extends arcs.

```
read runtime:arc.config
recently_closed = SELECT FROM episodes WHERE ended_at >= now - 7d
clusters = cluster_by_shared_entities(recently_closed, min=config.min_shared_entities)

for cluster in clusters where cluster.episodes.length >= config.min_episodes:
    entity_ids = cluster.entity_ids
    existing_arcs = SELECT FROM arcs
      WHERE status IN ('active', 'paused')
        AND array::len(array::intersect(entity_ids, $entity_ids)) >= 1
    best_match = max(existing_arcs, key=lambda a: jaccard(a.entity_ids, entity_ids))

    if best_match and jaccard(best_match.entity_ids, entity_ids) >= config.dedup_jaccard_threshold:
        # extend existing arc
        UPDATE best_match SET
          last_activity_at = time::now(),
          status = 'active' IF status='paused' ELSE status,
          entity_ids = array::distinct(array::concat(entity_ids, $entity_ids))
        for ep in cluster.episodes:
            store.relate(best_match.id, ep.id, 'arc_contains')
    else:
        # create new arc
        name = derive_name(cluster.entity_ids[0:config.name_derive_from_top_n_entities])
        summary = LLM_summarize(cluster.episodes.map(ep -> ep.summary))   # one call
        arc_id = CREATE arcs CONTENT { name, summary, entity_ids }
        for ep in cluster.episodes:
            store.relate(arc_id, ep.id, 'arc_contains')
        write embedding to embeddings_<profile>_arcs
```

### 4.3 Arc state transitions

Same `step-arcs` run, after creation/extension:

```surql
UPDATE arcs SET status = 'paused'
  WHERE status = 'active' AND last_activity_at < time::now() - $pause_days * 1d;

UPDATE arcs SET status = 'closed', ended_at = time::now()
  WHERE status = 'paused' AND last_activity_at < time::now() - $close_days * 1d;
```

Reactivation (paused → active) happens implicitly when `step-arcs` extends a paused arc.

### 4.4 Arc archival (Theme 1a hook)

Theme 1a's archive pass gains one eligibility predicate:

```surql
SELECT id FROM arcs
WHERE status = 'closed' AND ended_at < time::now() - 180d
LIMIT $batch;
```

Archive table: `archive_arcs` (mirror of `arcs`). Move arc + outgoing `arc_contains` edges to archive. Episodes referenced by the arc stay in hot tables; the arc's archival doesn't cascade.

## Section 5 — MCP tool surface

**Added:**

- `list_arcs({ status?, limit?, offset? })` — paginated; default ordering by `last_activity_at DESC`.
- `get_arc({ arc_id })` — returns `{ arc, episodes: [...], entities: [...] }`.
- `recall_in_arc({ arc_id, query, limit? })` — hybrid recall (BM25 + vector) restricted to events whose `episode_id` is in the arc's membership.
- `recall_in_episode({ episode_id, query, limit? })` — hybrid recall over events with matching `episode_id`.

**Removed:**

- `list-threads` (replaced by `list_arcs`).

**Unchanged:**

- `list-episodes` (still useful for raw chronicle view).

## Section 6 — Recall helpers in `store.js`

```js
// internal helpers used by MCP tools above
searchArcs(db, embedder, query, { status?, limit })
  → { hits: [{ arc, distance, bm25_score, rank }] }    // hybrid BM25 + vector

searchEpisodes(db, query, { source?, since?, limit })
  → { hits: [...] }                                    // BM25 only in v1
```

`searchArcs` uses the hybrid (BM25 + kNN + RRF) pipeline introduced by `feat/surrealdb-improvements`. `searchEpisodes` is BM25-only in v1: episodes accumulate monotonically (potentially tens of thousands per year), and per-episode embedding costs storage + backfill on every profile swap. BM25 on `summary` covers the typical "find that arc-of-work episode by topic words" case; revisit if telemetry shows lexical-only recall is missing semantic hits.

## Section 7 — Cost envelope

- Per arc creation: **1 LLM call** (summary). Frequency: ~1/day of activity → bounded.
- Per arc dedup check: in-memory Jaccard on entity-id arrays. Microseconds.
- Per arc extension: pure UPDATE; no LLM.
- Per-event biographer cost: **unchanged** (`summary_log` and `last_event_at` updates piggyback on the existing UPDATE-event statement).
- Stale-episode sweep: indexed UPDATE. Microseconds per tick.
- New embedding surface: one embed/upsert per arc creation. Trivial.
- **Total new LLM tokens/day:** ~1 summary-tier call per active cluster. Well within roadmap §4's ±20% envelope.

## Section 8 — Verification gates

1. **Arc auto-creation idempotent:** rerun `step-arcs` on a clean DB → same arcs (entity-set Jaccard match → extend, not duplicate).
2. **Jaccard dedup correct:** synthetic clusters with entity overlap ≥ 0.7 merge into the existing arc; < 0.7 fork.
3. **`arc_contains` composite IDs:** UPSERT same `(arc, episode)` pair twice → one edge row.
4. **Stale episode sweep selective:** fixture with active (`last_event_at = now-1h`) and idle (`last_event_at = now-12h`) → only the idle closes.
5. **Per-source idle thresholds applied:** Claude session at -7h closes; integration episode at -7h does not.
6. **Arc state transitions match thresholds:** synthetic timeline with `last_activity_at` at -10d / -20d / -90d → active / paused / closed.
7. **`recall_in_arc` correctness:** returns only events from member episodes; non-member events excluded.
8. **`recall_in_episode` correctness:** matches exactly the episode's events.
9. **`kind='thread'` rejected** by `MEMO_KIND_REGISTRY` validator (audit grep + runtime test).
10. **Embedding parity:** arc summary embedding matches direct embed of summary text (round-trip).
11. **Cascade-delete safety:** deleting an arc removes `arc_contains` edges; member episodes survive.
12. **Theme 1a archive eligibility:** closed arcs aged > 180d picked up by Theme 1a's archive pass.
13. **`summary_log` boundedness:** episode with 100 events has `array::len(summary_log) == 20`; oldest dropped.
14. **`participates_in` polymorphic registry:** entity → arc edge accepted; entity → memo rejected.

## Section 9 — File-by-file changes

**Created:**

- `src/memory/arcs.js` — `searchArcs`, `getArc`, lifecycle helpers; the only writer to `arcs` and `embeddings_<profile>_arcs`.
- `src/dream/step-arcs.js` — renamed from `step-threads.js`; rewritten to write arcs.
- `src/jobs/internal/close-stale-episodes.js` — heartbeat job impl.
- `src/jobs/builtin/close-stale-episodes.md` — manifest (every 10 min).
- `src/mcp/tools/list-arcs.js`, `get-arc.js`, `recall-in-arc.js`, `recall-in-episode.js`.
- `tests/unit/arcs-lifecycle.test.js`
- `tests/unit/step-arcs-dedup.test.js`
- `tests/unit/close-stale-episodes.test.js`
- `tests/integration/arc-recall.test.js`
- `tests/fixtures/arcs-golden.json`

**Modified:**

- `src/schema/migrations/0001-init.surql` — add arcs table, `embeddings_<profile>_arcs`, episode field additions, `arc_contains` edge support, `participates_in` polymorphic registry update, seed `runtime:arc.config` and `runtime:episode.config`.
- `src/memory/edge-registry.js` — add `arc_contains`; extend `participates_in`.
- `src/memory/kind-registry.js` — remove `thread` kind entry.
- `src/memory/narrative.js` — rewritten to delegate to `arcs.js`; the `add` function now writes arcs, not memos.
- `src/memory/store.js` — add `searchArcs`, `searchEpisodes` helpers; route through hybrid pipeline.
- `src/capture/biographer.js` — per-event `last_event_at` + `summary_log` UPDATE.
- `src/dream/pipeline.js` — replace `step-threads` import with `step-arcs`.
- `src/daemon/server.js` — register new MCP tools; remove `list-threads`.
- `docs/architecture.md` — add §"Arcs" describing the multi-episode container model.
- `docs/faculties.md` — `narrative` lens now manages arcs, not thread memos.

**Deleted:**

- `src/memory/threads-related code remnants` (the legacy aliases from the redesign).
- `src/mcp/tools/list-threads.js`.
- Any `kind='thread'` fixtures in `tests/fixtures/`.

## Section 10 — Sequencing within Theme 1b

1. **Schema additions** — arcs table, embedding surface, episode field additions, registry entries. Additive.
2. **`closeStaleEpisodes` heartbeat job** — orthogonal to arcs; can land independently.
3. **`narrative.js` rewrite + `step-arcs`** — drop `kind='thread'`; auto-creation logic.
4. **MCP tools** — `list_arcs`, `get_arc`, `recall_in_arc`, `recall_in_episode`. Remove `list-threads`.
5. **Recall helpers** — `searchArcs`, `searchEpisodes`.
6. **Tests + verification gates.**

## Section 11 — Dependencies

- **Waits for** `feat/surrealdb-improvements` merge (uses post-merge edge field names `in`/`out`, arrow traversal in `recall_in_arc` membership query, FTS analyzers, hybrid BM25+vector pipeline).
- **Theme 1a interaction (declared here, implemented in Theme 1a):** archive pass extends to closed arcs aged > 180d. `archive_arcs` table follows the same shape pattern as `archive_memos`.

## Section 12 — Open questions (post-impl review)

- **Auto-arc creation grain.** Defaults (≥2 episodes, ≥3 shared entities, Jaccard ≥ 0.7) are first-pass guesses. Validate against real history after 30 days of `step-arcs` runs.
- **Hierarchical arcs.** If post-impl telemetry shows users routinely working on "the chromascope 2026 push" containing multiple multi-week sprints, revisit `arc_continues: arcs → arcs`.

## See also

- `2026-05-11-robin-v2-evolution-roadmap.md` — umbrella.
- `2026-05-11-robin-v2-theme-1a-compaction-design.md` — sibling spec; archive pass extends to arcs.
- `2026-05-11-robin-v2-database-and-memory-redesign-design.md` — episode + thread memo origins.
- `2026-05-11-surrealdb-improvements-design.md` — edge field names, arrow traversal, FTS.
- `docs/architecture.md`, `docs/faculties.md` — to be updated.
