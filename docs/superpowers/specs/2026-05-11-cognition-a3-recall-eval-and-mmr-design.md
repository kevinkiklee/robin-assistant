# Robin v2 — Cognition A1+A2+A3: recall-quality bundle

**Status:** Design (working draft)
**Date:** 2026-05-11
**Umbrella:** `2026-05-11-robin-v2-evolution-roadmap.md` — sits alongside Themes 1–4; targets the recall pipeline.
**Bundles:** A1 (real-cosine MMR), A2 (entity-aware recall boost), A3 (recall eval harness).
**Depends on:** alpha.16 (Theme 2a evidence ledger, Theme 4 introspection). No engine work; ships against current SurrealDB v3 / `surrealkv://` substrate.

## Why bundled

The three improvements share data, code paths, and risk surface:

- **Shared data.** All three read `recall_log.ranked_hits` and the per-surface
  embedding tables `embeddings_<profile>_{events,memos,entities}`. A1 needs the
  embedding vectors that A3's replay mode also needs. A2 reads `edges WHERE
  kind = 'about'` joined to `entities`, the same join A3 uses to compute
  per-entity precision rollups.
- **Shared rollout signal.** A3 is the only honest way to decide whether A1
  (new MMR threshold) and A2 (new score multiplier) are wins. Shipping A1/A2
  before A3 means tuning by gut.
- **Shared regression surface.** A1 changes the MMR diversity behavior, A2
  changes the composite score formula, and both write new fields into
  `recall_log.ranked_hits[*].score_components`. Migrating the row shape twice
  is wasteful; once is acceptable.

Sequencing inside the bundle (Section 9) keeps the risky writes (A1, A2) gated
behind the read-only harness (A3).

## Goals

- **A3:** answer "did this change to recall make things better or worse?" with
  numbers (precision@k, nDCG@k, mean-rank-of-corrected), reproducibly, against
  historical `recall_log` rows.
- **A1:** replace `inject.js`'s `substringOverlap` (token Jaccard) with real
  cosine similarity in MMR, using cached embedding vectors. Drop tokens-of-len>3
  Jaccard, which silently underweights numeric/short-word duplicates.
- **A2:** boost memos whose `about` edges point at entities present in the
  current query (or in the prior assistant tail's biographed events). Catches
  the case where vector recall ranks a topically-relevant memo below a
  word-overlap-dense but topically-irrelevant memo.

## Non-goals

- A new reranker. The `recall_log` becomes labelled-ish training data for a
  future reranker; that's a separate spec.
- Online learning of `prior_weight`, `mmr_threshold`, or entity-boost bounds —
  remains a config-knob tune via `runtime:recall.value`.
- Replacing BM25 or RRF. The bundle layers on top of the hybrid retrieval
  shape from `2026-05-11-surrealdb-improvements-design.md`.
- Cross-profile evaluation. A3 evaluates against the active embedding profile
  only; switching profiles invalidates historical replay (vectors live in
  per-profile tables).
- NER on the query path via an LLM call (rejected in A2; see §3.1).

## Anchoring decisions

**Why a separate `recall_eval_runs` table (A3):**

- Harness output is itself useful telemetry — historical runs answer "when did
  recall@10 cross 0.6?" If we only print to stdout, that history is lost.
- The table is small (one row per run, not per query) and append-only.
  Compaction is trivial; queries are bounded by run count.
- Theme 4's `explain_recall` is per-query; `recall_eval_runs` is the system-wide
  rollup complement.

**Why hydrate vectors via a batched fetch, not piggyback on kNN return (A1):**

- `_surfaceSearch` returns hydrated record rows; the kNN-side `SELECT record,
  vector::distance::knn() AS dist` does not project `vector`. Adding `vector`
  to the projection bloats every recall response by `dim × 4` bytes per hit
  (4096 bytes at 1024-dim) — payload bloat across every UserPromptSubmit.
- A single batched `SELECT in, vector FROM embeddings_<profile>_<surface>
  WHERE in IN $ids` runs in microseconds and only fires when MMR has ≥2 hits.
  Skipped when MMR would no-op (≤1 hit).

**Why a multiplier, not a multiplicative new component (A2):**

- The composite formula in `rank.js:39-57` is already a product of five
  components in [0, 1] (`cosineSim × fresh × contraPenalty × trustFactor`)
  with `scopeBoost ∈ [1.0, 1.2]` as the lone >1 multiplier. Entity match is
  semantically the same shape as scope match: "this hit is contextually closer
  to the caller than its raw vector distance suggests." Mirror `scopeBoost`'s
  bounded boost (≤1.25) rather than introduce a sixth factor that interacts
  multiplicatively across the whole [0, 1] product.
- Multiplier composes cleanly with `scopeBoost` (both ≥1.0; product stays
  bounded). The combined upper bound is `1.2 × 1.25 = 1.5×`, well below the
  cosine_sim domination threshold.

**Why query-side entity match via existing catalog, not LLM NER (A2):**

- `biographer/pipeline.js:32` already maintains a catalog of the top-N
  entities by `created_at`. Recall already pays for that table; reading from
  it on the recall path is a few keys' lookup.
- Adding an LLM call to every UserPromptSubmit is a non-starter — recall is
  on the hot path and runs even when the user types "ok".
- Prior-assistant-tail entities are already biographed (asynchronously, via
  the Stop hook). Reusing them is free.

**Why session_id must be plumbed into `inject.js` recall rows (A3 prerequisite):**

- `inject.js:202-212` currently writes `recall_log` rows without
  `session_id` because `intuitionEndpoint` never receives one. The MCP
  `recall` tool (`io/mcp/tools/recall.js:120`) does record it.
  `reinforcement.js:31,54,70-81` joins corrections to recall rows via
  the recall row's `session_id` field against `events.meta.session_id`
  within the 5-minute window. A3's replay mode joins on the same window
  — missing `session_id` falls through to the `__null__` bucket
  (`reinforcement.js:67,71-73`), which matches global-session
  corrections only, collapsing precision to a near-no-op for the
  intuition-hook rows that make up most of the corpus.
- The fix is end-to-end: pull `session_id` from the UserPromptSubmit
  hook stdin in `handler.js`, pass it through the daemon body in
  `server.js:897-919` (or `system/runtime/daemon/routes/intuition.js`
  if R-3 has shipped — see `docs/superpowers/plans/2026-05-11-runtime-layer-hardening.md`),
  accept it as a new param in `intuitionEndpoint`, write it onto
  `recall_log`. Four small edits, all in-scope here.
- **Coordination with B1:** the same plumbing is a pre-req for B1
  (per-hit reinforcement) which also needs `session_id` for
  reply-event-correlation. Whichever plan lands first ships the
  plumbing; the second plan verifies and falls through. The daemon
  body field uses `session_id` (snake_case) to match the
  `recall_log.session_id` column; the handler accepts `session_id` or
  `sessionId` from hook stdin (some Claude Code versions emit either).

## Section 1 — A3: recall eval harness

### 1.1 CLI surface

```text
robin recall-eval [--window 30d] [--profile mxbai-1024] [--k 6]
                  [--source intuition|mcp_recall|all]
                  [--replay] [--json] [--limit 5000]
                  [--out <path>]
```

- Sub-binary route: register `recall-eval` in
  `system/runtime/cli/index.js` (same pattern as `doctor`, `refusals`).
  Implementation in `system/runtime/cli/commands/recall-eval.js`.
- Lives behind one verb (`robin recall-eval`) rather than under `robin
  doctor --recall-eval` so the harness can grow flags without polluting
  `doctor`'s flag namespace (`--health`, `--rebaseline`, `--lint-hooks`,
  `--purge-stale-sessions` already there).
- `--profile` defaults to the active embedding profile read from
  `runtime:embedder.active_profile`. Replay against a non-active profile is
  rejected with a clear error: the per-profile embedding tables for
  historical hits may not exist.
- `--source` filters `recall_log` rows by their writer. The discriminant
  is `meta.from`; values are `'intuition'` (inject.js) or `'mcp_recall'`
  (MCP recall tool). Pre-migration rows lack `meta.from`; the harness
  falls back to a heuristic on those (`session_id IS NONE → intuition`,
  `session_id IS NOT NONE → mcp_recall`) and prints a one-line warning
  per run reporting how many rows used the fallback. Heuristic is
  approximate; remove from the metrics-grade window once 7 days of
  post-migration data exist.

### 1.2 Data sources

| Input | Source | Notes |
|---|---|---|
| Historical recall rows | `recall_log` | All rows in window; both `intuition` + `mcp_recall` writers. |
| Correction events | `events WHERE meta.kind = 'correction'` | Same window definition as `reinforcement.js:70-81`: `events.ts ∈ [recall.ts, recall.ts + 5min]` AND (`events.meta.session_id` matches the recall row's `session_id` OR either side is `NONE`). Pre-migration intuition rows have `session_id = NONE`, which matches all corrections in window. Harness reports `rows_with_null_session` count so we can audit how much that loosening contributes; post-migration rows tighten as `session_id` flows through. |
| Reinforcement outcomes | `recall_log.outcome ∈ {'reinforced','corrected','evaluated_no_signal','pending'}` | Pending rows excluded from scoring; counted separately. |
| Active embedding vectors | `embeddings_<profile>_<surface> WHERE in IN $ids` | Only fetched in `--replay` mode. |

### 1.3 Labels

Per ranked-hit `(recall_log.id, rank_index)`:

| Label | Condition | Score weight |
|---|---|---|
| `negative` | Row's `outcome = 'corrected'` AND `hit` is `memos:*`. Mirrors the assumption in `reinforcement.js:111-159` that the whole hit set is suspect on correction. | -1 |
| `soft_positive` | Row's `outcome = 'reinforced'` AND `hit` is `memos:*`. Uncorrected memos in the 5-min window. | +0.5 |
| `unlabeled` | All other cases (events, `evaluated_no_signal`, `pending`, non-memo hits). | 0 |

Notes:

- The "used-marker" soft-positive lane mentioned in the prompt depends on
  B1 (per-hit used markers in the response). B1 has not shipped. The
  harness must not assume it. When B1 lands, the soft-positive condition
  tightens to "uncorrected AND used-marker present"; until then we use the
  weaker session-window proxy.
- Event hits are unlabeled by default. They're useful for recall@k surface
  comparisons but the corroborate/refute signal lives at the memo layer.
- A future tightening that emits per-hit refutes (rather than whole-row
  refutes) is tracked under Theme 2a §12 "Targeted refutation on
  `corrected` outcome." When that lands, A3's labels become per-hit
  faithful rather than per-row.

### 1.4 Metrics

For each `(recall_source, k)` slice (k ∈ {1, 3, 6, 10}):

- **precision@k** = `(# soft_positive hits in top-k) / k`, averaged over rows.
- **recall@k** = `(# soft_positive hits in top-k) / (# soft_positive hits over the full row)` — denominator is the row's full `ranked_hits` length; bounded by row k.
- **nDCG@k** computed on a non-negative-gain projection: gain = `max(0, 2^label - 1)`, so labels ∈ {-1, 0, 0.5} project to gains ∈ {0, 0, ≈0.41}. Negatives contribute zero gain but still penalize via the precision and mean-rank metrics. Idealized over the row's own hits — reports relative ranking quality within the recalled set, not absolute coverage.
- **mean_rank_of_negatives** — average 1-indexed rank of `corrected` hits; lower is worse (negatives should sink in good rankings).
- **no_signal_rate** = `count(outcome='evaluated_no_signal') / count(evaluated rows)`.
- **pending_rate** = `count(outcome='pending') / count(rows in window)` — bounded by reinforcement-loop lag; sanity check, not a quality metric.
- **latency_p50 / p95** — from `recall_log.meta.latency_ms`. Already recorded by `inject.js:179-189`; the MCP `recall` tool needs the same field added (§1.5).
- **source breakdown** — per `_sources` array in `ranked_hits[*]` (`['knn']`, `['bm25']`, `['knn','bm25']`). Recorded today by `fusion.js:rrfFuse`. Reports what fraction of top-k surfaces came via each lane and the per-lane precision@k.

### 1.5 Schema additions

```surql
DEFINE TABLE recall_eval_runs SCHEMAFULL TYPE NORMAL;
DEFINE FIELD ts            ON recall_eval_runs TYPE datetime DEFAULT time::now() READONLY;
DEFINE FIELD profile       ON recall_eval_runs TYPE string;
DEFINE FIELD window_start  ON recall_eval_runs TYPE datetime;
DEFINE FIELD window_end    ON recall_eval_runs TYPE datetime;
DEFINE FIELD source_filter ON recall_eval_runs TYPE string DEFAULT 'all';
DEFINE FIELD replay        ON recall_eval_runs TYPE bool DEFAULT false;
DEFINE FIELD rows_scored   ON recall_eval_runs TYPE int;
DEFINE FIELD rows_pending  ON recall_eval_runs TYPE int;
DEFINE FIELD rows_skipped  ON recall_eval_runs TYPE int;
DEFINE FIELD metrics       ON recall_eval_runs TYPE object FLEXIBLE;
DEFINE FIELD per_source    ON recall_eval_runs TYPE option<object> FLEXIBLE;
DEFINE FIELD config_digest ON recall_eval_runs TYPE option<object> FLEXIBLE;
DEFINE FIELD git_sha       ON recall_eval_runs TYPE option<string>;
DEFINE INDEX recall_eval_runs_ts      ON recall_eval_runs FIELDS ts;
DEFINE INDEX recall_eval_runs_profile ON recall_eval_runs FIELDS profile, ts;
```

`config_digest` snapshots `runtime:recall.value` + the bundle config (§4 below)
so two runs at different commits with different thresholds remain
comparable.

Two small additive changes elsewhere:

- `recall_log.meta.from` (option<string>) — `'intuition'` or `'mcp_recall'`.
  Set in `inject.js` and `mcp/tools/recall.js`. `meta` is FLEXIBLE so no
  schema change required.
- `recall_log.meta.latency_ms` (option<int>) — already set by `inject.js`;
  add to `mcp/tools/recall.js`.

### 1.6 Replay mode

`--replay` walks each historical `recall_log` row and **recomputes** the
ranking using the current `rank.score` + MMR + entity-boost, against the
recorded `ranked_hits` IDs and their current `embeddings_*` vectors.

Steps per row:

1. Fetch the row's `ranked_hits` ID list (preserving original order).
2. Hydrate current records: `SELECT * FROM events,memos WHERE id IN $ids`.
   Skip the row if any hit's record is gone (count under `rows_skipped`).
3. Fetch current vectors: `SELECT in, vector FROM
   embeddings_<profile>_events WHERE in IN $eventIds`; same for memos.
   A row with no vectors at all is skipped (legacy pre-profile data).
4. Re-embed the row's `query` (one embed call per row; this dominates
   harness latency at ~3-10ms per row × 1024-dim).
5. Run `rank.score` per hit against the re-embedded query.
6. Run `mmrLite` with the new cosine path (A1 implementation).
7. Run entity-boost (A2 implementation) if the row's effective source is
   `intuition` (resolved via `meta.from` when present, else the session_id
   heuristic from §1.1). MCP-recall rows skip A2 — see §3.4.
8. Compare new top-k to recorded top-k. Report rank-correlation (Kendall τ)
   per row; emit `replay_kendall_mean` in the metrics object.
9. Compute the same precision@k / nDCG@k / mean-rank-of-negatives over the
   **new** top-k against the original labels.

Two precision numbers reported: `precision@k_recorded` (original ranking
against labels) vs `precision@k_replayed` (current ranking against labels).
Δ = replayed − recorded. Positive Δ = recall has improved since the row
was written; negative Δ = regression.

Replay mode is bounded by `--limit` (default 5000) because re-embedding
every query costs an embedding call. The CLI prints an ETA based on
`limit × p50_embed_ms` before starting; aborts cleanly on SIGINT.

Replay needs the embedder loaded. The CLI command opens the DB, reads
`runtime:embedder.active_profile`, instantiates the embedder via the
same factory used by the daemon (`system/data/embed/loader.js` or
equivalent — pin to whatever `daemon/server.js` uses today), and
passes it into the eval module. Unit tests pass a mock embedder
returning a fixed-shape `Float32Array`. Non-replay scoring needs no
embedder.

### 1.7 Output

Text default — one screen of summary plus a per-source breakdown table.

```
Recall eval — profile=mxbai-1024 window=2026-04-11..2026-05-11 source=all
  rows_scored=4,812  rows_pending=37  rows_skipped=129 (vec missing)

  metric              k=1     k=3     k=6     k=10
  precision           0.412   0.318   0.241   0.198
  recall              0.187   0.466   0.778   0.952
  nDCG                0.521   0.483   0.471   0.469
  mean_rank_of_neg    —       —       3.81    4.92
  no_signal_rate      0.043
  latency             p50=58ms  p95=189ms

  per_source             knn   bm25   knn+bm25
    fraction of top-6   0.71   0.18    0.11
    precision@6         0.255  0.181   0.314
```

`--json` returns the full `recall_eval_runs` row payload so a CI gate
can `jq` on `metrics.precision_at_6 < 0.20` and exit non-zero.

`--out <path>` writes the JSON to disk in addition to inserting the
`recall_eval_runs` row.

### 1.8 Exit codes (suitable for cron)

- `0` — ran, scored ≥ `min_rows` rows (default 100), no thresholds violated.
- `1` — ran, scored < `min_rows` rows. Inconclusive; not a regression
  signal. Cron monitor should not page on this.
- `2` — ran, scored ≥ `min_rows` rows, **and** at least one metric breaches
  a configured threshold from `runtime:recall_eval.thresholds`. Page.
- `3` — harness error (DB open failed, profile inactive, etc.). Page.

`runtime:recall_eval.thresholds` (seeded by the bundle migration):

```json
{
  "min_rows": 100,
  "precision_at_6_min": 0.20,
  "ndcg_at_6_min": 0.35,
  "no_signal_rate_max": 0.30,
  "mean_rank_of_neg_at_10_min": 4.0
}
```

Initial values are not load-bearing; first eval run produces the
calibrating baseline. Tune in `runtime:recall_eval.thresholds` after one
week of telemetry.

### 1.9 Failure modes

- **Reinforcement-loop lag** → `rows_pending > 0`. Reported as a count, not
  scored. The harness does not run the reinforcement loop itself; it
  reads outcomes as the loop wrote them.
- **Profile mismatch** → if `--profile` differs from
  `runtime:embedder.active_profile`, replay mode hard-errors. Scoring
  (non-replay) mode warns and continues — the labels are still valid
  even if the active embedder changed.
- **Embedding vector missing for a hit** → row excluded from replay,
  counted under `rows_skipped`. Common cause: schema-redesign transition
  rows. Acceptable noise floor below ~3%.
- **Schema drift** → harness reads `recall_log.ranked_hits[*]` as
  FLEXIBLE; tolerates missing `_sources`, missing `score_components`,
  missing `kind`. Older rows score with what they have.

## Section 2 — A1: real-cosine MMR

### 2.1 Where vectors come from

`mmrLite` runs after `engine.recall` / `store.searchMemos` returns hits.
Hits carry `record` but not `vector`. Approach: **followup batched fetch
in `inject.js` between the score-sort step and the MMR call**:

```js
// inject.js — between merge/sort and mmrLite, only when there are ≥2 hits
const eventIds = merged.filter(h => h._kind === 'event').map(h => h.record.id);
const memoIds  = merged.filter(h => h._kind === 'memo').map(h => h.record.id);
const vectors = await loadVectorsForHits(db, { eventIds, memoIds });
// vectors: Map<id-string, Float32Array>
```

`loadVectorsForHits` is a new helper in `system/cognition/intuition/vectors.js`:

```js
export async function loadVectorsForHits(db, { eventIds, memoIds }) {
  const profile = await readProfile(db);
  const out = new Map();
  if (eventIds.length > 0) {
    const tbl = embeddingTable(profile, 'events');
    const [rows] = await db.query(new BoundQuery(
      `SELECT record, vector FROM ${tbl} WHERE record IN $ids`,
      { ids: eventIds }
    )).collect();
    for (const r of rows) out.set(recordStringId(r.record), Float32Array.from(r.vector));
  }
  if (memoIds.length > 0) {
    const tbl = embeddingTable(profile, 'memos');
    const [rows] = await db.query(new BoundQuery(
      `SELECT record, vector FROM ${tbl} WHERE record IN $ids`,
      { ids: memoIds }
    )).collect();
    for (const r of rows) out.set(recordStringId(r.record), Float32Array.from(r.vector));
  }
  return out;
}
```

One query per non-empty surface, indexed by `record` (UNIQUE per
`0002-embeddings-*.surql:11,20,29`), so each is `IN`-list O(n log n).

### 2.2 Cosine helper

```js
// vectors.js
export function cosineSim(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i]*b[i]; na += a[i]*a[i]; nb += b[i]*b[i]; }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}
```

The HNSW index uses `DIST COSINE` (0001-init via `0002-embeddings-*.surql:13,22,31`),
so the stored vectors are well-formed for cosine but not normalized to
unit length on write. We compute the denominator at compare-time rather
than assuming unit length. A normalize-on-write optimization is possible
but out of scope.

### 2.3 New threshold

Current `substringOverlap`-based threshold is `0.85`. Real cosine has
much higher absolute values for near-duplicates (typical
sentence-embedding cosines are 0.6–0.95 for related but distinct
content; 0.95–1.0 for near-duplicates). Default real-cosine threshold:
`0.92`. Same default `rank.js:mmrLite` already declares — coincidence
worth noting, but the function's default fires only when
`inject.js` doesn't pass a threshold, which it currently does (0.85).

**Default in `runtime:recall.value.mmr_threshold`:** `0.92` (already
present in `store.js:HYBRID_DEFAULTS`; we re-use the same key for MMR).
Existing `runtime:recall.value` keys are honored — `inject.js` reads the
config once per call by reusing `store.js:getRecallConfig` (export it).

Tune-knob in `runtime:recall.value`:

```json
{
  "mmr_threshold": 0.92,
  "mmr_threshold_legacy_substring": 0.85
}
```

The legacy key is kept so the fallback path (next section) can use its
own threshold without retuning when MMR fails over.

**Reused key semantics:** We reuse the existing `mmr_threshold` key
(default value chosen for the substring-overlap path was already `0.92`
in `store.js:HYBRID_DEFAULTS` per `rank.js:mmrLite`'s declared default;
the lower `0.85` lived only in `inject.js`'s call site). The threshold
semantics differ between paths: substring (Jaccard-style overlap) and
cosine treat the same numeric `0.92` as different distributions. Only
one path fires per call; the runtime flag `mmr_use_cosine` decides which.
A future task may split the keys into `mmr_threshold_cosine` and
`mmr_threshold_substring` once we have telemetry to support distinct
defaults; until then the single key plus the `_legacy_substring`
fallback is the operational contract.

### 2.4 Fallback path

If `loadVectorsForHits` returns zero vectors (rare: legacy data + the
profile got migrated mid-flight), or if it throws, MMR falls back to
the existing `substringOverlap` path with the legacy threshold:

```js
import { recordStringId } from '../memory/edge-registry.js';

let cosineFn, threshold, mmrPath;
const useCosine = cfg.mmr_use_cosine !== false && vectors.size >= 2;
if (useCosine) {
  const vecAt = (h) => vectors.get(recordStringId(h.record.id));
  cosineFn = (a, b) => {
    const va = vecAt(a), vb = vecAt(b);
    return va && vb ? cosineSim(va, vb) : 0; // 0 = "can't compare" → won't suppress
  };
  threshold = cfg.mmr_threshold ?? 0.92;
  mmrPath = 'cosine';
} else {
  cosineFn = (a, b) => substringOverlap(a.record.content, b.record.content);
  threshold = cfg.mmr_threshold_legacy_substring ?? 0.85;
  mmrPath = 'substring';
}
const deduped = mmrLite(merged, cosineFn, threshold).slice(0, k);
```

The `mmr_use_cosine` flag (§4) lets us disable A1 in production without
a deploy: flip `runtime:recall.value.mmr_use_cosine = false` to force
the substring path.

For partial-coverage cases (some hits have vectors, some don't), the
cosine path returns 0 for any pair touching a missing vector — those
pairs can't be dropped as near-duplicates, which is the safer failure
(false negatives, not false positives, in dedup).

### 2.5 Telemetry

Telemetry deltas (recorded on every recall call) live in
`intuition_telemetry`:

- `mmr_drops: int` — number of hits suppressed by MMR.
- `mmr_path: 'cosine' | 'substring'` — which path fired.
- `mmr_vec_coverage: float ∈ [0, 1]` — fraction of pre-MMR hits with vectors.

These three are FLEXIBLE-meta fields. The schema additive change is in
§4 — `intuition_telemetry.meta` becomes an option<object> FLEXIBLE.

## Section 3 — A2: entity-aware recall boost

### 3.1 Query-side entity source

Three candidates considered:

1. **Catalog string-match against query+prior-tail tokens.** Read the
   catalog (`SELECT name, id, type FROM entities ORDER BY created_at DESC
   LIMIT N`, same shape as `biographer/pipeline.js:32`), tokenize the
   query+priorTail, find entities whose `name_lower` appears as a token
   substring or whose name's tokens overlap ≥1 with the query tokens.
2. **Prior-assistant-tail biographed entities.** Read the `mentions`
   edges off the most recent biographed event in this session:
   `SELECT VALUE out FROM edges WHERE kind = 'mentions' AND in IN
   (SELECT id FROM events WHERE meta.session_id = $sid AND
   biographed_at IS NOT NONE ORDER BY ts DESC LIMIT 3)`.
3. **LLM NER on every UserPromptSubmit.** Rejected: ~100ms + tokens per
   recall, runs on every keystroke-equivalent.

**Decision: (1) + (2) combined.** Cheap query-tokens match against the
catalog covers the current-turn entities; prior-tail biographed entities
cover the in-flight thread. The combined set is small (typical N ≤ 5)
and gets used in §3.3.

Implementation reads the last 3 biographed events in the session and
harvests their `mentions` edges → entity ids (`matchPriorTailEntities`).
The result is unioned with `matchCatalogEntities` output before the
boost computation. This covers entities that exist in the
prior-assistant tail but have not yet propagated into the catalog
(catalog is ordered by `created_at DESC` and capped at N — very recent
entities can fall off the cap until the next read). Unit test
`intuition-entities.test.js` covers the entities-not-yet-in-catalog
case.

Catalog size cap: 500 entries (vs. 100 for the biographer prompt — we're
not feeding an LLM, just doing in-memory lookup). Reads are O(500 × tokens)
per recall, dominated by sub-millisecond JS string ops. Cache the catalog
in-process behind a 60-second TTL keyed on `runtime:embedder.active_profile`
so we don't hit the DB on every recall.

### 3.2 Match function

```js
// system/cognition/intuition/entities.js
const TOKEN_RE = /[a-z0-9][a-z0-9_-]+/gi;

function tokensOf(s) {
  return new Set((s ?? '').toLowerCase().match(TOKEN_RE) ?? []);
}

export function matchCatalogEntities(catalog, queryTokens) {
  const matched = [];
  for (const ent of catalog) {
    const nameTokens = tokensOf(ent.name);
    if (nameTokens.size === 0) continue;
    let hit = false;
    for (const t of nameTokens) { if (queryTokens.has(t)) { hit = true; break; } }
    if (hit) matched.push({ id: ent.id, name: ent.name, type: ent.type });
  }
  return matched;
}
```

Rules baked in:

- Entity names with all tokens shorter than 3 chars are skipped (avoid
  matching on "a", "of", etc. — same rationale as `substringOverlap`'s
  `length > 3` filter today).
- Exact token equality, not substring. "kevin" matches "kevin" but not
  "kevinlee". Cheap, stable, low-FP.
- Catalog entities with `scope = 'private'` are included (they're still
  the user's entities); the boost they grant is applied to memos
  separately scope-checked downstream.

### 3.3 Boost computation

For each hit (memo only — events are not boosted; A2 targets the
distilled-knowledge surface). The whole pass is gated by
`cfg.entity_boost_enabled`; when disabled, every hit returns
`{ boost: 1.0, count: 0 }` and `inject.js` skips the catalog read and
`about`-edge join entirely.

```js
function entityBoostFromAboutIds(aboutIds, matchedEntityIds, cfg) {
  if (matchedEntityIds.size === 0) return { boost: 1.0, count: 0 };
  let overlap = 0;
  for (const eid of aboutIds) if (matchedEntityIds.has(eid)) overlap++;
  if (overlap === 0) return { boost: 1.0, count: 0 };
  const perOverlap = cfg.entity_boost_per_overlap ?? 0.10;
  const max = cfg.entity_boost_max ?? 1.25;
  const boost = Math.min(max, 1.0 + perOverlap * overlap);
  return { boost, count: overlap };
}
```

`aboutEntitiesOf(db, memoId)` is batched across the candidate set in
one query before the score loop, not per-hit:

```js
async function aboutEntitiesForMemos(db, memoIds) {
  const [rows] = await db.query(new BoundQuery(
    `SELECT in AS memo, out AS entity FROM edges
     WHERE kind = 'about' AND in IN $ids`,
    { ids: memoIds }
  )).collect();
  const out = new Map();
  for (const r of rows) {
    const k = recordStringId(r.memo);
    if (!out.has(k)) out.set(k, new Set());
    out.get(k).add(recordStringId(r.entity));
  }
  return out;
}
```

Indexed by `edges_kind_in` (already present in
`0001-init.surql:161`); one round-trip regardless of memo count.

### 3.4 Where in the formula

`rank.js:score` becomes:

```js
const total = cosineSim * fresh * contraPenalty * trustFactor * scopeBoost * entityBoost;
return {
  score: total,
  components: { cosineSim, fresh, contraPenalty, trustFactor, scopeBoost, entityBoost, entityBoostCount },
};
```

**Naming convention (audited):** Per-hit `score_components` uses
JS-camelCase (`entityBoost`, `entityBoostCount`) matching the existing
`cosineSim`/`scopeBoost`/`contraPenalty`/`trustFactor` keys on the same
object. Aggregate telemetry on `intuition_telemetry.meta` uses snake_case
(`entity_boost_applied`, `entity_boost_count`, `mmr_drops`,
`mmr_vec_coverage`, `query_entities_matched`) matching existing telemetry
conventions (`latency_ms`, `tokens_injected`, `query_chars`). Both layers
are intentional — score-components live next to their function-local
identifiers; telemetry meta lives next to other DB-column-style fields.

Bounds:

- `entityBoost ∈ [1.0, 1.25]` (capped via Math.min).
- Stacks multiplicatively with `scopeBoost ∈ [1.0, 1.2]`. Combined upper
  bound `1.5×`. Below the noise floor of `cosineSim` for typical hits.

Backward compat:

- `score()` receives `entityBoost = 1.0` when the caller doesn't supply
  `entityBoostFor` (new fourth optional arg). Existing call sites that
  pass `(hit, callerCtx)` get `entityBoost = 1.0` by default — current
  tests (`rank.test.js`) keep their expected score values.
- `TRUST_FACTOR` unchanged. `_scopeBoost` unchanged.

New signature:

```js
score(hit, callerCtx = {}, entityBoost = 1.0)
```

Or, equivalently and cleaner, pass `entityBoost` through `callerCtx`:

```js
score(hit, { scope, session_id, entityBoost = 1.0 } = {})
```

We pick the `callerCtx` form to avoid breaking positional args.

### 3.5 Scoring for MCP `recall` tool

The MCP `recall` tool (`io/mcp/tools/recall.js:106-111`) writes its own
`recall_log` rows but doesn't run `rank.score` or MMR — it returns raw
hits with `dist` only. A2 doesn't fire for MCP-recall rows because
there is no composite scoring step there. Replay mode (A3) handles
this by reading `meta.from`:

- `intuition` rows: replay with A1 + A2.
- `mcp_recall` rows: replay with A1 only (vector dedup only, no
  composite score, no entity boost).

This matches prod: A2 is an intuition-injection feature.

### 3.6 Telemetry

`intuition_telemetry`:

- `entity_boost_applied: bool` — at least one hit had `entityBoost > 1.0`.
- `entity_boost_count: int` — number of hits that got a boost.
- `query_entities_matched: int` — `matchedEntityIds.size`.

`recall_log.ranked_hits[*].score_components` gains `entityBoost` and
`entityBoostCount` (additive in FLEXIBLE objects).

## Section 4 — Shared schema additions

Single migration: `0010-recall-eval-and-mmr.surql`. (B1 owns `0009`, this
plan owns `0010`, C1 owns `0011`, D1 owns `0012`/`0013`/`0014`; the plan
header enumerates the full claim list.)

```surql
-- A3
DEFINE TABLE recall_eval_runs SCHEMAFULL TYPE NORMAL;
-- ... fields per §1.5 ...

-- A1+A2 telemetry: intuition_telemetry needs FLEXIBLE meta. Today its
-- columns are fixed (0001-init.surql:279-286). Add an option<object>
-- FLEXIBLE meta field; existing rows get NONE.
DEFINE FIELD meta ON intuition_telemetry TYPE option<object> FLEXIBLE;

-- runtime configs (UPSERT-style seed; safe to re-run).
UPSERT runtime:recall_eval CONTENT {
  value: {
    min_rows: 100,
    precision_at_6_min: 0.20,
    ndcg_at_6_min: 0.35,
    no_signal_rate_max: 0.30,
    mean_rank_of_neg_at_10_min: 4.0,
    default_window_days: 30,
    default_k: 6,
    default_limit: 5000
  }
};

-- Field-path UPDATE preserves the existing keys in runtime:recall.value
-- (rrf_k, knn_overfetch_base, knn_overfetch_per_filter, mmr_threshold,
-- already set by the hybrid-retrieval spec). UPSERT MERGE would replace
-- the entire `value` object — not what we want.
UPDATE runtime:recall SET
  value.mmr_threshold = value.mmr_threshold ?? 0.92,
  value.mmr_threshold_legacy_substring = value.mmr_threshold_legacy_substring ?? 0.85,
  value.mmr_use_cosine = value.mmr_use_cosine ?? true,
  value.entity_boost_enabled = value.entity_boost_enabled ?? true,
  value.entity_boost_per_overlap = value.entity_boost_per_overlap ?? 0.10,
  value.entity_boost_max = value.entity_boost_max ?? 1.25,
  value.entity_catalog_size = value.entity_catalog_size ?? 500,
  value.entity_catalog_ttl_seconds = value.entity_catalog_ttl_seconds ?? 60;
```

The `?? <default>` form is idempotent on re-run (matches existing
migration idioms in `0001-init.surql`). The migration runner already
supports multi-statement files.

`recall_log` requires no schema change — `ranked_hits[*]` is already
FLEXIBLE (`0001-init.surql:298`), so new score-component keys land
without DDL.

## Section 5 — File-by-file changes

**Created:**

- `system/cognition/intuition/vectors.js` — `loadVectorsForHits`, `cosineSim`.
- `system/cognition/intuition/entities.js` — `tokensOf`, `matchCatalogEntities`, `matchPriorTailEntities`, `aboutEntitiesForMemos`, `readEntityCatalog` (with TTL cache).
- `system/runtime/cli/commands/recall-eval.js` — CLI entry: parses flags, opens DB, dispatches to eval module.
- `system/cognition/intuition/eval.js` — eval engine: window scan, label assignment, metric computation, replay loop. Pure data-in / data-out; no CLI concerns.
- `system/data/db/migrations/0010-recall-eval-and-mmr.surql` — schema + runtime seeds per §4.
- `system/tests/unit/intuition-cosine.test.js` — cosine helper unit, MMR with mocked vectors, fallback to substring.
- `system/tests/unit/intuition-entity-boost.test.js` — match function, boost computation, bounds.
- `system/tests/unit/rank-score-entity-boost.test.js` — `rank.score` with `entityBoost` in callerCtx; regression on `entityBoost = 1.0` default.
- `system/tests/unit/recall-eval-metrics.test.js` — metric formulas against synthetic label fixtures.
- `system/tests/integration/intuition-end-to-end.test.js` — full `intuitionEndpoint` call with seeded events+memos+entities; verifies entityBoost surfaces, MMR cosine path fires.
- `system/tests/integration/recall-eval-replay.test.js` — runs the harness against a seeded `recall_log` + `events` + `embeddings_*` fixture; verifies precision@k.
- `system/tests/fixtures/recall-eval-golden.json` — fixed corpus: ~30 recall rows with known labels and expected metrics.

**Modified:**

- `system/cognition/intuition/inject.js`:
  - Accept a new `sessionId` param in `intuitionEndpoint`'s args.
  - Write `session_id` onto the `recall_log` row (prerequisite for A3 labels).
  - Add `meta.from = 'intuition'` to both `intuition_telemetry` and `recall_log` writes.
  - Replace `substringOverlap`-only MMR with the §2.4 fallback chain.
  - Read entity catalog + matched entity ids before the score loop; pass `entityBoost` to `rank.score` via callerCtx.
  - Emit `mmr_drops`, `mmr_path`, `mmr_vec_coverage`, `entity_boost_applied`, `entity_boost_count`, `query_entities_matched` into `intuition_telemetry.meta`.
- `system/cognition/intuition/handler.js` (lines 126-154):
  - Pull `session_id` from the UserPromptSubmit hook stdin (Claude Code emits `session_id` at the top level of its hook payload; tolerate `sessionId` alias for symmetry with the daemon).
  - Forward as `session_id` in the POST body to `/internal/intuition`.
- `system/runtime/daemon/server.js` (lines 897-919):
  - Extract `body.session_id ?? body.sessionId ?? null` (mirrors the pattern at `server.js:671,725,748`).
  - Pass as `sessionId` into `intuitionEndpoint`'s args.
- `system/cognition/intuition/rank.js`:
  - `score` accepts `entityBoost` (and `entityBoostCount`) via callerCtx. Includes them in returned `components`.
  - `mmrLite` unchanged in signature; new threshold flows in from caller.
- `system/cognition/memory/store.js`:
  - Export `getRecallConfig` so `inject.js` reads the same cached config as `_surfaceSearch`. (Today `getRecallConfig` is module-local.)
- `system/io/mcp/tools/recall.js`:
  - Add `meta.from = 'mcp_recall'` and `meta.latency_ms` to the `recall_log` write.
- `system/runtime/cli/index.js`:
  - Register `recall-eval` subcommand.
- `docs/architecture.md` — short "Recall eval" paragraph under the diagram.
- `docs/faculties.md` — "recall" section gains an "Evaluation" subsection.

## Section 6 — Telemetry summary

| Field | Where | What |
|---|---|---|
| `intuition_telemetry.meta.mmr_drops` | inject.js | hits suppressed by MMR |
| `intuition_telemetry.meta.mmr_path` | inject.js | 'cosine' or 'substring' |
| `intuition_telemetry.meta.mmr_vec_coverage` | inject.js | vector fraction in [0,1] |
| `intuition_telemetry.meta.entity_boost_applied` | inject.js | bool |
| `intuition_telemetry.meta.entity_boost_count` | inject.js | hit count with boost > 1 |
| `intuition_telemetry.meta.query_entities_matched` | inject.js | matched catalog entries |
| `recall_log.ranked_hits[*].score_components.entityBoost` | inject.js | multiplier per hit |
| `recall_log.ranked_hits[*].score_components.entityBoostCount` | inject.js | overlap count per hit |
| `recall_log.meta.from` | inject.js, recall.js | 'intuition' or 'mcp_recall' |
| `recall_log.meta.latency_ms` | inject.js (existing), recall.js (new) | per-recall ms |
| `recall_eval_runs.*` | recall-eval.js | per-run rollup row (§1.5) |

`explain_recall` (Theme 4 MCP tool) already reads
`recall_log.ranked_hits[*].score_components`; the new keys flow through
without code change. `explain_recall` should be updated to surface the
new keys in its output (one-line change), tracked under Theme 4.

## Section 7 — Cost envelope

**A1 per recall:**

- +1 batched `SELECT record, vector` query per non-empty surface (typically
  1–2). At 1024-dim, 6 vectors = 24 KiB transferred. Sub-millisecond on the
  embedded engine.
- Cosine compute: 6 hits → max 15 pairs × 1024 multiplies ≈ 15 K ops, ~50 µs.
- No extra LLM calls. No extra embed calls.

**A2 per recall:**

- +1 catalog read every 60s (cached). Negligible amortized.
- +1 batched `SELECT in, out FROM edges` for memo `about` edges. Indexed
  via `edges_kind_in`; one round-trip.
- Tokenize query + prior tail in JS: O(query_chars). Sub-microsecond.
- No extra LLM calls. No extra embed calls.

**A3 per run:**

- Scoring (non-replay): `SELECT recall_log ... LIMIT N` + `SELECT events
  WHERE meta.kind = 'correction'` over the window + per-row joining in
  JS. Bounded by N = `--limit` (default 5000). One full run completes in
  seconds.
- Replay: N rows × (1 hydrate query + 1 vector query + 1 embed call +
  in-JS score+MMR). Embed dominates. At 5000 rows × 50 ms ≈ 4 min.
  `--limit` keeps the upper bound predictable.

Total per-recall added latency: ~3-8 ms on the embedded engine. Well
inside the existing `latency_p50 ≈ 60 ms` envelope; flagged in §6 telemetry
so we can verify post-rollout.

**Regression guard, not a precise budget.** Phase 6 Task 6.2's
`intuition-cosine-end-to-end.test.js` asserts a soft upper bound
(`latency_ms < 200`) on the full endpoint round-trip so a future
refactor that accidentally adds a second vector-hydration round-trip
trips a test. The number is a regression guard, not a budget — small
upward drift on shared CI is acceptable; large jumps (≥3× headroom
collapse) require investigation.

## Section 8 — Test plan

**Unit:**

1. `intuition-cosine.test.js`:
   - `cosineSim` on synthetic vectors: orthogonal → 0, identical → 1,
     opposite → -1, mismatched dim → 0.
   - `mmrLite` with mocked cosineFn and threshold 0.92 — confirms two
     hits with cosine 0.95 collapse, two with cosine 0.80 both survive.
   - Fallback fires when `loadVectorsForHits` returns empty map.
2. `intuition-entity-boost.test.js`:
   - `tokensOf` strips short tokens (<3 chars).
   - `matchCatalogEntities` — exact token match, no substring match, no
     accidental matches on common words.
   - `entityBoostFor` — overlap 0 → 1.0; overlap 1 → 1.10; overlap 5 →
     1.25 (capped).
3. `rank-score-entity-boost.test.js`:
   - `score(hit, {})` returns same value as pre-A2 (regression guard:
     freeze a fixture's pre-A2 score and assert equality with
     `entityBoost` defaulting to 1.0).
   - `score(hit, { entityBoost: 1.25 })` increases composite by exactly
     1.25× (modulo float).
4. `recall-eval-metrics.test.js`:
   - precision@k, recall@k, nDCG@k on synthetic label arrays match
     hand-computed reference values.
   - mean_rank_of_negatives correctly skips rows with no negatives.

**Integration:**

5. `intuition-end-to-end.test.js`:
   - Seed events + memos + entities + `about` edges.
   - Call `intuitionEndpoint` with a query that should hit the entity boost.
   - Read back `intuition_telemetry` and `recall_log`; verify
     `score_components.entityBoost > 1.0` on at least one hit,
     `mmr_path = 'cosine'` recorded.
6. `recall-eval-replay.test.js`:
   - Seed ≥8 `recall_log` rows with mixed outcomes (`reinforced`,
     `corrected`, `evaluated_no_signal`) + matching `events` +
     `embeddings_*` rows.
   - Run the eval module in replay mode.
   - Assert `rows_scored`, `rows_pending`, and multiple metric values
     (`precision_at_3`, `recall_at_3`, `no_signal_rate`,
     `mean_rank_of_negatives_at_10`) match hand-computed values within
     ±0.001.
7. `recall-eval-cli.test.js`:
   - Spawn `node system/bin/robin recall-eval --json --limit 5` against
     a seeded DB.
   - Assert exit code 0 and the printed JSON has the expected keys.

**Regression:**

8. `intuition-substring-fallback.test.js`:
   - Drop all `embeddings_*` rows for the test profile.
   - Call `intuitionEndpoint`; verify it succeeds, `mmr_path =
     'substring'`, and dedup still happens.
9. `rank-pre-a2-fixture.test.js`:
   - Existing rank.test.js golden values remain valid (no
     `entityBoost` in callerCtx → composite unchanged).
10. `reinforcement-loop-compat.test.js`:
    - Run reinforcement against `recall_log` rows that have new
      `score_components.entityBoost` keys; verify no read errors and
      the loop still buckets correctly.

**CLI surface:**

11. `recall-eval-exit-codes.test.js`:
    - Force `rows_scored < min_rows` → exit code 1.
    - Force a threshold breach → exit code 2.
    - Force DB-open failure → exit code 3.

## Section 9 — Sequencing within the bundle

1. **A3 first (read-only).** Lands the migration (`recall_eval_runs`
   table + runtime seeds), the eval module, the CLI command, and the
   `meta.from` + `meta.latency_ms` + `session_id` annotations on
   `recall_log` writes. Reads only — does not change recall behavior.
   Backfill stats: run `robin recall-eval --window 90d` against current
   data to establish baseline metrics. **Insert these baselines into
   `runtime:recall_eval.thresholds`** as the regression floor.

2. **A1 second (flag-gated).** Add `vectors.js`, `loadVectorsForHits`,
   cosine MMR path in `inject.js`. The §4 migration has already seeded
   `runtime:recall.value.mmr_use_cosine = true`; revert is one UPDATE
   away. Run the harness against a 1-week window post-deploy; expect
   `precision@6` ≥ baseline (the change is dedup-only, so the floor is
   "no regression," not "improvement"). If regressed, flip the flag off
   and inspect the per-source breakdown.

3. **A2 last (depends on catalog access pattern).** Land
   `entities.js`, catalog cache, boost computation, score formula
   change. The §4 migration has already seeded
   `runtime:recall.value.entity_boost_enabled = true`. Run the harness;
   expect `precision@6` ≥ baseline + 0.02 (~10% relative improvement
   target). Tune `entity_boost_per_overlap` if Δ is below threshold or
   `entity_boost_applied` is rare (≪ 10% of recalls).

Each step lands as a separate PR. Step 2 and 3 do not require schema
changes after step 1's migration; reverting them is code-only.

## Section 10 — Dependencies & soft conflicts

- **Depends on** Theme 4 (introspection): `explain_recall` reads the
  `score_components` field A2 extends. Theme 4 has shipped; new keys
  are additive.
- **Reads from** Theme 2a (evidence ledger): no direct read today, but
  future eval modes ("memo with ≥3 refutes downranked correctly?")
  will join `evidence_ledger` against scoring. Out of scope here.
- **Soft conflict with future B1** (per-hit used markers). When B1
  lands, A3's soft-positive condition tightens (§1.3). Path is
  forward-compatible: new metric keys, not a metric replacement.
- **No conflict with** Theme 1a (compaction): archived memos drop out
  of recall surfaces; A3 sees them as `rows_skipped` under "record
  gone." That's a true negative — we don't want to score archived
  hits.
- **No conflict with** Theme 1b (arcs): arcs ride on top of episodes;
  entity boost reads `about` edges, which arcs don't touch.

## Section 11 — Open questions (post-impl review)

- **Per-entity precision rollups.** Earlier drafts proposed a
  `per_entity` array on `recall_eval_runs` keyed by catalog entity id,
  reporting precision@k restricted to hits whose memos `about` that
  entity. Dropped from v1: the join (recall_log → memo → `about` →
  entity) is non-trivial and the use case ("which entities are recall
  failing most on?") is not yet validated. If a user pattern emerges
  where boosts saturate on a small subset of entities, re-introduce
  this rollup. Schema is forward-compatible — the field can be added
  later without backfilling old rows.

- **Should A2 boost event hits, or only memo hits?** Currently
  memo-only (§3.3). Events accumulate `mentions` edges, not `about`;
  the semantic is "this event names entity X" rather than "this fact
  is about entity X." Lower confidence boost on events feels right,
  but it's a number we should validate with the harness.

- **Per-session entity-boost dedup.** A single query can match many
  catalog entities (e.g., a long question listing several projects).
  The current formula caps overlap-count → boost via `min(1.25, ...)`;
  no dedup needed. Revisit if telemetry shows boosts saturating.

- **Vector hydration scope.** Today `loadVectorsForHits` fetches
  vectors for the union of event+memo hits. If the post-RRF top-k
  contains 6 hits across both surfaces, that's two queries. Could be
  one UNION query — simpler code, similar perf. Defer until a profiler
  says it matters.

- **Replay determinism under embedder change.** If the active
  embedding profile changes between recall row insertion and replay,
  the re-embedded query lives in a different vector space. A3's
  replay mode hard-errors in that case (§1.9). The alternative —
  storing the historical query vector inside `recall_log.meta` — costs
  ~4 KiB per row at 1024-dim and would be wasted disk for the 95% of
  rows we never replay. Reject; document the constraint.

- **Entity catalog cache invalidation.** 60-second TTL. New entities
  created by biographer arrive in the catalog up to 60s late on the
  recall path. Acceptable for a recall-side feature; if entities-just-
  -created become a hot pattern, drop TTL to 10s. Don't invalidate on
  every write — the biographer fan-out would invalidate constantly.

- **MCP `recall` tool boost.** A2 is intuition-only. If MCP recall
  starts returning more candidates than today, layering A2 on top is a
  small refactor. Out of scope for v1.

## See also

- `2026-05-11-robin-v2-evolution-roadmap.md` — umbrella.
- `2026-05-11-robin-v2-theme-4-observability-design.md` — `explain_recall`.
- `2026-05-11-robin-v2-theme-2a-evidence-ledger-design.md` — refutation
  path; future eval mode reads its ledger.
- `2026-05-11-surrealdb-improvements-design.md` — hybrid retrieval,
  RRF, per-surface embeddings, `runtime:recall.value` config row.
- `system/cognition/intuition/inject.js:43-53` — `substringOverlap`
  replaced by A1.
- `system/cognition/intuition/rank.js:39-69` — composite score formula
  extended by A2.
- `system/cognition/intuition/reinforcement.js:111-159` — label source
  for A3.
- `system/cognition/memory/store.js:447-640` — `_surfaceSearch` + RRF
  pipeline that A1+A2 sit downstream of.
