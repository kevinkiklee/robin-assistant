# SurrealDB Improvements — Design

**Status:** approved
**Date:** 2026-05-11
**Branch:** TBD
**Predecessor:** `2026-05-11-robin-v2-database-and-memory-redesign-design.md` (the redesign whose architectural premise this document corrects)

## Why

A read-through of Robin's SurrealDB integration against v3 best practices surfaces one wrong architectural bet plus four orthogonal improvement vectors. No v2 users, no live data — now is the right time to correct.

The wrong bet (from the prior redesign's HANDOFF.md):

> **TYPE NORMAL is incompatible with graph arrows** (`->edges->entities`); composite-ID idempotent UPSERT requires TYPE NORMAL → composite IDs were chosen; explicit `SELECT ... WHERE kind=X AND from=$id` used everywhere.

This premise is incorrect. SurrealDB v3 supports composite array IDs on `TYPE RELATION` tables. The trade-off is illusory. Robin pays the cost everywhere: ~10 dream/biographer/intuition sites write `WHERE kind=X AND from=$id` subqueries instead of arrow traversals, and multi-hop / shortest-path / depth-bounded queries are simply unavailable.

The four improvement vectors:
1. **Graph: TYPE RELATION + arrow traversal** — the keystone correction.
2. **Hybrid retrieval (BM25 + vector + RRF)** — current recall is vector-only and silently drops results when post-kNN filters are selective.
3. **Hot-path batching** — `relateAll`/`getMemo`/`evaluatePending`/capture path do N sequential round-trips that collapse to one each.
4. **Time-travel engine + REFERENCE back-refs + COMPUTED** — `surrealkv+versioned://` gives free historical reads; `REFERENCE` simplifies 1:N pointer queries.

## Goals

- Correct the TYPE NORMAL premise — move edges to `TYPE RELATION` while preserving open-enum kinds and idempotent composite-ID counters.
- Unlock multi-hop, shortest-path, recursive graph traversal in dream and biographer pipelines.
- Lift recall@10 by ≥15% on a golden fixture set via hybrid BM25+vector retrieval with RRF.
- Eliminate the silent post-kNN filter shrinkage; surface retrieval-source telemetry.
- 5-20× reduction in round-trips on the four hot paths: biographer fan-out, `getMemo`, the 5-min reinforcement loop, and `store.remember`/`store.note`.
- Free time-travel reads (`SELECT ... VERSION d'...'`) without writing supersedes edges to encode history.

## Non-goals

- Backward compatibility / migrators. The prior redesign already shipped destructive; same playbook.
- Multi-user / multi-process safety beyond what the embedded engine already provides.
- Replacing the `EDGE_KIND_REGISTRY` with schema-level `TYPE RELATION FROM A TO B ENFORCED` — most kinds have polymorphic endpoint sets and the open-enum philosophy is intentional.
- A second embedder profile or runtime cache layer (separate concerns).

## Section 1 — Edge table redesign (the keystone fix)

`TYPE NORMAL` → `TYPE RELATION` (no FROM/TO clause; preserves open-enum kinds). Rename `from`/`to` → `in`/`out`. Keep composite array IDs `edges:[kind, in, out]` for idempotent UPSERT.

```surql
DEFINE TABLE edges SCHEMAFULL TYPE RELATION;
DEFINE FIELD kind       ON edges TYPE string;
DEFINE FIELD in         ON edges TYPE record;
DEFINE FIELD out        ON edges TYPE record;
DEFINE FIELD weight     ON edges TYPE option<float>;
DEFINE FIELD last_seen  ON edges TYPE option<datetime>;
DEFINE FIELD valid_from ON edges TYPE option<datetime>;
DEFINE FIELD valid_until ON edges TYPE option<datetime>;
DEFINE FIELD context    ON edges TYPE option<string>;
DEFINE FIELD created_at ON edges TYPE datetime DEFAULT time::now() READONLY;
DEFINE FIELD meta       ON edges TYPE option<object> FLEXIBLE;
DEFINE INDEX edges_kind_in     ON edges FIELDS kind, in;
DEFINE INDEX edges_kind_out    ON edges FIELDS kind, out;
DEFINE INDEX edges_kind_valid  ON edges FIELDS kind, valid_from, valid_until;
```

**Honest syntax for a single edges table.** With one generic `edges` table, arrow traversal uses **mid-edge filtering** — `->edges[WHERE kind='X']->target`. Less elegant than `->X->target` would be with per-kind tables, but still a real win and unlocks multi-hop:

```surql
-- Knowledge memos about an entity, projected with the entity name in one query:
SELECT name, <-edges[WHERE kind='about']<-memos.{
  id, content, confidence, derived_at
} AS knowledge
FROM ONLY $entityId;

-- Co-occurring entities with names hydrated (no per-row SELECT):
SELECT in.name AS a, out.name AS b, weight, last_seen
FROM edges
WHERE kind = 'occurs_with' AND last_seen >= $cutoff AND weight >= $min
ORDER BY weight DESC LIMIT 10;

-- Multi-hop, depth-bounded:
SELECT VALUE @ FROM $entity.{1..2}->edges[WHERE kind IN ['occurs_with','works_on']]->entities;

-- Shortest co-occurrence path:
SELECT * FROM $a.{..+shortest=$b}->edges[WHERE kind='occurs_with']->entities;

-- All memos transitively derived from an event:
SELECT VALUE @ FROM $eventId.{..+collect}<-edges[WHERE kind='derived_from']<-memos;
```

**Counter upsert pattern unchanged** — composite-ID UPSERT is still the right primitive for idempotent counters; `RELATE` is create-only and doesn't idempotently increment:

```js
UPSERT type::record('edges', [$kind, $in, $out])
  SET kind=$kind, in=$in, out=$out, weight += 1, last_seen=time::now();
```

**JS API impact.** Public signatures of `store.relate`, `store.relateAll`, `store.neighbors`, `store.supersede`, `store.flagContradiction`, etc. remain. Internals rename `from`/`to` → `in`/`out` in:
- `src/memory/store.js` (UPSERT body, `_surfaceSearch` filter SQL, `getMemo` hydration)
- `src/memory/edge-registry.js` (`EDGE_KIND_REGISTRY` keys, `canonicalEndpoints`)
- `src/memory/attention.js` (edge SELECT replaced with arrow projection)
- `src/dream/{step-knowledge,step-patterns,step-threads,step-scope-cleanup}.js`
- `src/recall/reinforcement.js` (converges `hit.memo_id ?? hit.event_id ?? hit.record_id ?? hit.record` mess to single `hit.record` field)
- `src/mcp/tools/{recall,get-entity,related-entities,ingest,find-entity,lint,audit}.js`
- `src/jobs/{ingest-prompt,lint-checks}.js`, `src/jobs/internal/reinforce-recall.js`
- `src/capture/biographer{,-output,-prompt}.js`
- `src/graph/edges.js` (wrapper; signatures unchanged externally)
- `src/cli/commands/ingest.js`
- `scripts/verify-design-assumptions.js`, `scripts/verify-hnsw-plan.mjs`
- Tests: ~14 files (`tests/unit/edges-*.test.js`, `tests/unit/lint-checks.test.js`, `tests/integration/biographer-pipeline.test.js`, plus ~10 others surfaced during refactor)

**Cascade-event triggers** stay (`DEFINE EVENT WHEN $event = "DELETE"` works on RELATION tables); trigger bodies updated to reference `in`/`out`.

## Section 2 — Hybrid retrieval (BM25 + vector + RRF)

**Problems fixed:**
1. `_surfaceSearch` does kNN with `K = limit`, then post-filters by `kind`/`scope`/`tags`/`since`. A 30%-selective filter delivers ~3 hits when 10 were requested. No expansion, no telemetry.
2. Vector-only recall misses lexical hits. "Pizza yesterday" doesn't always embed near events that contain the literal word "pizza."

**Schema additions:**

```surql
DEFINE ANALYZER english TOKENIZERS class FILTERS lowercase, ascii, snowball(english);

DEFINE INDEX events_content_fts ON events FIELDS content
  FULLTEXT ANALYZER english BM25 HIGHLIGHTS;
DEFINE INDEX memos_content_fts ON memos FIELDS content
  FULLTEXT ANALYZER english BM25 HIGHLIGHTS;
DEFINE INDEX entities_name_fts ON entities FIELDS name
  FULLTEXT ANALYZER english BM25 HIGHLIGHTS;
```

**Recall pipeline shape:**

```js
async function _surfaceSearch(db, embedder, surface, query, opts) {
  const limit = opts.limit ?? 10;

  // Adaptive over-fetch: per-filter multiplier from runtime:recall.config.
  const filterCount = countActiveFilters(opts);
  const cfg = await getRecallConfig(db);
  const knnK = Math.min(100, Math.ceil(limit * (cfg.knn_overfetch_base + filterCount * cfg.knn_overfetch_per_filter)));
  const ef = Math.max(64, knnK * 4);

  // kNN and BM25 in parallel; both apply identical post-filters.
  const [knn, bm25] = await Promise.all([
    _knnRetrieve(db, surface, query, knnK, ef, opts),
    _bm25Retrieve(db, surface, query, knnK, opts).catch(() => []),  // FTS fail-soft
  ]);

  // RRF, then pad missing distances (BM25-only hits get 0.5), then MMR-lite dedup.
  const fused = rrfFuse([knn, bm25], { k: cfg.rrf_k });
  const padded = padDistances(fused);
  const deduped = mmrLite(padded, (a,b) => substringOverlap(a.content, b.content), cfg.mmr_threshold);

  return {
    hits: deduped.slice(0, limit),
    debug: { knn_n: knn.length, bm25_n: bm25.length, fused_n: fused.length },
  };
}
```

**BM25 query with index hint** (planner could otherwise pick the kind index over FTS on a narrow filter):

```surql
SELECT id, content, kind, scope, search::score(0) AS bm25_score
FROM memos WITH INDEX memos_content_fts
WHERE content @0@ $query
  AND kind = $kind
  AND scope IN $scopes
ORDER BY bm25_score DESC
LIMIT $k;
```

**RRF + distance padding:**

```js
function rrfFuse(rankings, { k = 60 } = {}) {
  const scores = new Map();
  for (const list of rankings) {
    list.forEach((hit, rank) => {
      const id = String(hit.id);
      const cur = scores.get(id) ?? { record: hit, rrf: 0, sources: new Set() };
      cur.rrf += 1 / (k + rank);
      cur.sources.add(hit._source);
      scores.set(id, cur);
    });
  }
  return [...scores.values()]
    .sort((a, b) => b.rrf - a.rrf)
    .map((s) => ({ ...s.record, _rrf: s.rrf, _sources: [...s.sources] }));
}

function padDistances(fused) {
  // BM25-only hits get distance=0.5 → cosineSim=0.5 (neutral pad).
  // Re-embedding to recompute true cosine costs another embed call per recall
  // (intuition path runs on every UserPromptSubmit). Padding is the defensible
  // cheap choice; _sources telemetry surfaces how often this matters.
  return fused.map((h) => ({ ...h, distance: h.distance ?? 0.5 }));
}
```

**Tuning surface (`runtime:recall.config` KV row):**
```json
{
  "rrf_k": 60,
  "knn_overfetch_base": 1.5,
  "knn_overfetch_per_filter": 1.5,
  "mmr_threshold": 0.92
}
```

**Analyzer caveat.** `snowball(english)` aggressively stems English; for code/identifier-heavy content (paths, JSON keys) tokenization is lossy. Vector still catches what FTS misses. Known limitation, revisit if telemetry shows identifier queries underperform.

**Success metric.** `scripts/bench-recall.mjs` (new) seeds a golden fixture set (~30 query→expected-hit pairs spanning lexical, semantic, and mixed cases) and reports hybrid recall@10 vs. vector-only. Target: ≥15% lift, p95 latency delta ≤ +30ms.

**Telemetry additions to `intuition_telemetry`:** `knn_n`, `bm25_n`, `fused_n`, `bm25_only_in_top_k`, `filter_count`, `knnK_used`.

**Privacy.** `_sources` is recorded to `recall_log` only; **stripped from the MCP `recall` tool's agent-facing payload**.

## Section 3 — Hot-path batching

Five hot paths collapse from N sequential round-trips to one each.

### 3a. `relateAll` — biographer fan-out

Build one multi-statement query wrapped in `BEGIN/COMMIT`. Use `.responses()` for per-statement structured results. Chunk at 50 edges so pathological inputs don't blow parser limits.

### 3b. `getMemo` — 4 → 1 round-trip

```surql
LET $m = (SELECT *, fn::freshness(id) AS freshness FROM $id);
LET $subj = (SELECT VALUE out FROM edges WHERE kind='about' AND in=$id);
LET $line = (SELECT VALUE out FROM edges WHERE kind='derived_from' AND in=$id);
LET $contra = (SELECT count() AS n FROM edges WHERE kind='contradicts' AND (in=$id OR out=$id) GROUP ALL);
RETURN { memo: $m[0] ?? NONE, subjects: $subj, lineage: $line, contradictions: $contra[0].n ?? 0 };
```

### 3c. `evaluatePending` — N+1 explosion in reinforcement

Three changes:

1. **One pre-fetch for all correction events in the union window.** Requires new field-path index `events_meta_kind` on `meta.kind`.
2. **Bucket reinforcement by hit-count.** Memos recalled in N pending rows must increment by N, not 1. Build `Map<memoId, count>`, group by count, issue one UPDATE per distinct count value (typically 1-3 distinct counts).
3. **One UPDATE per outcome bucket on `recall_log`** (`reinforced` / `corrected` / `evaluated_no_signal`).

~1200 queries → ~7-9. Not transaction-wrapped (partial reinforcement is recoverable on the next tick).

### 3d. `step-patterns.js` per-edge name hydration

Subsumed by Section 1's arrow projection: `SELECT in.name AS a, out.name AS b ... FROM edges ...`.

### 3e. `_surfaceSearch` two-step → one round-trip

Combine kNN + hydration as two statements in one query:

```js
const sql = `
  LET $hits = (
    SELECT record, vector::distance::knn() AS dist FROM ${tbl}
    WHERE vector <|$k, $ef|> $qvec
    ORDER BY dist LIMIT $k TIMEOUT 2s
  );
  SELECT *,
    (SELECT VALUE dist FROM $hits WHERE record = $parent.id LIMIT 1)[0] AS dist
  FROM ${surface}
  WHERE id IN $hits.record
    AND kind = $kind AND scope IN $scopes
  ORDER BY dist;
`;
```

### 3f. Capture path (`remember` / `note`) — 3 → 1 round-trip

Embedding vector is computed in JS first; then one multi-statement query handles dedup-SELECT + CREATE + embedding-UPSERT. Skip the embedding UPSERT on the deduped path.

### Verification gates added:
- **Gate 9:** `relateAll(20 rows)` < 50ms on `mem://`.
- **Gate 10:** `getMemo` returns identical hydrated shape vs. current.
- **Gate 11:** `evaluatePending(50 rows × 6 hits)` < 150ms.
- **Gate 12:** Same memo in 3 pending rows → `signal_count` += 3 (regression guard for bucket-by-count fix).
- **Gate 13:** `remember()` issues ≤ 1 DB round-trip (SDK query-count probe).

## Section 4 — Engine + REFERENCE + COMPUTED

### 4a. Engine swap → `surrealkv+versioned://`

```js
await db.connect('surrealkv+versioned://<robinHome>/db/');
```

Unlocks free time-travel reads:
```surql
SELECT * FROM persona:singleton VERSION d'2026-05-04T00:00:00Z';
SELECT * FROM memos WHERE id IN (...) VERSION d'2026-04-01T00:00:00Z';
```

**Disk growth.** Every version is retained by default. Bounded for Robin's write rate (10s/day). Spec acknowledges; future `runtime_jobs.compact-versions` placeholder.

**Engine maturity.** GA in 3.0.5. Risk: low for single-user CLI; corruption = re-init.

**Config:** `<robinHome>/config.json.db.engine = 'surrealkv+versioned'`. `robin doctor` adds an engine-match check.

### 4b. `REFERENCE` back-refs for 1:N scalar pointers

**`ON DELETE` policy chosen per audit semantics:**

```surql
-- Containment pointer; clear on episode delete.
DEFINE FIELD episode_id ON events
  TYPE option<record<episodes>> REFERENCE ON DELETE UNSET;
DEFINE FIELD member_events ON episodes COMPUTED <~events;
-- (renamed from `events` to avoid table/field-name collision)

-- Audit pointers; preserve history when source rows are deleted.
DEFINE FIELD signal_events ON rule_candidates
  TYPE array<record<events>> REFERENCE ON DELETE IGNORE DEFAULT [];
DEFINE FIELD source_candidate ON rules
  TYPE option<record<rule_candidates>> REFERENCE ON DELETE IGNORE;
```

### 4c. `COMPUTED` fields — eyes-open about indexability

COMPUTED fields **cannot be indexed**. So:
- **Keep `name_lower` as `VALUE READONLY`** (it backs `entities_name_lower` index, critical for stage1-exact disambiguation).
- **Add `runtime_jobs.is_overdue` as COMPUTED** (pure field-comparison, ~10 rows, never indexed).
- **Skip `is_superseded` on memos** (per-read subquery cost too high; keep the check in `fn::freshness`).

```surql
DEFINE FIELD is_overdue ON runtime_jobs COMPUTED
  (next_run_at != NONE AND next_run_at < time::now() AND !in_flight AND enabled);
```

**Decision rule:** "Indexed or hot-path scanned" → VALUE-on-write. "Read-rarely, derived purely from same-row fields" → COMPUTED. "Subquery in the expression" → stored function instead.

### Verification gates added:
- **Gate 14:** `SELECT VERSION d'<10 min ago>'` returns prior persona row after intervening UPDATE.
- **Gate 15:** `episodes:X.member_events` equals `WHERE episode_id = episodes:X`.
- **Gate 16:** Deleting an episode unsets `events.episode_id`; deleting an event leaves `rule_candidates.signal_events` intact (back-ref semantics).
- **Gate 17:** `runtime_jobs.is_overdue` correct across (next_run_at past/future/NONE) × (in_flight) × (enabled) matrix.
- **Gate 18:** `entities_name_lower` index still selected for stage1-exact disambiguation.

## Section 5 — Process changes

### 5a. Migration shape (destructive)

`0001-init.surql` rewritten in place. `src/db/migrate.js:53` throws on checksum mismatch — **existing dev DBs must be reset**. This is the load-bearing operator-facing fact.

```bash
# Rollout (headlined with the checksum constraint)
launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/io.robin-assistant.mcp.plist
cp -R <robinHome>/db <robinHome>/db.pre-v2-rebuild
rm -rf <robinHome>/db/*
# update config.json: db.engine = 'surrealkv+versioned' (if not done at install time)
# restart daemon
```

### 5b. Registry simplification

`EDGE_KIND_REGISTRY` stays as source of truth for kind validation. Schema-level enforcement via `TYPE RELATION FROM A TO B ENFORCED` was considered and rejected: polymorphic endpoint sets + open-enum philosophy.

### 5c. Phasing (work order within one push)

1. **Phase 1 — Additive foundations.** Engine swap, REFERENCE fields, COMPUTED `is_overdue`, FULLTEXT indexes, `runtime:recall.config`. Schema-additive. Gates 14-18.
2. **Phase 2 — Edges → TYPE RELATION + arrow refactor.** Schema rewrite, field rename, refactor ~22 src + ~14 test files. Gates 5-7.
3. **Phase 3 — Hot-path batching.** Gates 9-13.
4. **Phase 4 — Hybrid retrieval.** Gates 8 + bench-recall harness.

Each phase ends with a commit and relevant gates green.

### 5d. Top-level success criterion

Spec is shipped when:
- All 18 verification gates pass on a fresh `surrealkv+versioned://` instance.
- Unit + integration suites at the new post-refactor parity (no test regressions outside expected rename ripples).
- `scripts/bench-recall.mjs` runs cleanly and reports a lift number (target: ≥15%; acceptable: ≥5% on the bootstrap fixture, with the harness in place for tuning).
- `robin doctor` reports engine match + schema match.

## Open questions

None. User directive: destructive OK, no migrators, process updates allowed.

## See also

- `2026-05-11-robin-v2-database-and-memory-redesign-design.md` — the predecessor whose TYPE NORMAL premise this corrects.
- `docs/architecture.md` — to be updated to reflect TYPE RELATION + arrow traversal.
