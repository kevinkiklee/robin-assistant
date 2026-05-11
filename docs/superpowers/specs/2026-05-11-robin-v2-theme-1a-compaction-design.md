# Robin v2 — Theme 1a: Memory compaction & forgetting

**Status:** Design (working draft; impl waits for `feat/surrealdb-improvements` merge)
**Date:** 2026-05-11
**Umbrella:** `2026-05-11-robin-v2-evolution-roadmap.md` (Theme 1a)
**Depends on:** `2026-05-11-surrealdb-improvements-design.md` (uses post-merge edge field names `in`/`out`, arrow traversal, `surrealkv+versioned` engine)

## Why

Robin's memo count grows monotonically. The existing `step-scope-cleanup` only touches ephemeral scopes (`session:*` after 7d, `temp:*` after 24h). Persistent memos — including near-duplicates produced by repeated biographer/dream runs over the same material, and old low-signal memos that never sharpen — accumulate forever. Recall noise, storage growth, and graph density all compound.

Three pains in roughly equal measure:

1. **Near-duplicate hits in recall** — same fact written N times in slightly different words.
2. **Stale low-value memos clutter results** — old, never-reinforced memos displace fresh hits.
3. **Memo table grows without bound** — no quality complaint today, no guardrail either.

## Goals

- Detect and merge semantic near-duplicates among `kind='knowledge'` memos (the only kind that naturally re-derives) via the existing `supersedes` mechanism.
- Move aged-out, low-signal memos out of the hot recall surface into an `archive_*` tier, preserving them for audit but excluding them from default recall.
- Provide a tuneable config row and per-run telemetry so the spec ages well with data.
- Keep LLM token spend at **zero new tokens** per run — no summarisation in v1.

## Non-goals

- LLM-based summarisation of compacted memos (deferred — can layer on later if archive proves too coarse).
- Compaction on `events` substrate (lifecycle already handled by `biographed_at` / `dreamed_at`).
- Compaction on `entities` (rare, low-volume, different identity model).
- Stale-open prediction handling (open `meta.resolved_at IS NONE` predictions deserve their own thinking; defer to a later spec).
- A separate `events` or `entities` archive tier.

## Anchoring decisions

**Why two mechanisms (cluster-merge + archive), not three or one:**
- **Dedup** wants cluster awareness: N near-duplicates collapse to one canonical with the others preserved as superseded history. `supersedes` already encodes exactly this (`fn::freshness` returns 0 for superseded memos; they vanish from recall but stay queryable). Zero new infrastructure.
- **Staleness + growth-cap** are the same shape: a memo aged past its threshold with no signal leaves the hot tier. One mechanism: move-to-archive. The "growth-cap" framing is descriptive, not a separate trigger.

**Why no summarisation in v1:**
- Per-compaction LLM call cost compounds with run frequency.
- Summarisation is hard to make idempotent ("re-summarise the same cluster, get a slightly different summary").
- The archive tier captures the same recall-noise-reduction outcome without the cost.
- Can be layered on later if explicit audit queries against archive prove too noisy.

**Why per-kind thresholds derived from `fn::freshness` half-lives:**
- Half-lives are already calibrated for recall scoring; using `2× half-life` for archive eligibility ties two systems to one decision.
- Defaults travel together — if `step-knowledge` half-life ever changes, the archive threshold tracks.

**Why the dedup pass uses pairwise-to-candidate (not transitive closure):**
- Transitive clustering drifts: A↔B at 0.94 + B↔C at 0.94 can have A↔C at 0.84. The transitive cluster merges non-duplicates.
- Pairwise-to-candidate (each memo's cluster = its kNN at threshold) is strictly more conservative.

## Section 1 — Schema additions

```surql
DEFINE TABLE archive_memos SCHEMAFULL TYPE NORMAL;
-- Mirror of memos: kind, content, content_hash, confidence, signal_count, decay_anchor,
--                  derived_by, derived_at, updated_at, last_active, scope, tags, meta.
-- (Copied verbatim from memos definition; do not redefine here to avoid drift.)
DEFINE FIELD archived_at    ON archive_memos TYPE datetime DEFAULT time::now() READONLY;
DEFINE FIELD archive_reason ON archive_memos TYPE string;
-- No FTS index. No vector/HNSW index. Recall cannot reach in.
DEFINE INDEX archive_memos_kind         ON archive_memos FIELDS kind;
DEFINE INDEX archive_memos_archived_at  ON archive_memos FIELDS archived_at;
DEFINE INDEX archive_memos_chash        ON archive_memos FIELDS content_hash;

DEFINE TABLE archive_edges SCHEMAFULL TYPE RELATION;
-- Mirror of edges (post-surrealdb-improvements): kind, in, out, weight, last_seen,
--                                                valid_from, valid_until, context, meta.
-- Composite IDs preserved (edges:[kind, in, out]).
-- No cascade-event triggers.
DEFINE INDEX archive_edges_kind_in   ON archive_edges FIELDS kind, in;
DEFINE INDEX archive_edges_kind_out  ON archive_edges FIELDS kind, out;

DEFINE TABLE archive_log SCHEMAFULL TYPE NORMAL;
DEFINE FIELD memo_id  ON archive_log TYPE record;        -- record<archive_memos> or record<memos> at restore time
DEFINE FIELD action   ON archive_log TYPE string;        -- 'archived' | 'restored'
DEFINE FIELD reason   ON archive_log TYPE string;        -- 'stale_age' | 'low_signal' | 'manual' | 'restored_by_user'
DEFINE FIELD ts       ON archive_log TYPE datetime DEFAULT time::now() READONLY;
DEFINE FIELD meta     ON archive_log TYPE option<object> FLEXIBLE;
DEFINE INDEX archive_log_memo_ts ON archive_log FIELDS memo_id, ts;

DEFINE TABLE compaction_telemetry SCHEMAFULL TYPE NORMAL;
DEFINE FIELD ts             ON compaction_telemetry TYPE datetime DEFAULT time::now() READONLY;
DEFINE FIELD dedup_clusters ON compaction_telemetry TYPE int;
DEFINE FIELD dedup_merged   ON compaction_telemetry TYPE int;
DEFINE FIELD archived       ON compaction_telemetry TYPE int;
DEFINE FIELD by_kind        ON compaction_telemetry TYPE object FLEXIBLE;
DEFINE FIELD duration_ms    ON compaction_telemetry TYPE int;
DEFINE FIELD errors         ON compaction_telemetry TYPE array<string> DEFAULT [];
DEFINE INDEX compaction_telemetry_ts ON compaction_telemetry FIELDS ts;
```

A new archive_log row is created **per archive/restore event** — multiple cycles produce multiple rows ordered by `ts`. Audit queries reconstruct the history.

## Section 2 — `runtime:compaction.config` (the tuning row)

```json
{
  "semantic_threshold": 0.93,
  "cluster_max_size": 8,
  "dedup_enabled": true,
  "archive_enabled": true,
  "archive_thresholds": {
    "knowledge":  { "age_days": 360, "signal_max": 1 },
    "habit":      { "age_days": 120, "signal_max": 1 },
    "thread":     { "age_days": 60 },
    "prediction": { "resolved_age_days": 730 }
  }
}
```

Seeded by the schema bootstrap. Re-read at the start of each `step-compaction` run; survives daemon restart. Override via CLI:

```sh
robin compaction config set semantic_threshold 0.95
robin compaction config get
```

## Section 3 — `step-compaction` flow

Placement: `src/dream/pipeline.js`, after `step-scope-cleanup`. Idempotent, fail-soft per existing dream-step convention. The whole step is wrapped in its own try/catch in the pipeline.

```
read config from runtime:compaction.config
if config.dedup_enabled:
    run dedup pass 1 (exact)
    run dedup pass 2 (semantic)
if config.archive_enabled:
    run archive pass (per-kind, per eligibility predicate)
write one compaction_telemetry row
```

### 3.1 Dedup pass 1 — exact

```surql
SELECT content_hash, count() AS n, array::group(id) AS ids
FROM memos
WHERE kind = 'knowledge' AND content_hash IS NOT NONE
GROUP BY content_hash
HAVING n > 1;
```

For each cluster: pick canonical by `signal_count × confidence DESC, derived_at ASC`. For each non-canonical `m`: `store.supersede(canonical, m)`.

### 3.2 Dedup pass 2 — semantic

```js
const processed = new Set();
for (const m of unprocessedKnowledgeMemos(db)) {           // hot table only; skip processed
  if (processed.has(m.id)) continue;
  const neighbours = await knnAgainstMemos(db, m, {        // pairwise to candidate; no transitive closure
    k: config.cluster_max_size,
    threshold: config.semantic_threshold,
    excludeSelf: true,
  });
  const cluster = [m, ...neighbours.filter(n => !processed.has(n.id))];
  if (cluster.length < 2) {
    processed.add(m.id);
    continue;
  }
  const canonical = pickCanonical(cluster);                // max signal_count*confidence; tiebreak derived_at
  for (const other of cluster) {
    if (other.id !== canonical.id) await store.supersede(canonical.id, other.id);
    processed.add(other.id);
  }
}
```

**Invariants:**
- `processed` prevents re-clustering memos already merged in this run.
- No transitive closure — each memo's cluster is defined by *its own* kNN at threshold, not by chained similarity.

### 3.3 Archive pass

Per-kind eligibility predicates, evaluated in one query each:

```surql
-- knowledge (uses post-surrealdb-improvements arrow traversal)
SELECT id, kind FROM memos
WHERE kind = 'knowledge'
  AND derived_at < time::now() - $age_days * 1d
  AND signal_count <= $signal_max
  AND count(<-derived_from<-memos) = 0
LIMIT $batch;

-- habit
SELECT id, kind FROM memos
WHERE kind = 'habit'
  AND derived_at < time::now() - $age_days * 1d
  AND signal_count <= $signal_max
LIMIT $batch;

-- thread
SELECT id, kind FROM memos
WHERE kind = 'thread'
  AND derived_at < time::now() - $age_days * 1d
  AND count(meta.episode_ids) = 0
LIMIT $batch;

-- prediction (resolved only; open predictions never archive)
SELECT id, kind FROM memos
WHERE kind = 'prediction'
  AND meta.resolved_at IS NOT NONE
  AND meta.resolved_at < time::now() - $resolved_age_days * 1d
LIMIT $batch;
```

`$batch` defaults to 200 per kind per run; bounds the worst-case transaction count.

For each eligible memo, run the archive transaction (SurrealQL below is illustrative — exact idioms verify at impl time against SurrealDB 3.0.5 and are pinned by gate 6):

```surql
BEGIN;
  LET $row    = SELECT * FROM ONLY $id;
  LET $archived = (INSERT INTO archive_memos { archived_at: time::now(), archive_reason: $reason } RETURN id);
  -- copy fields into the archive row
  UPDATE $archived MERGE $row;
  -- relocate incident edges atomically
  INSERT INTO archive_edges (SELECT * FROM edges WHERE in = $id OR out = $id);
  DELETE edges WHERE in = $id OR out = $id;
  DELETE $id;
  CREATE archive_log CONTENT { memo_id: $archived, action: 'archived', reason: $reason };
COMMIT;
```

Edges are deleted from the hot table **inside the transaction, before the memo is deleted**. The `DEFINE EVENT cascade` trigger on `memos` would also try to delete incident edges, but they're already gone; the cascade becomes a no-op `DELETE … WHERE` on zero rows.

**Why this is safe:** SurrealDB v3 cascade events run inside the deleting transaction (verified by gate 1 in the predecessor surrealdb-improvements spec). The explicit DELETE inside our transaction commits first; the cascade sees an empty result; no double-delete error.

### 3.4 Restore (manual; not part of step-compaction)

```sh
robin memo restore <id>
```

Inverse transaction (illustrative; exact idioms pinned by gate 9):

```surql
BEGIN;
  LET $row    = SELECT * OMIT archived_at, archive_reason FROM ONLY $archived_id;
  LET $restored = (INSERT INTO memos $row RETURN id);
  INSERT INTO edges (SELECT * FROM archive_edges WHERE in = $archived_id OR out = $archived_id);
  DELETE archive_edges WHERE in = $archived_id OR out = $archived_id;
  DELETE $archived_id;
  CREATE archive_log CONTENT { memo_id: $restored, action: 'restored', reason: 'restored_by_user' };
COMMIT;
```

`include_archived` access is **CLI-only** in v1:

- `robin memo list --include-archived`
- `robin memo show <id> --archived`
- `robin memo restore <id>`

MCP tool handlers and the agent-facing surface get no opt-in flag. This avoids accidental leakage of archived memos back into normal recall.

## Section 4 — Cost envelope

- **Dedup pass 1:** one `GROUP BY content_hash` query. Bounded by knowledge-memo count; <100ms at 10k memos.
- **Dedup pass 2:** N kNN calls (one per unprocessed knowledge memo). HNSW O(log N) per call; at 10k memos × ~5ms each ≈ 50s worst case on `mem://`, faster on rocksdb. Capped further by `processed` set growth.
- **Archive:** four-statement transaction per eligible memo. At realistic eligibility rates (~1–5% of stale memos per nightly run), ~50–500 transactions/night.
- **LLM cost:** **zero.** No summarisation.
- **Embedding cost:** **zero.** Reuses existing embeddings.
- **New token spend:** **zero.** Well within roadmap §4's ±20% envelope.

## Section 5 — Verification gates

1. **Dedup pass 1 idempotent:** rerun on clean DB → no changes.
2. **Dedup pass 2 finds known semantic dupes:** golden fixture of 6 pairs across diverse topics; cosine < threshold stays unmerged; cosine ≥ threshold merges.
3. **No transitive over-merge:** fixture with A↔B = 0.94, B↔C = 0.94, A↔C = 0.84 → A clusters with B (or B with A; deterministic by `processed` order); C does NOT join the cluster.
4. **Canonical selection deterministic:** ties broken by earliest `derived_at`; verified on a fixture.
5. **Archive eligibility stable:** archived on day N stays archived on day N+1 (no flap; each run skips already-archived rows naturally because they're not in `memos`).
6. **Archive transaction atomic:** simulated mid-statement failure leaves zero orphan rows. Test: inject error after the `DELETE edges` statement and confirm rollback restores all rows.
7. **No double-delete on edges:** archive transaction completes without cascade-event collision against the v3 engine. Run on a real `surrealkv` instance, not just `mem://`.
8. **Recall ignores archive:** `searchMemos` against fixture with N archived + M hot returns only hot.
9. **Restore round-trips:** `archive → restore → archive → restore` produces identical row content and edge sets (excluding `archive_log` history).
10. **Telemetry written:** one `compaction_telemetry` row per run; counts match reality.
11. **No graph leak into archive:** arrow traversal from a hot memo across `derived_from` to a previously-archived event returns nothing (edge is in `archive_edges`).
12. **Cost gate:** synthetic 10k-memo fixture, full `step-compaction`, completes in <60s on `mem://`.

## Section 6 — File-by-file changes

**Created:**
- `src/dream/step-compaction.js` — the new dream step.
- `src/cli/commands/compaction.js` — `robin compaction config get|set`, `robin memo list --include-archived`, etc.
- `src/memory/archive.js` — `archiveMemo(db, id, reason)` / `restoreMemo(db, archivedId)`; the only writers to archive tables.
- `tests/unit/step-compaction-dedup.test.js`
- `tests/unit/step-compaction-archive.test.js`
- `tests/integration/step-compaction-roundtrip.test.js`
- `tests/fixtures/compaction-golden.json`

**Modified:**
- `src/schema/migrations/0001-init.surql` (or a follow-on migration file) — add archive tables, `compaction_telemetry`, seed `runtime:compaction.config`.
- `src/dream/pipeline.js` — wire `step-compaction` after `step-scope-cleanup`.
- `src/memory/store.js` — `searchMemos`, `searchEvents`, `searchEntities` confirmed to query hot tables only; no behavioural change but a comment / audit-test asserting it.
- `docs/architecture.md` — add §"Memory lifecycle" describing the two-tier model.
- `docs/faculties.md` — extend the dream section with `step-compaction`.

## Section 7 — Sequencing

Theme 1a impl **starts only after `feat/surrealdb-improvements` merges into main**. Uses post-merge edge field names (`in`/`out`), arrow traversal in eligibility queries, and the `surrealkv+versioned` engine (free time-travel reads on top of the explicit archive — bonus, not load-bearing).

Phasing within Theme 1a:

1. **Schema additions + config row** — additive, ship-safely.
2. **`src/memory/archive.js` + `step-compaction.js`** — write the mechanism.
3. **CLI commands** — `robin compaction config`, `robin memo restore`, `--include-archived` flag.
4. **Tests + verification gates.**
5. **Wire into dream pipeline; one nightly run on production DB; inspect telemetry.**

## Section 8 — Open questions (for follow-up specs)

- **Stale-open predictions:** open `meta.resolved_at IS NONE` predictions never archive under the current eligibility rules. They could accumulate indefinitely. Needs its own thinking — possibly a `force_resolve_after_days` field or a manual sweep. Out of scope here; flagged for a later spec.
- **`entities` archive tier:** rare today; revisit if Theme 1b (episode expansion) generates many short-lived entities.
- **Cross-profile dedup during a swap:** the dedup pass uses the **active** profile's embedding table (`embeddings_<active>_memos`). After a profile swap, only memos whose embeddings have been backfilled into the new profile are visible to dedup. Memos missing from the new profile's table (because backfill is incomplete) are temporarily exempt from semantic dedup. This is correct (we can't compute similarity for them) but means a backfill-in-progress run may underreport clusters. Flag, not block.

## See also

- `2026-05-11-robin-v2-evolution-roadmap.md` — umbrella.
- `2026-05-11-robin-v2-database-and-memory-redesign-design.md` — `supersedes` semantics, `fn::freshness`, half-life defaults.
- `2026-05-11-surrealdb-improvements-design.md` — edge field names (`in`/`out`), arrow traversal, engine.
- `docs/architecture.md` — current memory model (to be updated).
