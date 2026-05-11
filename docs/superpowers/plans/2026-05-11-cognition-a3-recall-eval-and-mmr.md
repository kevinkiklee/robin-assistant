# Cognition A3 + A1 + A2 — recall eval harness, real-cosine MMR, entity-aware boost · Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a read-only recall eval harness (A3) that scores historical `recall_log` rows against correction-derived labels and writes per-run rollups to a new `recall_eval_runs` table. Then replace `inject.js`'s substring-overlap MMR with real cosine over batched-hydrated embedding vectors (A1) and add a bounded entity-aware boost to the composite score (A2) — both flag-gated so a regression can be reverted without redeploy.

**Architecture:** A3 ships first (read-only, no recall-path risk) and produces the baseline numbers used to gate A1+A2 rollout. A1 adds `vectors.js` (batched `SELECT record, vector FROM embeddings_<profile>_<surface> WHERE record IN $ids` + cosine helper) and rewires the MMR call in `inject.js` behind `runtime:recall.value.mmr_use_cosine`. A2 adds `entities.js` (60-second-TTL entity catalog cache + token-equality match + batched `about`-edge lookup) and threads a bounded `entityBoost ∈ [1.0, 1.25]` through `rank.score`'s `callerCtx`. All three share telemetry surfaces (`intuition_telemetry.meta`, `recall_log.ranked_hits[*].score_components`) and one migration (`0010-recall-eval-and-mmr.surql`).

**Tech Stack:** Node.js 18+, ES modules, SurrealDB 3.0.5 / `surrealkv://`, Biome (lint), `node --test` (runner).

**Spec:** `docs/superpowers/specs/2026-05-11-cognition-a3-recall-eval-and-mmr-design.md`

**Dependencies:**
- Theme 2a (evidence ledger) shipped — `reinforcement.js` already emits per-hit refute rows.
- Theme 4 (observability) shipped — `explain_recall` reads `recall_log.ranked_hits[*].score_components`; A2's new keys flow through additively.
- `feat/surrealdb-improvements` — hybrid retrieval + `runtime:recall.value` config row + per-surface embedding tables.
- **Migration number coordination.** B1 owns `0009-per-hit-reinforcement.surql` (`docs/superpowers/specs/2026-05-11-cognition-b1-per-hit-reinforcement-design.md:94`); A3 owns `0010-recall-eval-and-mmr.surql`; C1 owns `0011`; D1 owns `0012`/`0013`/`0014`. If any plan lands out of order, bump. Every reference to this plan's migration filename uses `0010-recall-eval-and-mmr.surql`.
- **Pre-req coordination (session_id wiring):** the spec's §"Why session_id must be plumbed" pre-req (handler.js → daemon → inject.js) is also relevant to B1's `reply_event_id` correlation. Phase 0 below ships it once; B1 reuses the wired plumbing. If B1's Phase 0 has already shipped, A3's Phase 0 verifies and proceeds as a no-op. The daemon body field is `session_id` (snake_case, matches the `recall_log.session_id` column); locally we destructure to `sessionId`.
- **Daemon route location.** Where this plan instructs `system/runtime/daemon/server.js` (around line 897-919): if `system/runtime/daemon/routes/intuition.js` exists (R-3 has shipped — see `docs/superpowers/plans/2026-05-11-runtime-layer-hardening.md`), edit there. Otherwise edit the inline handler at the cited server.js line range.
- **`recall_log.meta` field-ownership contract.** A3 reads `focus_block_present` (bool) and `focus_block_tokens` (int) on `recall_log.meta` (defaults `false`/`0` written by A3 Phase 11; D1 flips them to real values when it lands). B1 puts `reply_event_id` and `attribution` at top level of `recall_log`, not under `.meta` — non-colliding.

---

## File structure

| File | Status | Responsibility |
|---|---|---|
| `system/data/db/migrations/0010-recall-eval-and-mmr.surql` | **new** | `recall_eval_runs` table; `intuition_telemetry.meta` FLEXIBLE; `runtime:recall_eval.thresholds` seed; UPDATE `runtime:recall.value` with A1/A2 defaults |
| `system/cognition/intuition/vectors.js` | **new** | `loadVectorsForHits(db, {eventIds, memoIds})`, `cosineSim(a, b)` |
| `system/cognition/intuition/entities.js` | **new** | `tokensOf`, `matchCatalogEntities`, `aboutEntitiesForMemos`, `readEntityCatalog` (60s TTL cache), `entityBoostFromAboutIds` |
| `system/cognition/intuition/eval.js` | **new** | Pure-data eval engine: scoreRows, replayRow, runEval. No CLI/stdio |
| `system/cognition/intuition/eval-labels.js` | **new** | Label-derivation (negative/soft_positive/unlabeled) given `recall_log` row + correction events |
| `system/cognition/intuition/eval-metrics.js` | **new** | precision@k, recall@k, nDCG@k, mean_rank_of_negatives, no_signal_rate |
| `system/runtime/cli/commands/recall-eval.js` | **new** | CLI command — parses flags, opens DB, dispatches to eval module, persists `recall_eval_runs` row, prints text or JSON, sets exit code |
| `system/runtime/cli/index.js` | modify | Register `recall-eval` subcommand |
| `system/cognition/intuition/inject.js` | modify | Accept `sessionId`; write `session_id` + `meta.from='intuition'` on `recall_log`; rewire MMR to cosine path (fallback to substring); thread `entityBoost` through `rank.score` callerCtx; emit new telemetry keys |
| `system/cognition/intuition/handler.js` | modify | Pull `session_id` from hook stdin; forward in POST body |
| `system/runtime/daemon/server.js` (or `system/runtime/daemon/routes/intuition.js` if R-3 has shipped) | modify | Extract `body.session_id`/`body.sessionId`; pass `sessionId` into `intuitionEndpoint` |
| `system/cognition/intuition/rank.js` | modify | `score()` reads `entityBoost`/`entityBoostCount` from `callerCtx`; includes them in returned `components`; multiplicatively combined into total |
| `system/cognition/memory/store.js` | modify | Export `getRecallConfig` (currently module-local) so `inject.js` reuses the cache |
| `system/io/mcp/tools/recall.js` | modify | Add `meta.from='mcp_recall'` and `meta.latency_ms` to recall_log write |
| `system/tests/fixtures/recall-eval-golden.json` | **new** | recall_log rows with known outcomes + expected metrics |
| `system/tests/unit/intuition-cosine.test.js` | **new** | cosineSim unit + mmrLite with mocked cosineFn |
| `system/tests/unit/intuition-vectors-load.test.js` | **new** | `loadVectorsForHits` against seeded `embeddings_*` rows |
| `system/tests/unit/intuition-entities.test.js` | **new** | `tokensOf`, `matchCatalogEntities`, `entityBoostFromAboutIds` bounds |
| `system/tests/unit/intuition-entities-catalog.test.js` | **new** | `readEntityCatalog` TTL cache behavior |
| `system/tests/unit/rank-score-entity-boost.test.js` | **new** | `rank.score(hit, {entityBoost})` regression + bounds |
| `system/tests/unit/recall-eval-labels.test.js` | **new** | Label-derivation across fixture rows |
| `system/tests/unit/recall-eval-metrics.test.js` | **new** | precision/recall/nDCG/mean_rank vs hand-computed values |
| `system/tests/unit/recall-eval.test.js` | **new** | scoreRows against golden fixture |
| `system/tests/unit/recall-eval-replay.test.js` | **new** | replayRow with mocked embedder + vectors |
| `system/tests/integration/intuition-cosine-end-to-end.test.js` | **new** | Full `intuitionEndpoint` asserts `mmr_path='cosine'`, `session_id` on recall_log |
| `system/tests/integration/intuition-substring-fallback.test.js` | **new** | Disabling cosine flag → MMR falls back to substring path |
| `system/tests/integration/intuition-mmr-diversity.test.js` | **new** | Threshold tuning changes MMR drop count |
| `system/tests/integration/intuition-entity-boost-end-to-end.test.js` | **new** | Seeded entity + about edge → entityBoost > 1.0 surfaces |
| `system/tests/integration/recall-eval-cli.test.js` | **new** | Spawns `node system/bin/robin recall-eval --json --limit 5` against seeded DB; asserts exit code + JSON shape |
| `system/tests/integration/recall-eval-replay-end-to-end.test.js` | **new** | Replay against seeded recall_log + embeddings_* fixture; precision@k within ±0.001 |
| `docs/faculties.md` | modify | "intuition" + "recall" subsections gain MMR-cosine + entity-boost + eval-harness paragraphs |
| `docs/development.md` | modify | `robin recall-eval` CLI usage |

---

## Phase 0 — Pre-req: verify (or ship) `session_id` end-to-end plumbing

> **Why first:** A3's labels join `recall_log.session_id` to `events.meta.session_id` in a 5-minute window (`reinforcement.js:31,54,70-81`). `inject.js` currently writes `recall_log` rows without `session_id` (lines 202-212) because `intuitionEndpoint` never receives one. Without this fix, intuition-source rows fall into the `__null__` bucket and A3's labels collapse to a near-no-op.
>
> **Coordination with B1:** B1 (`docs/superpowers/plans/2026-05-11-cognition-b1-per-hit-reinforcement.md`) needs the same plumbing for `reply_event_id` correlation, and B1's Phase 0 ships it. If B1 has already landed by the time A3 starts, this entire phase is a no-op — verify and proceed. Otherwise, ship the plumbing here verbatim; B1's later Phase 0 will be the no-op.

### Task 0 — Verify or fallback-implement the `session_id` plumbing

**Files (verification only):** none.
**Files (fallback implementation):** `system/cognition/intuition/handler.js`, `system/runtime/daemon/server.js` (or `system/runtime/daemon/routes/intuition.js` if R-3 has shipped), `system/cognition/intuition/inject.js`, plus their unit tests.

- [ ] **Step 1: Verify B1 plumbing has landed**

```bash
git log --all --oneline --grep='forward session_id' | head -5
grep -n 'session_id' system/cognition/intuition/handler.js | head -3
grep -n 'sessionId' system/cognition/intuition/inject.js | head -3
```

If the grep shows `session_id` flowing through `handler.js` into the POST
body and `sessionId` is accepted in `intuitionEndpoint`'s args
destructuring, **and** a `recall_log` write line includes
`session_id: sessionId`, this phase is a no-op. Run:

```bash
npm run test:unit -- --test-name-pattern 'session_id|sessionId'
```

If those tests pass, **skip to Phase 1**. Otherwise proceed to Step 2.

#### Step 2 (fallback): Handler forwards `session_id` from hook stdin

> Ship the plumbing verbatim from B1's plan. Steps 2a–2e below are
> identical to B1 Phase 0 — landing them here lets A3 proceed without
> waiting for B1.

- [ ] **Step 2a: Failing test**

Append to `system/tests/unit/intuition-handler.test.js`:

```js
test('intuitionHandler forwards session_id from stdin to /internal/intuition body', async () => {
  let capturedBody = null;
  const stubFetch = async (_url, init) => {
    capturedBody = JSON.parse(init.body);
    return { ok: true, json: async () => ({ block: '' }) };
  };
  await intuitionHandler({
    stdin: {
      prompt: 'hi',
      transcript_path: '',
      session_id: 'sess-abc',
    },
    stdout: () => {},
    stderr: () => {},
    readState: async () => ({ port: 1, pid: 1 }),
    fetchFn: stubFetch,
  });
  assert.equal(capturedBody.session_id, 'sess-abc');
});
```

- [ ] **Step 2b: Run → fail**

```bash
npm run test:unit -- --test-name-pattern 'forwards session_id'
```

Expected: failing assertion `expected 'sess-abc', got undefined`.

- [ ] **Step 2c: Implement**

Add to `handler.js` after `pickTranscriptPath`:

```js
function pickSessionId(stdin) {
  if (!stdin || typeof stdin !== 'object') return null;
  const a = stdin.session_id ?? stdin.sessionId;
  return typeof a === 'string' && a.length > 0 ? a : null;
}
```

In `intuitionHandler`, after `const priorAssistant = readPriorAssistant(transcriptPath);`, add:

```js
const sessionId = pickSessionId(stdin);
```

In the `body: JSON.stringify({ ... })` block at `handler.js:147-153`, add one new field:

```js
body: JSON.stringify({
  query,
  prior_assistant: priorAssistant,
  k: 6,
  recency_days: 30,
  token_budget: 1500,
  session_id: sessionId,
}),
```

- [ ] **Step 2d: Run → pass**

```bash
npm run test:unit -- --test-name-pattern 'forwards session_id'
```

- [ ] **Step 2e: Commit**

```bash
git commit -m "feat(intuition): forward session_id from UserPromptSubmit hook"
```

#### Step 3 (fallback): Daemon extracts `session_id` and passes to endpoint

**Files:** `system/runtime/daemon/server.js` (or `system/runtime/daemon/routes/intuition.js` if R-3 has shipped — see `docs/superpowers/plans/2026-05-11-runtime-layer-hardening.md`).

- [ ] **Step 3a: Read context**

If `system/runtime/daemon/routes/intuition.js` exists (R-3 has shipped),
edit there. Otherwise open `system/runtime/daemon/server.js` and locate
the intuition handler (lines 897-919). The existing pattern at lines 671,
725, 748 uses `body.session_id ?? body.sessionId ?? null`.

- [ ] **Step 3b: Edit the endpoint dispatch (line 903 region of server.js, or the equivalent block in `routes/intuition.js` post-R-3)**

Replace the `intuitionEndpoint({...}).catch(...)` block with:

```js
const result = await intuitionEndpoint({
  db: dbHandle,
  embedder: embedderWrap,
  detector,
  query: body.query ?? '',
  priorAssistant: body.prior_assistant ?? body.priorAssistant ?? '',
  k: body.k ?? 6,
  recencyDays: body.recency_days ?? body.recencyDays ?? 30,
  tokenBudget: body.token_budget ?? body.tokenBudget ?? 1500,
  sessionId: body.session_id ?? body.sessionId ?? null,
}).catch(() => ({ block: '', hits: 0, tokens: 0, latency_ms: 0 }));
```

- [ ] **Step 3c: Commit**

```bash
git commit -m "feat(daemon): pass session_id into intuitionEndpoint"
```

#### Step 4 (fallback): Endpoint writes `session_id` onto `recall_log`

**Files:** `system/cognition/intuition/inject.js`, `system/tests/unit/intuition-endpoint.test.js`

- [ ] **Step 4a: Failing test**

Append to `system/tests/unit/intuition-endpoint.test.js`:

```js
test('intuitionEndpoint writes session_id onto recall_log when provided', async () => {
  const db = await fresh();
  const e = createStubEmbedder({ dimension: 1024 });
  await recordEvent(db, e, { source: 'cli', content: 'discussed sourdough hydration ratio (62%)' });
  await intuitionEndpoint({
    db, embedder: e, detector: null,
    query: 'sourdough', priorAssistant: '',
    k: 6, recencyDays: 30, tokenBudget: 1500,
    sessionId: 'sess-xyz',
  });
  const [rows] = await db.query(surql`SELECT session_id FROM recall_log`).collect();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].session_id, 'sess-xyz');
});
```

- [ ] **Step 4b: Run → fail**

```bash
npm run test:unit -- --test-name-pattern 'writes session_id onto recall_log'
```

- [ ] **Step 4c: Implement**

In `inject.js` `intuitionEndpoint`'s args destructuring (lines 74-83), add `sessionId`:

```js
export async function intuitionEndpoint({
  db,
  embedder,
  query,
  priorAssistant = '',
  k = 6,
  recencyDays = 30,
  tokenBudget = 1500,
  sessionId = null,
}) {
```

In the `recall_log` write at lines 204-210, add `session_id`:

```js
await db
  .query(
    surql`CREATE recall_log CONTENT ${{
      query: safeQuery,
      k,
      ranked_hits: rankedHits,
      outcome: 'pending',
      session_id: sessionId,
      meta: { latency_ms, truncated },
    }}`,
  )
  .collect();
```

- [ ] **Step 4d: Run → pass**

```bash
npm run test:unit -- --test-name-pattern 'writes session_id onto recall_log'
```

- [ ] **Step 4e: Commit**

```bash
git commit -m "feat(intuition): persist session_id on recall_log writes"
```

---

## Phase 1 — A3 schema + config seeds

### Task 1.1 — Migration `0010-recall-eval-and-mmr.surql`

**Files:** `system/data/db/migrations/0010-recall-eval-and-mmr.surql`

- [ ] **Step 1: Verify number is free**

```bash
ls system/data/db/migrations/
```

This plan claims `0010-recall-eval-and-mmr.surql` (B1 owns `0009`, C1 owns
`0011`, D1 owns `0012`/`0013`/`0014`). The listing should not already
contain `0010-recall-eval-and-mmr.surql`. If a different `0010-*.surql`
already exists, escalate to the umbrella roadmap — do not silently
re-number.

- [ ] **Step 2: Create the migration file**

```surql
-- ============================================================================
-- Cognition A3 + A1 + A2 — recall eval harness, real-cosine MMR, entity boost
-- ============================================================================

-- A3: per-run rollup table.
--
-- Schema choice: SCHEMAFULL for the top-level identifying/window/count
-- columns + INDEX coverage; `metrics` and `per_source` are object
-- FLEXIBLE so new per-k or per-bucket keys land without DDL. The
-- per-focus-block stratification, replay_kendall_mean, and
-- rows_with_null_session_* counters are nested under `metrics` rather
-- than declared as top-level fields — SCHEMAFULL would otherwise
-- reject them.
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

-- A1+A2 telemetry: intuition_telemetry needs FLEXIBLE meta. Today its columns
-- are fixed (0001-init.surql:279-286). Add an option<object> FLEXIBLE meta
-- field; existing rows get NONE.
DEFINE FIELD meta ON intuition_telemetry TYPE option<object> FLEXIBLE;

-- A3: thresholds for exit-code gating. Tune after first baseline run.
UPSERT runtime:`recall_eval.thresholds` CONTENT {
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

-- A1+A2: extend runtime:recall.value with new keys. Field-path UPDATE
-- preserves the existing rrf_k / knn_overfetch_* / mmr_threshold keys set by
-- the hybrid-retrieval migration. The `?? <default>` form is idempotent on
-- re-run.
--
-- We reuse the existing `mmr_threshold` key for both paths. Substring
-- and cosine treat `0.92` as different distributions (substring is a
-- Jaccard-style overlap; cosine is a vector similarity). Only one path
-- fires per call; `mmr_use_cosine` picks the path. Splitting into
-- `mmr_threshold_cosine`/`mmr_threshold_substring` is a future task,
-- gated on telemetry showing distinct optimal defaults — until then the
-- single key plus `_legacy_substring` fallback is the contract.
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

- [ ] **Step 3: Verify migration runs cleanly**

```bash
npm run test:integration -- --test-name-pattern 'bootstrap-empty-db'
```

Expected output: `pass` and no SurrealQL errors. The bootstrap test runs all migrations on a fresh in-memory DB.

- [ ] **Step 4: Commit**

```bash
git commit -m "feat(schema): 0010-recall-eval-and-mmr — recall_eval_runs + intuition meta + runtime seeds"
```

### Task 1.2 — Export `getRecallConfig` from `store.js`

**Files:** `system/cognition/memory/store.js`

- [ ] **Step 1: Read current state**

`getRecallConfig` lives at `system/cognition/memory/store.js:473-487` as a module-local function. A1 needs `inject.js` to read the same cached config (specifically the new `mmr_use_cosine`, `mmr_threshold`, `mmr_threshold_legacy_substring`, `entity_boost_*` keys).

- [ ] **Step 2: Edit to export**

At `system/cognition/memory/store.js:473`, replace:

```js
async function getRecallConfig(db) {
```

with:

```js
export async function getRecallConfig(db) {
```

- [ ] **Step 3: Verify no callers regress**

```bash
grep -rn "getRecallConfig" system/
```

Expected: only the one definition + one internal call inside `_surfaceSearch`. No other modules import it yet — A1 will be the first external consumer.

- [ ] **Step 4: Commit**

```bash
git commit -m "refactor(memory): export getRecallConfig for intuition reuse"
```

---

## Phase 2 — A3 label-derivation module

### Task 2.1 — `eval-labels.js` pure label function

**Files:** `system/cognition/intuition/eval-labels.js`, `system/tests/unit/recall-eval-labels.test.js`

- [ ] **Step 1: Failing test**

Create `system/tests/unit/recall-eval-labels.test.js`:

```js
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { labelHits } from '../../cognition/intuition/eval-labels.js';

test('labelHits marks memos:* hits negative when outcome=corrected', () => {
  const row = {
    id: 'recall_log:r1',
    ts: new Date('2026-05-01T12:00:00Z'),
    session_id: 's1',
    outcome: 'corrected',
    ranked_hits: [
      { record: 'memos:m1', rank: 0 },
      { record: 'events:e1', rank: 1 },
      { record: 'memos:m2', rank: 2 },
    ],
  };
  const labels = labelHits(row, []);
  assert.deepEqual(
    labels.map((l) => l.label),
    ['negative', 'unlabeled', 'negative'],
  );
});

test('labelHits marks memos:* hits soft_positive when outcome=reinforced', () => {
  const row = {
    id: 'recall_log:r2',
    ts: new Date('2026-05-01T12:00:00Z'),
    session_id: 's1',
    outcome: 'reinforced',
    ranked_hits: [
      { record: 'memos:m1', rank: 0 },
      { record: 'memos:m2', rank: 1 },
    ],
  };
  const labels = labelHits(row, []);
  assert.deepEqual(
    labels.map((l) => l.label),
    ['soft_positive', 'soft_positive'],
  );
});

test('labelHits marks all hits unlabeled when outcome=pending or evaluated_no_signal', () => {
  const r1 = { id: 'recall_log:r3', ts: new Date(), outcome: 'pending', ranked_hits: [{ record: 'memos:m1', rank: 0 }] };
  const r2 = { id: 'recall_log:r4', ts: new Date(), outcome: 'evaluated_no_signal', ranked_hits: [{ record: 'memos:m1', rank: 0 }] };
  assert.equal(labelHits(r1, [])[0].label, 'unlabeled');
  assert.equal(labelHits(r2, [])[0].label, 'unlabeled');
});

test('labelHits attaches rank_index and record_id for downstream metrics', () => {
  const row = {
    id: 'recall_log:r5',
    ts: new Date(),
    outcome: 'reinforced',
    ranked_hits: [{ record: 'memos:m1', rank: 0 }, { record: 'memos:m2', rank: 1 }],
  };
  const labels = labelHits(row, []);
  assert.equal(labels[0].rank_index, 0);
  assert.equal(labels[0].record_id, 'memos:m1');
  assert.equal(labels[1].rank_index, 1);
});
```

- [ ] **Step 2: Run → fail**

```bash
npm run test:unit -- --test-name-pattern 'labelHits'
```

Expected: `Cannot find module .../eval-labels.js`.

- [ ] **Step 3: Implement**

Create `system/cognition/intuition/eval-labels.js`:

```js
// eval-labels.js — derive per-hit labels from a recall_log row + corrections.
//
// Per-hit label table (spec §1.3):
//   negative      : row.outcome='corrected' AND hit is memos:*
//   soft_positive : row.outcome='reinforced' AND hit is memos:*
//   unlabeled    : everything else (events, evaluated_no_signal, pending,
//                  non-memo hits)
//
// The function is pure: it takes the row + (unused-for-v1) correction array
// and emits an array of label objects, one per ranked_hits[] element. The
// correction array is plumbed in for future tightening (per-hit refute
// targeting once Theme 2a §12 lands) but is intentionally a no-op today.

function hitRecordIdString(hit) {
  const v = hit?.record ?? hit?.memo_id ?? hit?.event_id ?? hit?.record_id;
  if (v == null) return null;
  return typeof v === 'string' ? v : String(v);
}

/**
 * @param {{
 *   id: any, ts: any, session_id?: string,
 *   outcome: 'pending'|'reinforced'|'corrected'|'evaluated_no_signal',
 *   ranked_hits: Array<{ record: any, rank?: number }>
 * }} row
 * @param {Array<{ ts: any, sid?: string }>} _corrections
 *   Pre-fetched correction events in the recall row's 5-min window.
 *   Reserved for per-hit refute targeting (Theme 2a §12). Unused in v1.
 * @returns {Array<{ rank_index: number, record_id: string|null, label: 'negative'|'soft_positive'|'unlabeled' }>}
 */
export function labelHits(row, _corrections = []) {
  const hits = Array.isArray(row?.ranked_hits) ? row.ranked_hits : [];
  const outcome = row?.outcome ?? 'pending';
  return hits.map((hit, i) => {
    const recordId = hitRecordIdString(hit);
    const rankIndex = typeof hit?.rank === 'number' ? hit.rank : i;
    const isMemo = recordId?.startsWith('memos:') === true;
    let label = 'unlabeled';
    if (isMemo && outcome === 'corrected') label = 'negative';
    else if (isMemo && outcome === 'reinforced') label = 'soft_positive';
    return { rank_index: rankIndex, record_id: recordId, label };
  });
}
```

- [ ] **Step 4: Run → pass**

```bash
npm run test:unit -- --test-name-pattern 'labelHits'
```

- [ ] **Step 5: Commit**

```bash
git commit -m "feat(intuition): eval-labels — pure per-hit label derivation"
```

---

## Phase 3 — A3 metrics module

### Task 3.1 — `eval-metrics.js` pure metric functions

**Files:** `system/cognition/intuition/eval-metrics.js`, `system/tests/unit/recall-eval-metrics.test.js`

- [ ] **Step 1: Failing test**

Create `system/tests/unit/recall-eval-metrics.test.js`:

```js
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  precisionAtK,
  recallAtK,
  ndcgAtK,
  meanRankOfNegatives,
  noSignalRate,
} from '../../cognition/intuition/eval-metrics.js';

// Synthetic labelled rows. Each row is an array of label entries per
// labelHits()'s shape.
const ROW_ALL_POS = [
  { rank_index: 0, label: 'soft_positive' },
  { rank_index: 1, label: 'soft_positive' },
  { rank_index: 2, label: 'soft_positive' },
];
const ROW_MIXED = [
  { rank_index: 0, label: 'soft_positive' },
  { rank_index: 1, label: 'negative' },
  { rank_index: 2, label: 'unlabeled' },
];
const ROW_ALL_NEG = [
  { rank_index: 0, label: 'negative' },
  { rank_index: 1, label: 'negative' },
];

test('precisionAtK counts soft_positives / k, averaged over rows', () => {
  // ROW_ALL_POS@3 = 3/3=1.0; ROW_MIXED@3 = 1/3; avg = (1.0 + 1/3)/2 ≈ 0.6667
  const p = precisionAtK([ROW_ALL_POS, ROW_MIXED], 3);
  assert.ok(Math.abs(p - 0.6667) < 0.001, `got ${p}`);
});

test('recallAtK = soft_positives in top-k / soft_positives in full row', () => {
  // ROW_ALL_POS: top-1 has 1 sp, total sp=3 → recall@1 = 1/3
  const r = recallAtK([ROW_ALL_POS], 1);
  assert.ok(Math.abs(r - 0.3333) < 0.001, `got ${r}`);
});

test('recallAtK returns 0 for rows with zero soft_positives (avoids NaN)', () => {
  const r = recallAtK([ROW_ALL_NEG], 1);
  assert.equal(r, 0);
});

test('ndcgAtK uses non-negative gain max(0, 2^label - 1) projection', () => {
  // soft_positive=0.5 → gain = 2^0.5 - 1 ≈ 0.4142
  // negative=-1 → gain = max(0, 2^-1 - 1) = 0
  // ROW_MIXED@3 numerator: 0.4142/log2(2) + 0/log2(3) + 0/log2(4) = 0.4142
  // ideal: best gain ordering = [0.4142, 0, 0] → 0.4142
  // → nDCG@3 = 1.0
  const n = ndcgAtK([ROW_MIXED], 3);
  assert.ok(Math.abs(n - 1.0) < 0.001, `got ${n}`);
});

test('meanRankOfNegatives averages 1-indexed rank of negatives across rows', () => {
  // ROW_MIXED: negative at rank_index 1 → 1-indexed rank 2
  // ROW_ALL_NEG: negatives at 0,1 → 1-indexed ranks 1,2; row mean = 1.5
  // overall mean of row means = (2 + 1.5)/2 = 1.75
  const m = meanRankOfNegatives([ROW_MIXED, ROW_ALL_NEG]);
  assert.ok(Math.abs(m - 1.75) < 0.001, `got ${m}`);
});

test('meanRankOfNegatives returns null when no row has any negatives', () => {
  assert.equal(meanRankOfNegatives([ROW_ALL_POS]), null);
});

test('noSignalRate = count(outcome=evaluated_no_signal) / count(evaluated)', () => {
  const rows = [
    { outcome: 'reinforced' },
    { outcome: 'evaluated_no_signal' },
    { outcome: 'evaluated_no_signal' },
    { outcome: 'corrected' },
    { outcome: 'pending' }, // excluded
  ];
  const r = noSignalRate(rows);
  // evaluated = 4 (excludes pending); no_signal = 2 → 0.5
  assert.equal(r, 0.5);
});
```

- [ ] **Step 2: Run → fail**

```bash
npm run test:unit -- --test-name-pattern 'precisionAtK|recallAtK|ndcgAtK|meanRankOfNegatives|noSignalRate'
```

- [ ] **Step 3: Implement**

Create `system/cognition/intuition/eval-metrics.js`:

```js
// eval-metrics.js — pure metric formulas over labelled rows.
//
// Each `labelledRow` is an array of per-hit `{ rank_index, label }` entries
// produced by `labelHits()`.

const LABEL_GAIN = {
  soft_positive: 0.5,
  unlabeled: 0,
  negative: -1,
};

function gainFor(label) {
  const numeric = LABEL_GAIN[label] ?? 0;
  return Math.max(0, 2 ** numeric - 1);
}

function softPositivesInTopK(row, k) {
  let n = 0;
  for (const h of row) {
    if ((h.rank_index ?? 0) < k && h.label === 'soft_positive') n++;
  }
  return n;
}

function softPositivesTotal(row) {
  let n = 0;
  for (const h of row) if (h.label === 'soft_positive') n++;
  return n;
}

/**
 * precision@k averaged over rows.
 * @param {Array<Array<{ rank_index: number, label: string }>>} rows
 * @param {number} k
 * @returns {number}
 */
export function precisionAtK(rows, k) {
  if (!rows.length) return 0;
  let sum = 0;
  for (const row of rows) sum += softPositivesInTopK(row, k) / k;
  return sum / rows.length;
}

/**
 * recall@k averaged over rows. Rows with zero soft_positives contribute 0
 * (do not divide by zero).
 */
export function recallAtK(rows, k) {
  if (!rows.length) return 0;
  let sum = 0;
  for (const row of rows) {
    const total = softPositivesTotal(row);
    if (total === 0) continue;
    sum += softPositivesInTopK(row, k) / total;
  }
  return sum / rows.length;
}

/**
 * nDCG@k with non-negative gain projection: gain = max(0, 2^label - 1).
 * Idealised over the row's own hits.
 */
export function ndcgAtK(rows, k) {
  if (!rows.length) return 0;
  let sumNdcg = 0;
  let counted = 0;
  for (const row of rows) {
    const topK = row.filter((h) => (h.rank_index ?? 0) < k);
    if (topK.length === 0) continue;
    let dcg = 0;
    for (const h of topK) {
      const r = (h.rank_index ?? 0) + 1; // 1-indexed
      dcg += gainFor(h.label) / Math.log2(r + 1);
    }
    const idealGains = row
      .map((h) => gainFor(h.label))
      .sort((a, b) => b - a)
      .slice(0, k);
    let idcg = 0;
    for (let i = 0; i < idealGains.length; i++) {
      idcg += idealGains[i] / Math.log2(i + 2);
    }
    if (idcg <= 0) continue;
    sumNdcg += dcg / idcg;
    counted += 1;
  }
  return counted === 0 ? 0 : sumNdcg / counted;
}

/**
 * Average 1-indexed rank of `negative` hits, averaged across rows that have
 * at least one negative. Returns `null` if no row has any negatives.
 */
export function meanRankOfNegatives(rows) {
  let sumRowMeans = 0;
  let rowsWithNeg = 0;
  for (const row of rows) {
    const negRanks = [];
    for (const h of row) {
      if (h.label === 'negative') negRanks.push((h.rank_index ?? 0) + 1);
    }
    if (negRanks.length === 0) continue;
    let s = 0;
    for (const r of negRanks) s += r;
    sumRowMeans += s / negRanks.length;
    rowsWithNeg += 1;
  }
  return rowsWithNeg === 0 ? null : sumRowMeans / rowsWithNeg;
}

/**
 * no_signal_rate = rows with outcome='evaluated_no_signal' divided by all
 * evaluated rows (`pending` excluded).
 */
export function noSignalRate(rawRows) {
  let evaluated = 0;
  let noSignal = 0;
  for (const r of rawRows) {
    if (r.outcome === 'pending') continue;
    evaluated += 1;
    if (r.outcome === 'evaluated_no_signal') noSignal += 1;
  }
  return evaluated === 0 ? 0 : noSignal / evaluated;
}
```

- [ ] **Step 4: Run → pass**

```bash
npm run test:unit -- --test-name-pattern 'precisionAtK|recallAtK|ndcgAtK|meanRankOfNegatives|noSignalRate'
```

- [ ] **Step 5: Commit**

```bash
git commit -m "feat(intuition): eval-metrics — precision/recall/nDCG/mean-rank-of-neg"
```

---

## Phase 4 — A3 replay engine

### Task 4.1 — `eval.js` scoreRows (non-replay)

**Files:** `system/cognition/intuition/eval.js`, `system/tests/fixtures/recall-eval-golden.json`, `system/tests/unit/recall-eval.test.js`

- [ ] **Step 1: Create the golden fixture**

Create `system/tests/fixtures/recall-eval-golden.json`:

```json
{
  "rows": [
    {
      "id": "recall_log:g1",
      "ts": "2026-05-01T12:00:00Z",
      "session_id": "s1",
      "query": "sourdough",
      "outcome": "reinforced",
      "ranked_hits": [
        { "record": "memos:m1", "kind": "memo", "rank": 0 },
        { "record": "memos:m2", "kind": "memo", "rank": 1 },
        { "record": "events:e1", "kind": "event", "rank": 2 }
      ],
      "meta": { "latency_ms": 60, "from": "intuition", "focus_block_present": false, "focus_block_tokens": 0 }
    },
    {
      "id": "recall_log:g2",
      "ts": "2026-05-01T13:00:00Z",
      "session_id": "s2",
      "query": "kettlebell",
      "outcome": "corrected",
      "ranked_hits": [
        { "record": "memos:m3", "kind": "memo", "rank": 0 },
        { "record": "memos:m4", "kind": "memo", "rank": 1 }
      ],
      "meta": { "latency_ms": 80, "from": "intuition", "focus_block_present": true, "focus_block_tokens": 120 }
    },
    {
      "id": "recall_log:g3",
      "ts": "2026-05-01T14:00:00Z",
      "session_id": "s3",
      "query": "tomatoes",
      "outcome": "evaluated_no_signal",
      "ranked_hits": [],
      "meta": { "latency_ms": 30, "from": "intuition", "focus_block_present": false, "focus_block_tokens": 0 }
    },
    {
      "id": "recall_log:g4",
      "ts": "2026-05-01T15:00:00Z",
      "session_id": "s4",
      "query": "calendar",
      "outcome": "reinforced",
      "ranked_hits": [
        { "record": "memos:m5", "kind": "memo", "rank": 0 },
        { "record": "events:e2", "kind": "event", "rank": 1 }
      ],
      "meta": { "latency_ms": 50, "from": "mcp_recall", "focus_block_present": false, "focus_block_tokens": 0 }
    },
    {
      "id": "recall_log:g5",
      "ts": "2026-05-01T16:00:00Z",
      "session_id": "s5",
      "query": "garden",
      "outcome": "pending",
      "ranked_hits": [
        { "record": "memos:m6", "kind": "memo", "rank": 0 }
      ],
      "meta": { "latency_ms": 70, "from": "intuition", "focus_block_present": false, "focus_block_tokens": 0 }
    },
    {
      "id": "recall_log:g6",
      "ts": "2026-05-01T17:00:00Z",
      "session_id": "s6",
      "query": "books",
      "outcome": "corrected",
      "ranked_hits": [
        { "record": "events:e3", "kind": "event", "rank": 0 }
      ],
      "meta": { "latency_ms": 40, "from": "intuition", "focus_block_present": true, "focus_block_tokens": 80 }
    }
  ],
  "expected": {
    "rows_scored": 5,
    "rows_pending": 1,
    "rows_skipped": 0,
    "no_signal_rate": 0.2,
    "precision_at_3": 0.2,
    "recall_at_3": 0.4,
    "mean_rank_of_negatives_at_10": 1.5
  }
}
```

Manual derivation (sanity for future readers):

- rows_pending = 1 (g5)
- rows_scored = 5 (g1, g2, g3, g4, g6)
- noSignalRate = 1/5 = 0.2 (g3 only)
- precisionAtK([labelled(g1..g6 excl g5)], 3):
  - g1: 2/3 (memos at 0,1)
  - g2: 0/3 (both memos are `negative`)
  - g3: 0/3 (empty hits)
  - g4: 1/3 (memo at 0)
  - g6: 0/3 (event hit)
  - avg = 1/5 = 0.2 ✓
- recallAtK: g1 1.0; g4 1.0; others contribute 0 → avg 2/5 = 0.4 ✓
- meanRankOfNegatives@10: g2 negatives at 1-indexed ranks 1,2 → row mean 1.5; overall 1.5 ✓

- [ ] **Step 2: Failing test**

Create `system/tests/unit/recall-eval.test.js`:

```js
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { scoreRows } from '../../cognition/intuition/eval.js';

const fixture = JSON.parse(
  readFileSync(join(import.meta.dirname, '../fixtures/recall-eval-golden.json'), 'utf8'),
);

test('scoreRows matches golden-fixture expected metrics', () => {
  const out = scoreRows({ rows: fixture.rows, corrections: [], ks: [3] });
  const exp = fixture.expected;
  assert.equal(out.rows_pending, exp.rows_pending);
  assert.equal(out.rows_scored, exp.rows_scored);
  assert.ok(Math.abs(out.metrics.no_signal_rate - exp.no_signal_rate) < 0.001);
  assert.ok(Math.abs(out.metrics.precision_at_3 - exp.precision_at_3) < 0.001);
  assert.ok(Math.abs(out.metrics.recall_at_3 - exp.recall_at_3) < 0.001);
  assert.ok(Math.abs(out.metrics.mean_rank_of_negatives_at_10 - exp.mean_rank_of_negatives_at_10) < 0.001);
});

test('scoreRows stratifies metrics by focus_block_present (D1 cross-design fix)', () => {
  const out = scoreRows({ rows: fixture.rows, corrections: [], ks: [3] });
  assert.ok(out.metrics_by_focus_block);
  assert.ok('focus_block' in out.metrics_by_focus_block);
  assert.ok('no_focus_block' in out.metrics_by_focus_block);
  // fixture has 2 focus-block evaluated rows (g2, g6) + 3 no-focus evaluated (g1, g3, g4)
  assert.equal(out.metrics_by_focus_block.focus_block.count, 2);
  assert.equal(out.metrics_by_focus_block.no_focus_block.count, 3);
});
```

- [ ] **Step 3: Run → fail**

```bash
npm run test:unit -- --test-name-pattern 'scoreRows matches golden'
```

- [ ] **Step 4: Implement**

Create `system/cognition/intuition/eval.js`:

```js
// eval.js — pure eval engine: scoreRows / replayRow / runEval.
//
// Stage-1 (this task): scoreRows() takes already-fetched rows + corrections
// and returns a full metrics object. No DB / IO.

import { labelHits } from './eval-labels.js';
import {
  meanRankOfNegatives,
  ndcgAtK,
  noSignalRate,
  precisionAtK,
  recallAtK,
} from './eval-metrics.js';

const DEFAULT_KS = [1, 3, 6, 10];

function isPending(row) {
  return row?.outcome === 'pending';
}

function isEvaluated(row) {
  return row && row.outcome !== 'pending';
}

function metricsBlock(rows, ks) {
  const m = { no_signal_rate: undefined };
  for (const k of ks) {
    m[`precision_at_${k}`] = precisionAtK(rows, k);
    m[`recall_at_${k}`] = recallAtK(rows, k);
    m[`ndcg_at_${k}`] = ndcgAtK(rows, k);
  }
  m.mean_rank_of_negatives_at_10 = meanRankOfNegatives(rows);
  return m;
}

function focusBlockPresent(row) {
  return row?.meta?.focus_block_present === true;
}

/**
 * @param {{
 *   rows: Array<any>,
 *   corrections: Array<{ ts: any, sid?: string }>,
 *   ks?: number[],
 * }} args
 */
export function scoreRows({ rows, corrections = [], ks = DEFAULT_KS }) {
  const pending = rows.filter(isPending);
  const evaluated = rows.filter(isEvaluated);

  const labelled = evaluated.map((r) => labelHits(r, corrections));
  const metrics = metricsBlock(labelled, ks);
  metrics.no_signal_rate = noSignalRate(rows);

  // Phase 11 cross-design fix: stratify by focus_block_present.
  const withFb = [];
  const withoutFb = [];
  for (let i = 0; i < evaluated.length; i++) {
    if (focusBlockPresent(evaluated[i])) withFb.push(labelled[i]);
    else withoutFb.push(labelled[i]);
  }
  const metricsByFocus = {
    focus_block: { count: withFb.length, ...metricsBlock(withFb, ks) },
    no_focus_block: { count: withoutFb.length, ...metricsBlock(withoutFb, ks) },
  };

  return {
    rows_scored: evaluated.length,
    rows_pending: pending.length,
    rows_skipped: 0,
    metrics,
    metrics_by_focus_block: metricsByFocus,
  };
}
```

- [ ] **Step 5: Run → pass**

```bash
npm run test:unit -- --test-name-pattern 'scoreRows'
```

- [ ] **Step 6: Commit**

```bash
git commit -m "feat(intuition): eval.js scoreRows + focus_block stratification"
```

### Task 4.2 — `eval.js` replayRow

**Files:** `system/cognition/intuition/eval.js`, `system/tests/unit/recall-eval-replay.test.js`

- [ ] **Step 1: Failing test**

Create `system/tests/unit/recall-eval-replay.test.js`:

```js
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { replayRow } from '../../cognition/intuition/eval.js';

function stubEmbedder() {
  return {
    async embed(text) {
      const v = new Float32Array(4);
      let h = 0;
      for (let i = 0; i < text.length; i++) h = (h * 31 + text.charCodeAt(i)) | 0;
      v[0] = (h & 0xff) / 256;
      v[1] = ((h >> 8) & 0xff) / 256;
      v[2] = ((h >> 16) & 0xff) / 256;
      v[3] = ((h >> 24) & 0xff) / 256;
      return v;
    },
  };
}

function fixedEmbedder(vector) {
  return { async embed() { return new Float32Array(vector); } };
}

test('replayRow re-scores hits using current embeddings + rank.score', async () => {
  const row = {
    id: 'recall_log:r1',
    query: 'sourdough',
    ranked_hits: [
      { record: 'memos:m1', kind: 'memo', rank: 0 },
      { record: 'memos:m2', kind: 'memo', rank: 1 },
    ],
    meta: { from: 'intuition' },
  };
  const hydratedRecords = new Map([
    ['memos:m1', { id: 'memos:m1', content: 'sourdough recipe', kind: 'knowledge', confidence: 0.8 }],
    ['memos:m2', { id: 'memos:m2', content: 'kettlebell program', kind: 'knowledge', confidence: 0.7 }],
  ]);
  // Deterministic vectors so we can assert on ordering and tau band:
  //   query vec = m1 vec (perfect match) → distance(m1)=0
  //   m2 vec orthogonal → distance(m2)=1
  // → m1 outranks m2 → original order preserved → tau == 1
  const currentVectors = new Map([
    ['memos:m1', new Float32Array([1, 0, 0, 0])],
    ['memos:m2', new Float32Array([0, 1, 0, 0])],
  ]);
  const out = await replayRow({
    row,
    embedder: fixedEmbedder([1, 0, 0, 0]),
    hydratedRecords,
    currentVectors,
    config: { mmr_threshold: 0.92, mmr_use_cosine: true, entity_boost_enabled: false },
  });
  assert.equal(out.skipped, false);
  assert.equal(out.replayed_hits.length, 2);
  assert.equal(out.replayed_hits[0].id, 'memos:m1');     // higher score
  assert.ok(out.replayed_hits[0].score > out.replayed_hits[1].score);
  assert.ok(Math.abs(out.kendall_tau - 1.0) < 1e-9);     // identical ordering
});

test('replayRow A2 enabled vs disabled produces different scores on overlapping entity', async () => {
  const row = {
    id: 'recall_log:r3',
    query: 'karen',
    ranked_hits: [
      { record: 'memos:m1', kind: 'memo', rank: 0 },
      { record: 'memos:m2', kind: 'memo', rank: 1 },
    ],
    meta: { from: 'intuition' },
  };
  const hydratedRecords = new Map([
    ['memos:m1', { id: 'memos:m1', content: 'karen prefers tomatoes', kind: 'knowledge', confidence: 0.8 }],
    ['memos:m2', { id: 'memos:m2', content: 'kettlebell program', kind: 'knowledge', confidence: 0.8 }],
  ]);
  const currentVectors = new Map([
    ['memos:m1', new Float32Array([1, 0, 0, 0])],
    ['memos:m2', new Float32Array([1, 0, 0, 0])],
  ]);
  const baseArgs = {
    row, embedder: fixedEmbedder([1, 0, 0, 0]),
    hydratedRecords, currentVectors,
  };
  const off = await replayRow({
    ...baseArgs,
    config: { mmr_use_cosine: true, entity_boost_enabled: false },
  });
  const on = await replayRow({
    ...baseArgs,
    config: {
      mmr_use_cosine: true, entity_boost_enabled: true,
      entity_boost_per_overlap: 0.10, entity_boost_max: 1.25,
    },
    matchedEntityIds: new Set(['entities:karen']),
    aboutByMemo: new Map([['memos:m1', new Set(['entities:karen'])]]),
  });
  const m1Off = off.replayed_hits.find((h) => h.id === 'memos:m1');
  const m1On = on.replayed_hits.find((h) => h.id === 'memos:m1');
  assert.ok(m1On.score > m1Off.score, 'A2-on score must exceed A2-off for boosted memo');
  assert.equal(m1On.components.entityBoost, 1.10);
  assert.equal(m1Off.components.entityBoost, 1.0);
});

test('replayRow returns skipped=true when any record is missing', async () => {
  const row = {
    id: 'recall_log:r2',
    query: 'x',
    ranked_hits: [{ record: 'memos:gone', kind: 'memo', rank: 0 }],
    meta: { from: 'intuition' },
  };
  const out = await replayRow({
    row,
    embedder: stubEmbedder(),
    hydratedRecords: new Map(),
    currentVectors: new Map(),
    config: {},
  });
  assert.equal(out.skipped, true);
});
```

- [ ] **Step 2: Run → fail**

```bash
npm run test:unit -- --test-name-pattern 'replayRow'
```

- [ ] **Step 3: Implement**

Append to `system/cognition/intuition/eval.js`:

```js
import { cosineSim } from './vectors.js';
import { mmrLite, score } from './rank.js';

function hitRecordIdString(hit) {
  const v = hit?.record ?? hit?.memo_id ?? hit?.event_id ?? hit?.record_id;
  if (v == null) return null;
  return typeof v === 'string' ? v : String(v);
}

// Kendall tau over two rank-ordered ID lists. Returns NaN on length
// mismatch, 1.0 for n<2.
function kendallTau(originalOrder, replayedOrder) {
  if (originalOrder.length !== replayedOrder.length) return Number.NaN;
  const n = originalOrder.length;
  if (n < 2) return 1;
  const rank = new Map();
  replayedOrder.forEach((id, i) => rank.set(id, i));
  let concordant = 0;
  let discordant = 0;
  for (let i = 0; i < n - 1; i++) {
    for (let j = i + 1; j < n; j++) {
      const ri = rank.get(originalOrder[i]);
      const rj = rank.get(originalOrder[j]);
      if (ri == null || rj == null) continue;
      if (ri < rj) concordant += 1;
      else if (ri > rj) discordant += 1;
    }
  }
  const denom = (n * (n - 1)) / 2;
  return denom === 0 ? 1 : (concordant - discordant) / denom;
}

/**
 * Re-score one historical recall_log row against current state.
 *
 * Returns:
 *   { skipped: true, reason }  when records or vectors are missing.
 *   { skipped: false, replayed_hits: [{ id, score, components }],
 *     kendall_tau: number }    otherwise.
 *
 * MCP-recall rows (meta.from='mcp_recall') skip A2 entity boost; A1 cosine
 * MMR still applies (spec §3.5). When `config.entity_boost_enabled` is
 * true, the caller passes `matchedEntityIds` (a Set<string>) and
 * `aboutByMemo` (a Map<string, Set<string>>) so this function can
 * compute the boost per hit without re-fetching the catalog.
 *
 * NOTE: the live `inject.js` path normalizes hit items to
 *   `{ record: <Record>, _kind: 'memo'|'event', distance: number }`
 * before calling `mmrLite(..., cosineFn, threshold)` where `cosineFn`
 * dereferences `a.record.id` / `b.record.id`. The replay shape below
 * (`{ id, score, components }`) is deliberately flatter — `cosineFn`
 * here closes over `currentVectors` and reads `a.id` directly. The two
 * paths intentionally diverge; reusing the live `cosineFn` would
 * require carrying the full hydrated record through replay, which is
 * unnecessary for the rank-correlation we want.
 */
export async function replayRow({
  row,
  embedder,
  hydratedRecords,
  currentVectors,
  config,
  matchedEntityIds = null,
  aboutByMemo = null,
}) {
  const hits = Array.isArray(row?.ranked_hits) ? row.ranked_hits : [];
  if (hits.length === 0) return { skipped: true, reason: 'no_hits' };

  const ids = hits.map(hitRecordIdString).filter(Boolean);

  for (const id of ids) {
    if (!hydratedRecords.has(id)) return { skipped: true, reason: 'record_missing' };
  }

  const haveAnyVector = ids.some((id) => currentVectors.has(id));
  if (!haveAnyVector) return { skipped: true, reason: 'vectors_missing' };

  const qvec = await embedder.embed(row.query ?? '');

  const entityBoostOn =
    config?.entity_boost_enabled !== false && matchedEntityIds && matchedEntityIds.size > 0;

  const scored = [];
  for (const hit of hits) {
    const id = hitRecordIdString(hit);
    const rec = hydratedRecords.get(id);
    const vec = currentVectors.get(id);
    const distance = vec ? 1 - cosineSim(qvec, vec) : (hit.dist ?? 1);
    let entityBoost = 1.0;
    let entityBoostCount = 0;
    if (entityBoostOn && id?.startsWith('memos:')) {
      const aboutIds = aboutByMemo?.get(id) ?? new Set();
      let overlap = 0;
      for (const eid of aboutIds) if (matchedEntityIds.has(eid)) overlap++;
      const per = config.entity_boost_per_overlap ?? 0.10;
      const max = config.entity_boost_max ?? 1.25;
      entityBoost = overlap === 0 ? 1.0 : Math.min(max, 1.0 + per * overlap);
      entityBoostCount = overlap;
    }
    const s = score(
      { record: rec, distance, supersededCount: 0, contradictionCount: 0 },
      { entityBoost, entityBoostCount },
    );
    scored.push({ id, score: s.score, components: s.components });
  }
  scored.sort((a, b) => b.score - a.score);

  const useCosine = config?.mmr_use_cosine !== false;
  const threshold = useCosine
    ? (config?.mmr_threshold ?? 0.92)
    : (config?.mmr_threshold_legacy_substring ?? 0.85);
  const cosineFn = useCosine
    ? (a, b) => {
        const va = currentVectors.get(a.id);
        const vb = currentVectors.get(b.id);
        return va && vb ? cosineSim(va, vb) : 0;
      }
    : () => 0;
  const deduped = mmrLite(scored, cosineFn, threshold);

  const originalOrder = ids;
  const replayedOrder = deduped.map((h) => h.id);
  const tau = kendallTau(originalOrder, replayedOrder);

  return { skipped: false, replayed_hits: deduped, kendall_tau: tau };
}
```

- [ ] **Step 4: Run → pass**

```bash
npm run test:unit -- --test-name-pattern 'replayRow'
```

- [ ] **Step 5: Commit**

```bash
git commit -m "feat(intuition): replayRow — re-score historical recalls"
```

### Task 4.3 — DB-bound `runEval` entry point

**Files:** `system/cognition/intuition/eval.js`

- [ ] **Step 1: Append the DB-driven entry point**

Append to `system/cognition/intuition/eval.js`:

```js
import { BoundQuery } from 'surrealdb';
import { embeddingTable, readProfile } from '../../data/embed/profile-router.js';
import { recordStringId } from '../memory/edge-registry.js';

const REINFORCE_WINDOW_MS = 5 * 60 * 1000;

/**
 * Run the eval harness against the live DB.
 *
 * @param {object} args
 * @param {import('surrealdb').Surreal} args.db
 * @param {{embed:(t:string)=>Promise<Float32Array>}|null} args.embedder  Required iff replay=true.
 * @param {Date} args.windowStart
 * @param {Date} args.windowEnd
 * @param {string} args.profile             Active embedding profile name.
 * @param {'intuition'|'mcp_recall'|'all'} args.sourceFilter
 * @param {boolean} args.replay
 * @param {number} args.limit
 * @param {number[]} [args.ks]
 * @returns {Promise<{
 *   rows_scored: number, rows_pending: number, rows_skipped: number,
 *   rows_with_null_session_total: number,
 *   rows_with_null_session_evaluated: number,
 *   metrics: object, metrics_by_focus_block: object,
 *   replay_kendall_mean?: number|null,
 *   per_source: object,
 * }>}
 */
export async function runEval(args) {
  const { db, embedder, windowStart, windowEnd, profile, sourceFilter, replay, limit, ks } = args;
  if (replay && !embedder) throw new Error('replay mode requires an embedder');

  // Source filter via meta.from with a session_id-based fallback (spec §1.1).
  const sourceClause =
    sourceFilter === 'intuition'
      ? `AND (meta.from = 'intuition' OR (meta.from IS NONE AND session_id IS NONE))`
      : sourceFilter === 'mcp_recall'
        ? `AND (meta.from = 'mcp_recall' OR (meta.from IS NONE AND session_id IS NOT NONE))`
        : '';
  const sql =
    `SELECT id, ts, session_id, query, k, ranked_hits, outcome, meta
     FROM recall_log
     WHERE ts >= $start AND ts < $end ${sourceClause}
     ORDER BY ts ASC
     LIMIT $limit`;
  const [rows] = await db
    .query(new BoundQuery(sql, { start: windowStart, end: windowEnd, limit }))
    .collect();

  // Fetch corrections in the union window.
  let unionStart = Number.POSITIVE_INFINITY;
  let unionEnd = Number.NEGATIVE_INFINITY;
  for (const r of rows ?? []) {
    const t = (r.ts instanceof Date ? r.ts : new Date(r.ts)).getTime();
    if (t < unionStart) unionStart = t;
    if (t + REINFORCE_WINDOW_MS > unionEnd) unionEnd = t + REINFORCE_WINDOW_MS;
  }
  let corrections = [];
  if (rows && rows.length > 0) {
    const [cRows] = await db
      .query(
        new BoundQuery(
          `SELECT ts, meta.session_id AS sid FROM events
           WHERE meta.kind = 'correction' AND ts >= $a AND ts <= $b`,
          { a: new Date(unionStart), b: new Date(unionEnd) },
        ),
      )
      .collect();
    corrections = cRows ?? [];
  }

  const result = scoreRows({ rows: rows ?? [], corrections, ks });
  // Report both counts: total (all rows in window) and evaluated-only
  // (excludes pending). Total measures how much of the corpus uses the
  // session_id-NONE fallback; evaluated-only measures how much that
  // fallback contributes to the scored metric.
  result.rows_with_null_session_total = (rows ?? []).filter((r) => r.session_id == null).length;
  result.rows_with_null_session_evaluated = (rows ?? [])
    .filter((r) => r.session_id == null && r.outcome !== 'pending').length;

  // per_source breakdown over `_sources` arrays on ranked_hits[*].
  const perSource = { knn: { hits: 0 }, bm25: { hits: 0 }, knn_bm25: { hits: 0 } };
  for (const r of rows ?? []) {
    for (const h of r.ranked_hits ?? []) {
      const sources = Array.isArray(h._sources) ? h._sources : [];
      if (sources.includes('knn') && sources.includes('bm25')) perSource.knn_bm25.hits += 1;
      else if (sources.includes('knn')) perSource.knn.hits += 1;
      else if (sources.includes('bm25')) perSource.bm25.hits += 1;
    }
  }
  result.per_source = perSource;

  if (replay) {
    let tauSum = 0;
    let tauCount = 0;
    let skipped = 0;
    for (const row of rows ?? []) {
      if (row.outcome === 'pending') continue;
      const ids = (row.ranked_hits ?? [])
        .map((h) => (typeof h.record === 'string' ? h.record : String(h.record)))
        .filter(Boolean);
      if (ids.length === 0) continue;

      const eventIds = ids.filter((id) => id.startsWith('events:'));
      const memoIds = ids.filter((id) => id.startsWith('memos:'));

      const hydrated = new Map();
      if (eventIds.length > 0) {
        const [r] = await db
          .query(new BoundQuery(`SELECT * FROM events WHERE id IN $ids`, { ids: eventIds }))
          .collect();
        for (const evt of r ?? []) hydrated.set(recordStringId(evt.id), evt);
      }
      if (memoIds.length > 0) {
        const [r] = await db
          .query(new BoundQuery(`SELECT * FROM memos WHERE id IN $ids`, { ids: memoIds }))
          .collect();
        for (const m of r ?? []) hydrated.set(recordStringId(m.id), m);
      }

      const vectors = new Map();
      if (eventIds.length > 0) {
        const tbl = embeddingTable(profile, 'events');
        const [vr] = await db
          .query(new BoundQuery(`SELECT record, vector FROM ${tbl} WHERE record IN $ids`, { ids: eventIds }))
          .collect();
        for (const v of vr ?? []) vectors.set(recordStringId(v.record), Float32Array.from(v.vector));
      }
      if (memoIds.length > 0) {
        const tbl = embeddingTable(profile, 'memos');
        const [vr] = await db
          .query(new BoundQuery(`SELECT record, vector FROM ${tbl} WHERE record IN $ids`, { ids: memoIds }))
          .collect();
        for (const v of vr ?? []) vectors.set(recordStringId(v.record), Float32Array.from(v.vector));
      }

      // Intuition-source rows replay with A2 enabled; MCP-recall rows
      // skip A2 because the live MCP path never applied it (spec §3.5).
      // The source decision uses meta.from with the same session_id
      // fallback as the row-fetch query.
      const effectiveFrom =
        row?.meta?.from ?? (row?.session_id == null ? 'intuition' : 'mcp_recall');
      const replayConfig = {
        mmr_threshold: 0.92,
        mmr_use_cosine: true,
        entity_boost_enabled: effectiveFrom !== 'mcp_recall',
        entity_boost_per_overlap: 0.10,
        entity_boost_max: 1.25,
      };

      // When A2 is on, compute the same matched-entity context the
      // live inject.js path would. This is the only way the replay's
      // score(...) reflects A2.
      let matchedEntityIds = null;
      let aboutByMemo = null;
      if (replayConfig.entity_boost_enabled) {
        const { readEntityCatalog, matchCatalogEntities, tokensOf, aboutEntitiesForMemos } =
          await import('./entities.js');
        const catalog = await readEntityCatalog(db, replayConfig).catch(() => []);
        const tokens = tokensOf(row.query ?? '');
        const matched = matchCatalogEntities(catalog, tokens);
        matchedEntityIds = new Set(matched.map((m) => String(m.id)));
        if (memoIds.length > 0 && matchedEntityIds.size > 0) {
          aboutByMemo = await aboutEntitiesForMemos(db, memoIds).catch(() => new Map());
        }
      }

      const replayOut = await replayRow({
        row,
        embedder,
        hydratedRecords: hydrated,
        currentVectors: vectors,
        config: replayConfig,
        matchedEntityIds,
        aboutByMemo,
      });
      if (replayOut.skipped) {
        skipped += 1;
        continue;
      }
      if (Number.isFinite(replayOut.kendall_tau)) {
        tauSum += replayOut.kendall_tau;
        tauCount += 1;
      }
    }
    result.replay_kendall_mean = tauCount === 0 ? null : tauSum / tauCount;
    result.rows_skipped = skipped;
  }

  return result;
}

export { readProfile };
```

- [ ] **Step 2: Verify the module imports cleanly**

```bash
npm run test:unit -- --test-name-pattern 'scoreRows|replayRow'
```

Expected: all eval.js consumers continue to pass.

- [ ] **Step 3: Commit**

```bash
git commit -m "feat(intuition): runEval — DB-driven window scan + replay"
```

---

## Phase 5 — A3 CLI

### Task 5.1 — `system/runtime/cli/commands/recall-eval.js`

**Files:** `system/runtime/cli/commands/recall-eval.js`, `system/runtime/cli/index.js`, `system/tests/integration/recall-eval-cli.test.js`

- [ ] **Step 1: Failing test**

Create `system/tests/integration/recall-eval-cli.test.js`:

```js
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { surql } from 'surrealdb';
import { writeConfig } from '../../config/paths.js';
import { close, connect } from '../../data/db/client.js';
import { runMigrations } from '../../data/db/migrate.js';

test('robin recall-eval --json exits 1 when rows_scored < min_rows', async () => {
  const home = mkdtempSync(join(tmpdir(), 'robin-cli-test-'));
  process.env.ROBIN_HOME = home;
  await writeConfig({ embedder_profile: 'mxbai-1024' });

  const db = await connect({ engine: 'mem://' });
  await runMigrations(db, resolve(import.meta.dirname, '../../data/db/migrations'));
  await db.query(surql`UPSERT runtime:embedder SET value = { active_profile: 'mxbai-1024' }`).collect();
  await close(db);

  const child = spawn(
    'node',
    [resolve(import.meta.dirname, '../../bin/robin'), 'recall-eval', '--json', '--limit', '10'],
    { env: { ...process.env, ROBIN_HOME: home, ROBIN_DB_URL: 'mem://' } },
  );
  let stdout = '';
  child.stdout.on('data', (d) => { stdout += d.toString(); });
  const code = await new Promise((res) => child.on('exit', res));
  assert.equal(code, 1, `expected exit 1, got ${code}. stdout: ${stdout}`);
  const json = JSON.parse(stdout);
  assert.equal(json.rows_scored, 0);
});

test('robin recall-eval --replay --profile=<inactive> exits 3 with active profile in stderr', async () => {
  const home = mkdtempSync(join(tmpdir(), 'robin-cli-profile-'));
  process.env.ROBIN_HOME = home;
  await writeConfig({ embedder_profile: 'mxbai-1024' });
  const db = await connect({ engine: 'mem://' });
  await runMigrations(db, resolve(import.meta.dirname, '../../data/db/migrations'));
  await db.query(surql`UPSERT runtime:embedder SET value = { active_profile: 'mxbai-1024' }`).collect();
  await close(db);

  const child = spawn(
    'node',
    [resolve(import.meta.dirname, '../../bin/robin'), 'recall-eval', '--replay',
     '--profile=nonexistent', '--json', '--limit', '10'],
    { env: { ...process.env, ROBIN_HOME: home, ROBIN_DB_URL: 'mem://' } },
  );
  let stderr = '';
  child.stderr.on('data', (d) => { stderr += d.toString(); });
  const code = await new Promise((res) => child.on('exit', res));
  assert.equal(code, 3, `expected exit 3, got ${code}. stderr: ${stderr}`);
  assert.ok(stderr.includes('mxbai-1024'),
    `stderr should mention active profile 'mxbai-1024'; got: ${stderr}`);
});
```

- [ ] **Step 2: Implement the command**

Create `system/runtime/cli/commands/recall-eval.js`:

```js
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { surql } from 'surrealdb';
import { runEval } from '../../../cognition/intuition/eval.js';
import { ensureHome } from '../../../config/data-store.js';
import { close, connect, defaultDbUrl } from '../../../data/db/client.js';
import { createEmbedder } from '../../../data/embed/factory.js';
import { readProfile } from '../../../data/embed/profile-router.js';
import { parseArgs } from '../args.js';

const DEFAULT_WINDOW_DAYS = 30;
const DEFAULT_K = 6;
const DEFAULT_LIMIT = 5000;

function parseWindowDays(s) {
  if (!s) return DEFAULT_WINDOW_DAYS;
  const m = /^(\d+)d$/.exec(String(s));
  if (!m) throw new Error(`invalid --window: ${s} (expected e.g. 30d)`);
  return Number(m[1]);
}

function readThresholds(value) {
  return {
    min_rows: value?.min_rows ?? 100,
    precision_at_6_min: value?.precision_at_6_min ?? 0.20,
    ndcg_at_6_min: value?.ndcg_at_6_min ?? 0.35,
    no_signal_rate_max: value?.no_signal_rate_max ?? 0.30,
    mean_rank_of_neg_at_10_min: value?.mean_rank_of_neg_at_10_min ?? 4.0,
  };
}

function gitSha() {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString().trim();
  } catch {
    return null;
  }
}

function formatPercent(n) { return `${(n * 100).toFixed(1)}%`; }
function fmtK(metrics, prefix) {
  return [1, 3, 6, 10].map((k) => `${(metrics[`${prefix}_at_${k}`] ?? 0).toFixed(3).padStart(7)}`).join(' ');
}

function printText(out, run) {
  out(`Recall eval — profile=${run.profile} window=${run.window_start.toISOString().slice(0,10)}..${run.window_end.toISOString().slice(0,10)} source=${run.source_filter}`);
  out(`  rows_scored=${run.rows_scored}  rows_pending=${run.rows_pending}  rows_skipped=${run.rows_skipped}`);
  if ((run.rows_with_null_session_total ?? 0) > 0) {
    out(`  warning: ${run.rows_with_null_session_total} rows used session_id=NONE fallback (${run.rows_with_null_session_evaluated ?? 0} of those evaluated).`);
  }
  out('');
  out(`  metric              k=1     k=3     k=6     k=10`);
  out(`  precision      ${fmtK(run.metrics, 'precision')}`);
  out(`  recall         ${fmtK(run.metrics, 'recall')}`);
  out(`  nDCG           ${fmtK(run.metrics, 'ndcg')}`);
  out(`  mean_rank_of_neg@10  ${(run.metrics.mean_rank_of_negatives_at_10 ?? 0).toFixed(2)}`);
  out(`  no_signal_rate       ${formatPercent(run.metrics.no_signal_rate ?? 0)}`);
}

export async function recallEval(argv) {
  const args = parseArgs(argv);
  const flags = args.flags ?? {};
  const json = flags.json === true;
  const replay = flags.replay === true;
  const limit = Number(flags.limit ?? DEFAULT_LIMIT);
  const windowDays = parseWindowDays(flags.window);
  const k = Number(flags.k ?? DEFAULT_K);
  const requestedProfile = typeof flags.profile === 'string' ? flags.profile : null;
  const source = typeof flags.source === 'string' ? flags.source : 'all';
  const outPath = typeof flags.out === 'string' ? flags.out : null;

  if (!['intuition', 'mcp_recall', 'all'].includes(source)) {
    process.stderr.write(`invalid --source: ${source}\n`);
    process.exit(3);
  }

  let db;
  try {
    await ensureHome();
    db = await connect({ engine: process.env.ROBIN_DB_URL ?? (await defaultDbUrl()) });
  } catch (e) {
    process.stderr.write(`recall-eval: db open failed: ${e.message}\n`);
    process.exit(3);
  }

  let exitCode = 0;
  try {
    const activeProfile = await readProfile(db).catch(() => null);
    if (!activeProfile) {
      process.stderr.write(`recall-eval: runtime:embedder.active_profile not set\n`);
      process.exit(3);
    }
    const profile = requestedProfile ?? activeProfile;
    if (replay && requestedProfile && requestedProfile !== activeProfile) {
      process.stderr.write(`recall-eval: --replay requires --profile=${activeProfile} (active)\n`);
      process.exit(3);
    }

    const [thrRows] = await db
      .query(surql`SELECT VALUE value FROM type::record('runtime', 'recall_eval.thresholds')`)
      .collect();
    const thresholds = readThresholds(thrRows?.[0]);

    const windowEnd = new Date();
    const windowStart = new Date(windowEnd.getTime() - windowDays * 86_400_000);

    let embedder = null;
    if (replay) {
      embedder = await createEmbedder();
    }

    const ks = [...new Set([1, 3, 6, 10, k])].sort((a, b) => a - b);
    const result = await runEval({
      db,
      embedder,
      windowStart,
      windowEnd,
      profile,
      sourceFilter: source,
      replay,
      limit,
      ks,
    });

    // Fold non-SCHEMAFULL fields into `metrics` (FLEXIBLE) so the
    // persist roundtrips through SurrealDB without rejection. Top-level
    // keys are limited to the columns declared in the migration.
    const enrichedMetrics = {
      ...result.metrics,
      by_focus_block: result.metrics_by_focus_block,
      replay_kendall_mean: result.replay_kendall_mean,
      rows_with_null_session_total: result.rows_with_null_session_total,
      rows_with_null_session_evaluated: result.rows_with_null_session_evaluated,
    };
    const runRow = {
      profile,
      window_start: windowStart,
      window_end: windowEnd,
      source_filter: source,
      replay,
      rows_scored: result.rows_scored,
      rows_pending: result.rows_pending,
      rows_skipped: result.rows_skipped,
      metrics: enrichedMetrics,
      per_source: result.per_source,
      config_digest: { ks, limit, thresholds },
      git_sha: gitSha(),
    };

    // Persist (best-effort).
    try {
      await db
        .query(
          surql`CREATE recall_eval_runs CONTENT ${{
            profile,
            window_start: windowStart,
            window_end: windowEnd,
            source_filter: source,
            replay,
            rows_scored: result.rows_scored,
            rows_pending: result.rows_pending,
            rows_skipped: result.rows_skipped,
            metrics: enrichedMetrics,
            per_source: result.per_source,
            config_digest: runRow.config_digest,
            git_sha: runRow.git_sha,
          }}`,
        )
        .collect();
    } catch (e) {
      process.stderr.write(`recall-eval: persist failed: ${e.message}\n`);
    }

    if (outPath) {
      writeFileSync(outPath, JSON.stringify(runRow, null, 2));
    }
    if (json) {
      process.stdout.write(`${JSON.stringify(runRow, null, 2)}\n`);
    } else {
      printText((s) => process.stdout.write(`${s}\n`), {
        profile, window_start: windowStart, window_end: windowEnd,
        source_filter: source,
        ...result,
      });
    }

    // Exit-code gating (spec §1.8).
    if (result.rows_scored < thresholds.min_rows) {
      exitCode = 1;
    } else {
      const breaches = [];
      if ((result.metrics.precision_at_6 ?? 0) < thresholds.precision_at_6_min) breaches.push('precision_at_6');
      if ((result.metrics.ndcg_at_6 ?? 0) < thresholds.ndcg_at_6_min) breaches.push('ndcg_at_6');
      if ((result.metrics.no_signal_rate ?? 0) > thresholds.no_signal_rate_max) breaches.push('no_signal_rate');
      const mrn = result.metrics.mean_rank_of_negatives_at_10;
      if (mrn != null && mrn < thresholds.mean_rank_of_neg_at_10_min) breaches.push('mean_rank_of_negatives_at_10');
      if (breaches.length > 0) {
        process.stderr.write(`recall-eval: threshold breach: ${breaches.join(', ')}\n`);
        exitCode = 2;
      }
    }
  } catch (e) {
    process.stderr.write(`recall-eval: ${e.message}\n`);
    exitCode = 3;
  } finally {
    try { await close(db); } catch {}
  }
  process.exit(exitCode);
}
```

- [ ] **Step 3: Register the subcommand**

In `system/runtime/cli/index.js`, after the `doctor` block (lines 275-278), add:

```js
  if (cmd === 'recall-eval') {
    const { recallEval } = await import('./commands/recall-eval.js');
    return recallEval(argv.slice(1));
  }
```

- [ ] **Step 3b: Verify `system/bin/robin` dispatches through `cli/index.js`**

```bash
grep -n 'runtime/cli/index' system/bin/robin
```

Expected output: a line importing or invoking `system/runtime/cli/index.js`
(or its export). If it does not exist (e.g., `bin/robin` is a thin shell
stub that imports the index lazily), the integration test in Step 1 will
fail-fast and tell you the wiring is missing — at that point, add a stub
that calls `await import('../runtime/cli/index.js').then((m) => m.default(process.argv.slice(2)))`
(or the existing entrypoint name). Do not introduce a new dispatch
pattern just for `recall-eval`.

- [ ] **Step 4: Run → pass**

```bash
npm run test:integration -- --test-name-pattern 'recall-eval --json exits 1'
```

- [ ] **Step 5: Commit**

```bash
git commit -m "feat(cli): robin recall-eval — A3 harness CLI with exit codes"
```

### Task 5.2 — End-to-end replay integration test

**Files:** `system/tests/integration/recall-eval-replay-end-to-end.test.js`

- [ ] **Step 1: Write the integration test**

Create `system/tests/integration/recall-eval-replay-end-to-end.test.js`:

```js
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { surql } from 'surrealdb';
import * as store from '../../cognition/memory/store.js';
import { runEval } from '../../cognition/intuition/eval.js';
import { writeConfig } from '../../config/paths.js';
import { close, connect } from '../../data/db/client.js';
import { runMigrations } from '../../data/db/migrate.js';
import { createStubEmbedder } from '../../data/embed/embedder.js';
import { recordEvent } from '../../io/capture/record-event.js';

async function fresh() {
  const home = mkdtempSync(join(tmpdir(), 'robin-replay-test-'));
  process.env.ROBIN_HOME = home;
  await writeConfig({ embedder_profile: 'mxbai-1024' });
  const db = await connect({ engine: 'mem://' });
  await runMigrations(db, resolve(import.meta.dirname, '../../data/db/migrations'));
  await db.query(surql`UPSERT runtime:embedder SET value = { active_profile: 'mxbai-1024' }`).collect();
  return db;
}

test('runEval replay reproduces precision@k against seeded recall_log rows', async () => {
  const db = await fresh();
  const e = createStubEmbedder({ dimension: 1024 });

  const ev1 = await recordEvent(db, e, { source: 'cli', content: 'sourdough hydration 62%' });

  // Seed 8 memos so we can produce 8 recall_log rows with mixed outcomes
  // (3× reinforced, 3× corrected, 2× evaluated_no_signal) — matches the
  // ≥8-row fixture target in spec §8.6.
  const memos = [];
  for (let i = 0; i < 8; i++) {
    memos.push(await store.note(db, e, 'knowledge', {
      content: `memo content for row ${i}`,
      derived_by: 'manual',
    }));
  }

  const rows = [
    { outcome: 'reinforced',         hits: [{ kind: 'memo',  rec: memos[0].id }, { kind: 'event', rec: ev1.id }] },
    { outcome: 'reinforced',         hits: [{ kind: 'memo',  rec: memos[1].id }] },
    { outcome: 'reinforced',         hits: [{ kind: 'memo',  rec: memos[2].id }, { kind: 'memo',  rec: memos[3].id }] },
    { outcome: 'corrected',          hits: [{ kind: 'memo',  rec: memos[4].id }] },
    { outcome: 'corrected',          hits: [{ kind: 'memo',  rec: memos[5].id }, { kind: 'memo',  rec: memos[6].id }] },
    { outcome: 'corrected',          hits: [{ kind: 'memo',  rec: memos[7].id }] },
    { outcome: 'evaluated_no_signal',hits: [] },
    { outcome: 'evaluated_no_signal',hits: [] },
  ];
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    await db.query(surql`CREATE recall_log CONTENT ${{
      ts: new Date(Date.now() - (60 - i * 5) * 60_000),
      session_id: `s${i}`,
      query: `query ${i}`,
      k: 6,
      ranked_hits: r.hits.map((h, j) => ({ record: h.rec, kind: h.kind, rank: j })),
      outcome: r.outcome,
      meta: { latency_ms: 50 + i, from: 'intuition', focus_block_present: false, focus_block_tokens: 0 },
    }}`).collect();
  }

  const result = await runEval({
    db, embedder: e,
    windowStart: new Date(Date.now() - 86_400_000),
    windowEnd: new Date(),
    profile: 'mxbai-1024',
    sourceFilter: 'all',
    replay: true,
    limit: 100,
    ks: [1, 3, 6, 10],
  });

  assert.equal(result.rows_scored, 8);
  assert.equal(result.rows_pending, 0);
  // Hand derivation @3 (evaluated rows only; pending excluded):
  //   reinforced[0]: 1 sp in top-3 → 1/3
  //   reinforced[1]: 1/3
  //   reinforced[2]: 2/3
  //   corrected[0..2]: 0
  //   evaluated_no_signal × 2: 0
  // avg = (1/3 + 1/3 + 2/3 + 0 + 0 + 0 + 0 + 0) / 8 = (4/3)/8 ≈ 0.1667
  assert.ok(Math.abs(result.metrics.precision_at_3 - 0.1667) < 0.001,
    `precision_at_3 = ${result.metrics.precision_at_3}`);
  // recall@3: each reinforced row has full coverage of its sp set in top-3.
  //   3 of 8 rows contribute 1.0; the rest contribute 0 → avg 3/8 = 0.375
  assert.ok(Math.abs(result.metrics.recall_at_3 - 0.375) < 0.001,
    `recall_at_3 = ${result.metrics.recall_at_3}`);
  // no_signal_rate: 2 / 8 evaluated = 0.25
  assert.ok(Math.abs(result.metrics.no_signal_rate - 0.25) < 0.001,
    `no_signal_rate = ${result.metrics.no_signal_rate}`);
  // mean_rank_of_negatives@10: corrected[0] → rank 1; corrected[1] → mean(1,2)=1.5; corrected[2] → 1; mean=(1+1.5+1)/3≈1.1667
  assert.ok(
    result.metrics.mean_rank_of_negatives_at_10 != null &&
      Math.abs(result.metrics.mean_rank_of_negatives_at_10 - 1.1667) < 0.001,
    `mean_rank_of_negatives_at_10 = ${result.metrics.mean_rank_of_negatives_at_10}`,
  );
  assert.ok(typeof result.replay_kendall_mean === 'number' || result.replay_kendall_mean === null);

  await close(db);
});
```

- [ ] **Step 2: Run → pass**

```bash
npm run test:integration -- --test-name-pattern 'reproduces precision@k'
```

- [ ] **Step 3: Commit**

```bash
git commit -m "test(intuition): replay-mode end-to-end against seeded recall_log"
```

---

## Phase 6 — A1 real-cosine MMR

### Task 6.1 — `vectors.js` cosineSim + loadVectorsForHits

**Files:** `system/cognition/intuition/vectors.js`, `system/tests/unit/intuition-cosine.test.js`, `system/tests/unit/intuition-vectors-load.test.js`

- [ ] **Step 1: Failing tests**

Create `system/tests/unit/intuition-cosine.test.js`:

```js
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cosineSim } from '../../cognition/intuition/vectors.js';

test('cosineSim: identical vectors → 1', () => {
  const a = new Float32Array([1, 2, 3, 4]);
  const b = new Float32Array([1, 2, 3, 4]);
  assert.ok(Math.abs(cosineSim(a, b) - 1.0) < 1e-6);
});

test('cosineSim: orthogonal vectors → 0', () => {
  const a = new Float32Array([1, 0, 0, 0]);
  const b = new Float32Array([0, 1, 0, 0]);
  assert.equal(cosineSim(a, b), 0);
});

test('cosineSim: opposite vectors → -1', () => {
  const a = new Float32Array([1, 0, 0, 0]);
  const b = new Float32Array([-1, 0, 0, 0]);
  assert.ok(Math.abs(cosineSim(a, b) + 1.0) < 1e-6);
});

test('cosineSim: mismatched length → 0 (fail-soft)', () => {
  const a = new Float32Array([1, 2, 3]);
  const b = new Float32Array([1, 2, 3, 4]);
  assert.equal(cosineSim(a, b), 0);
});

test('cosineSim: null/undefined → 0', () => {
  assert.equal(cosineSim(null, new Float32Array([1])), 0);
  assert.equal(cosineSim(new Float32Array([1]), undefined), 0);
});
```

Create `system/tests/unit/intuition-vectors-load.test.js`:

```js
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { surql } from 'surrealdb';
import * as store from '../../cognition/memory/store.js';
import { loadVectorsForHits } from '../../cognition/intuition/vectors.js';
import { writeConfig } from '../../config/paths.js';
import { close, connect } from '../../data/db/client.js';
import { runMigrations } from '../../data/db/migrate.js';
import { createStubEmbedder } from '../../data/embed/embedder.js';
import { recordEvent } from '../../io/capture/record-event.js';

async function fresh() {
  const home = mkdtempSync(join(tmpdir(), 'robin-vectors-test-'));
  process.env.ROBIN_HOME = home;
  await writeConfig({ embedder_profile: 'mxbai-1024' });
  const db = await connect({ engine: 'mem://' });
  await runMigrations(db, resolve(import.meta.dirname, '../../data/db/migrations'));
  await db.query(surql`UPSERT runtime:embedder SET value = { active_profile: 'mxbai-1024' }`).collect();
  return db;
}

test('loadVectorsForHits returns Float32Arrays keyed by string id', async () => {
  const db = await fresh();
  const e = createStubEmbedder({ dimension: 1024 });
  const ev = await recordEvent(db, e, { source: 'cli', content: 'planted tomatoes' });
  const memo = await store.note(db, e, 'knowledge', { content: 'kevin loves sourdough', derived_by: 'manual' });
  const map = await loadVectorsForHits(db, {
    eventIds: [ev.id],
    memoIds: [memo.id],
  });
  assert.ok(map instanceof Map);
  assert.ok(map.has(String(ev.id)));
  assert.ok(map.has(String(memo.id)));
  assert.ok(map.get(String(ev.id)) instanceof Float32Array);
  await close(db);
});

test('loadVectorsForHits returns empty Map when both id lists are empty', async () => {
  const db = await fresh();
  const map = await loadVectorsForHits(db, { eventIds: [], memoIds: [] });
  assert.equal(map.size, 0);
  await close(db);
});
```

- [ ] **Step 2: Run → fail**

```bash
npm run test:unit -- --test-name-pattern 'cosineSim|loadVectorsForHits'
```

- [ ] **Step 3: Implement**

Create `system/cognition/intuition/vectors.js`:

```js
// vectors.js — embedding-vector hydration + cosine similarity for A1 MMR.
//
// Both helpers are used by inject.js between merge/sort and MMR. The DB
// fetch is batched: one query per non-empty surface (events, memos), keyed
// by record. Profile resolution goes through profile-router so we read from
// the currently-active embedding table.

import { BoundQuery } from 'surrealdb';
import { embeddingTable, readProfile } from '../../data/embed/profile-router.js';
import { recordStringId } from '../memory/edge-registry.js';

/**
 * @param {Float32Array|number[]|null|undefined} a
 * @param {Float32Array|number[]|null|undefined} b
 * @returns {number} cosine ∈ [-1, 1], or 0 if comparison is impossible.
 */
export function cosineSim(a, b) {
  if (!a || !b || a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

/**
 * Fetch current embedding vectors for a set of event + memo record ids.
 * Returns a Map keyed by `String(id)`, value = Float32Array. Missing ids
 * are simply absent from the Map; callers should treat missing as "cannot
 * compare" rather than as "is dissimilar".
 *
 * @param {import('surrealdb').Surreal} db
 * @param {{ eventIds?: Array<any>, memoIds?: Array<any> }} ids
 * @returns {Promise<Map<string, Float32Array>>}
 */
export async function loadVectorsForHits(db, { eventIds = [], memoIds = [] }) {
  const out = new Map();
  if (eventIds.length === 0 && memoIds.length === 0) return out;

  const profile = await readProfile(db);

  if (eventIds.length > 0) {
    const tbl = embeddingTable(profile, 'events');
    const [rows] = await db
      .query(new BoundQuery(`SELECT record, vector FROM ${tbl} WHERE record IN $ids`, { ids: eventIds }))
      .collect();
    for (const r of rows ?? []) {
      const key = recordStringId(r.record);
      if (key) out.set(key, Float32Array.from(r.vector));
    }
  }
  if (memoIds.length > 0) {
    const tbl = embeddingTable(profile, 'memos');
    const [rows] = await db
      .query(new BoundQuery(`SELECT record, vector FROM ${tbl} WHERE record IN $ids`, { ids: memoIds }))
      .collect();
    for (const r of rows ?? []) {
      const key = recordStringId(r.record);
      if (key) out.set(key, Float32Array.from(r.vector));
    }
  }
  return out;
}
```

- [ ] **Step 4: Run → pass**

```bash
npm run test:unit -- --test-name-pattern 'cosineSim|loadVectorsForHits'
```

- [ ] **Step 5: Commit**

```bash
git commit -m "feat(intuition): vectors.js — cosineSim + batched vector hydration"
```

### Task 6.2 — Wire cosine MMR into `inject.js` (flag-gated)

**Files:** `system/cognition/intuition/inject.js`, `system/tests/integration/intuition-cosine-end-to-end.test.js`, `system/tests/integration/intuition-substring-fallback.test.js`

- [ ] **Step 1: Failing integration test (cosine path)**

Create `system/tests/integration/intuition-cosine-end-to-end.test.js`:

```js
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { surql } from 'surrealdb';
import { intuitionEndpoint } from '../../cognition/intuition/inject.js';
import { writeConfig } from '../../config/paths.js';
import { close, connect } from '../../data/db/client.js';
import { runMigrations } from '../../data/db/migrate.js';
import { createStubEmbedder } from '../../data/embed/embedder.js';
import { recordEvent } from '../../io/capture/record-event.js';

async function fresh() {
  const home = mkdtempSync(join(tmpdir(), 'robin-intuition-cos-'));
  process.env.ROBIN_HOME = home;
  await writeConfig({ embedder_profile: 'mxbai-1024' });
  const db = await connect({ engine: 'mem://' });
  await runMigrations(db, resolve(import.meta.dirname, '../../data/db/migrations'));
  await db.query(surql`UPSERT runtime:embedder SET value = { active_profile: 'mxbai-1024' }`).collect();
  return db;
}

test('intuitionEndpoint records mmr_path=cosine when vectors are available', async () => {
  const db = await fresh();
  const e = createStubEmbedder({ dimension: 1024 });
  await recordEvent(db, e, { source: 'cli', content: 'sourdough hydration ratio 62%' });
  await recordEvent(db, e, { source: 'cli', content: 'baked another sourdough loaf today' });

  await intuitionEndpoint({
    db, embedder: e, query: 'sourdough', priorAssistant: '',
    k: 6, recencyDays: 30, tokenBudget: 1500,
    sessionId: 's1',
  });

  const [rows] = await db.query(surql`SELECT meta FROM intuition_telemetry`).collect();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].meta?.mmr_path, 'cosine');
  assert.ok(typeof rows[0].meta?.mmr_drops === 'number');
  assert.ok(rows[0].meta?.mmr_vec_coverage > 0);

  const [recallRows] = await db.query(surql`SELECT meta FROM recall_log`).collect();
  assert.equal(recallRows[0].meta?.from, 'intuition');
  assert.ok(typeof recallRows[0].meta?.latency_ms === 'number');

  // Spec §7 regression guard (not a budget): the new vector-hydration
  // round-trip must not blow the endpoint past 200 ms on the embedded
  // engine. Large jumps indicate a second round-trip or an unintended
  // network call.
  assert.ok(recallRows[0].meta.latency_ms < 200,
    `latency_ms = ${recallRows[0].meta.latency_ms}; expected < 200 (regression guard)`);

  // Phase 11 contract: D1 has not shipped yet → focus_block_present
  // must default to false on the recall_log row.
  assert.equal(recallRows[0].meta?.focus_block_present, false);
  assert.equal(recallRows[0].meta?.focus_block_tokens, 0);

  await close(db);
});
```

Create `system/tests/integration/intuition-substring-fallback.test.js`:

```js
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { surql } from 'surrealdb';
import { intuitionEndpoint } from '../../cognition/intuition/inject.js';
import { writeConfig } from '../../config/paths.js';
import { close, connect } from '../../data/db/client.js';
import { runMigrations } from '../../data/db/migrate.js';
import { createStubEmbedder } from '../../data/embed/embedder.js';
import { recordEvent } from '../../io/capture/record-event.js';

async function fresh() {
  const home = mkdtempSync(join(tmpdir(), 'robin-fallback-'));
  process.env.ROBIN_HOME = home;
  await writeConfig({ embedder_profile: 'mxbai-1024' });
  const db = await connect({ engine: 'mem://' });
  await runMigrations(db, resolve(import.meta.dirname, '../../data/db/migrations'));
  await db.query(surql`UPSERT runtime:embedder SET value = { active_profile: 'mxbai-1024' }`).collect();
  return db;
}

test('intuitionEndpoint falls back to substring MMR when mmr_use_cosine=false', async () => {
  const db = await fresh();
  const e = createStubEmbedder({ dimension: 1024 });
  await recordEvent(db, e, { source: 'cli', content: 'sourdough recipe one' });
  await recordEvent(db, e, { source: 'cli', content: 'sourdough recipe two' });
  await db.query(surql`UPDATE runtime:recall SET value.mmr_use_cosine = false`).collect();

  await intuitionEndpoint({
    db, embedder: e, query: 'sourdough', priorAssistant: '',
    k: 6, recencyDays: 30, tokenBudget: 1500,
    sessionId: 's1',
  });

  const [rows] = await db.query(surql`SELECT meta FROM intuition_telemetry`).collect();
  assert.equal(rows[0].meta?.mmr_path, 'substring');

  await close(db);
});
```

- [ ] **Step 2: Edit `inject.js`**

In `system/cognition/intuition/inject.js`:

1. **Add imports** at the top (after the existing `import { mmrLite, score }`):

```js
import { recordStringId } from '../memory/edge-registry.js';
import { getRecallConfig } from '../memory/store.js';
import { loadVectorsForHits, cosineSim } from './vectors.js';
```

2. **Declare new outer-scope telemetry variables** before the `if (combined.trim()...)` block:

```js
  let mmrDropsOut = 0;
  let mmrPathOut = 'cosine';
  let mmrVecCoverageOut = 0;
```

3. **Replace the MMR block (lines 127-134)** with config-driven dispatch. Insert just before the existing `const deduped = mmrLite(...)`:

```js
    const cfg = await getRecallConfig(db).catch(() => ({
      mmr_threshold: 0.92,
      mmr_threshold_legacy_substring: 0.85,
      mmr_use_cosine: true,
      entity_boost_enabled: true,
    }));

    const eventIds = merged.filter((h) => h._kind === 'event').map((h) => h.record.id);
    const memoIds = merged.filter((h) => h._kind === 'memo').map((h) => h.record.id);

    let vectors = new Map();
    if (cfg.mmr_use_cosine !== false && merged.length >= 2) {
      try {
        vectors = await loadVectorsForHits(db, { eventIds, memoIds });
      } catch {
        vectors = new Map();
      }
    }
    const vecCoverage = merged.length === 0 ? 0 : (vectors.size / merged.length);
    const useCosine = cfg.mmr_use_cosine !== false && vectors.size >= 2;
    let cosineFn;
    let threshold;
    let mmrPath;
    if (useCosine) {
      const vecAt = (h) => vectors.get(recordStringId(h.record.id));
      cosineFn = (a, b) => {
        const va = vecAt(a);
        const vb = vecAt(b);
        return va && vb ? cosineSim(va, vb) : 0;
      };
      threshold = cfg.mmr_threshold ?? 0.92;
      mmrPath = 'cosine';
    } else {
      cosineFn = (a, b) => substringOverlap(a.record.content, b.record.content);
      threshold = cfg.mmr_threshold_legacy_substring ?? 0.85;
      mmrPath = 'substring';
    }
    const dedupedAll = mmrLite(merged, cosineFn, threshold);
    const mmrDrops = merged.length - dedupedAll.length;
    const deduped = dedupedAll.slice(0, k);

    mmrDropsOut = mmrDrops;
    mmrPathOut = mmrPath;
    mmrVecCoverageOut = vecCoverage;
```

4. **Extend the telemetry write (lines 178-189)**:

```js
  try {
    await db
      .query(
        surql`CREATE intuition_telemetry CONTENT ${{
          query_chars: safeQuery.length,
          hits: hits.length,
          tokens_injected: tokens,
          latency_ms,
          truncated,
          meta: {
            mmr_drops: mmrDropsOut,
            mmr_path: mmrPathOut,
            mmr_vec_coverage: mmrVecCoverageOut,
          },
        }}`,
      )
      .collect();
  } catch {
    // Swallow — telemetry is advisory.
  }
```

5. **Extend the recall_log write** to set `meta.from` (`session_id` was added in Phase 0 Step 4c — either verified from a prior B1 landing or shipped via the fallback):

```js
      await db
        .query(
          surql`CREATE recall_log CONTENT ${{
            query: safeQuery,
            k,
            ranked_hits: rankedHits,
            outcome: 'pending',
            session_id: sessionId,
            meta: { latency_ms, truncated, from: 'intuition' },
          }}`,
        )
        .collect();
```

- [ ] **Step 3: Run integration tests → pass**

```bash
npm run test:integration -- --test-name-pattern 'mmr_path=cosine|substring MMR when mmr_use_cosine=false'
```

- [ ] **Step 4: Run the existing intuition test → pass (regression guard)**

```bash
npm run test:unit -- --test-name-pattern 'intuitionEndpoint'
```

The pre-existing fields (`query_chars`, `hits`, `tokens_injected`, `truncated`) remain in the same shape; the new `meta` is additive.

- [ ] **Step 5: Commit**

```bash
git commit -m "feat(intuition): A1 cosine MMR — vector-hydration path with substring fallback"
```

---

## Phase 7 — A1 threshold tuneable + diversity test

### Task 7.1 — Diversity behavior integration test

**Files:** `system/tests/integration/intuition-mmr-diversity.test.js`

- [ ] **Step 1: Write the test**

Create `system/tests/integration/intuition-mmr-diversity.test.js`:

```js
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { surql } from 'surrealdb';
import { intuitionEndpoint } from '../../cognition/intuition/inject.js';
import { writeConfig } from '../../config/paths.js';
import { close, connect } from '../../data/db/client.js';
import { runMigrations } from '../../data/db/migrate.js';
import { createStubEmbedder } from '../../data/embed/embedder.js';
import { recordEvent } from '../../io/capture/record-event.js';

async function fresh() {
  const home = mkdtempSync(join(tmpdir(), 'robin-diversity-'));
  process.env.ROBIN_HOME = home;
  await writeConfig({ embedder_profile: 'mxbai-1024' });
  const db = await connect({ engine: 'mem://' });
  await runMigrations(db, resolve(import.meta.dirname, '../../data/db/migrations'));
  await db.query(surql`UPSERT runtime:embedder SET value = { active_profile: 'mxbai-1024' }`).collect();
  return db;
}

test('lowering mmr_threshold increases MMR drops on a near-duplicate corpus', async () => {
  const db = await fresh();
  const e = createStubEmbedder({ dimension: 1024 });
  // Stub embedder hashes content deterministically — identical content yields
  // identical vectors → cosine ≈ 1.0 between all pairs.
  for (let i = 0; i < 4; i++) {
    await recordEvent(db, e, { source: 'cli', content: 'sourdough recipe' });
  }

  await db.query(surql`UPDATE runtime:recall SET value.mmr_threshold = 0.92`).collect();
  await intuitionEndpoint({
    db, embedder: e, query: 'sourdough', priorAssistant: '',
    k: 6, recencyDays: 30, tokenBudget: 1500, sessionId: 's1',
  });

  await db.query(surql`UPDATE runtime:recall SET value.mmr_threshold = 0.99`).collect();
  await intuitionEndpoint({
    db, embedder: e, query: 'sourdough', priorAssistant: '',
    k: 6, recencyDays: 30, tokenBudget: 1500, sessionId: 's2',
  });

  const [rows] = await db.query(surql`SELECT meta FROM intuition_telemetry ORDER BY ts ASC`).collect();
  assert.equal(rows.length, 2);
  assert.ok(rows[0].meta.mmr_drops >= rows[1].meta.mmr_drops,
    `expected drops(0.92)=${rows[0].meta.mmr_drops} >= drops(0.99)=${rows[1].meta.mmr_drops}`);

  await close(db);
});
```

- [ ] **Step 2: Run → pass**

```bash
npm run test:integration -- --test-name-pattern 'mmr_threshold increases MMR drops'
```

- [ ] **Step 3: Commit**

```bash
git commit -m "test(intuition): MMR threshold diversity gate"
```

---

## Phase 8 — A2 entity extraction + catalog cache

### Task 8.1 — `entities.js` token + match helpers

**Files:** `system/cognition/intuition/entities.js`, `system/tests/unit/intuition-entities.test.js`

- [ ] **Step 1: Failing test**

Create `system/tests/unit/intuition-entities.test.js`:

```js
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  tokensOf,
  matchCatalogEntities,
  entityBoostFromAboutIds,
} from '../../cognition/intuition/entities.js';

test('tokensOf lowercases + drops tokens shorter than 3 chars', () => {
  const out = tokensOf('Kevin and Robin shipped to.io');
  assert.ok(out.has('kevin'));
  assert.ok(out.has('robin'));
  assert.ok(out.has('shipped'));
  assert.ok(!out.has('to'));    // length 2
  assert.ok(!out.has('io'));    // length 2
  assert.ok(out.has('and'));    // length 3 → kept
});

test('matchCatalogEntities — exact token equality, not substring', () => {
  const catalog = [
    { id: 'entities:kevin', name: 'Kevin', type: 'person' },
    { id: 'entities:kevinlee', name: 'Kevinlee', type: 'person' },
  ];
  const queryTokens = tokensOf('did kevin ship today');
  const matched = matchCatalogEntities(catalog, queryTokens);
  assert.equal(matched.length, 1);
  assert.equal(matched[0].id, 'entities:kevin');
});

test('matchCatalogEntities skips entities whose name tokens are all <3 chars', () => {
  const catalog = [{ id: 'entities:os', name: 'OS', type: 'system' }];
  const matched = matchCatalogEntities(catalog, new Set(['os']));
  assert.equal(matched.length, 0);
});

test('entityBoostFromAboutIds: zero overlap → 1.0', () => {
  const out = entityBoostFromAboutIds(new Set(), new Set(['entities:a']), {});
  assert.deepEqual(out, { boost: 1.0, count: 0 });
});

test('entityBoostFromAboutIds: one overlap → 1.10', () => {
  const out = entityBoostFromAboutIds(
    new Set(['entities:a']),
    new Set(['entities:a']),
    { entity_boost_per_overlap: 0.10, entity_boost_max: 1.25 },
  );
  assert.ok(Math.abs(out.boost - 1.10) < 1e-6);
  assert.equal(out.count, 1);
});

test('entityBoostFromAboutIds: five overlaps → capped at 1.25', () => {
  const out = entityBoostFromAboutIds(
    new Set(['entities:a', 'entities:b', 'entities:c', 'entities:d', 'entities:e']),
    new Set(['entities:a', 'entities:b', 'entities:c', 'entities:d', 'entities:e']),
    { entity_boost_per_overlap: 0.10, entity_boost_max: 1.25 },
  );
  assert.equal(out.boost, 1.25);
  assert.equal(out.count, 5);
});
```

- [ ] **Step 2: Run → fail**

```bash
npm run test:unit -- --test-name-pattern 'tokensOf|matchCatalogEntities|entityBoostFromAboutIds'
```

- [ ] **Step 3: Implement**

Create `system/cognition/intuition/entities.js`:

```js
// entities.js — query-side entity match + boost computation (A2).
//
// Three pure helpers + one cached catalog read + one batched edge lookup.

import { BoundQuery, surql } from 'surrealdb';
import { recordStringId } from '../memory/edge-registry.js';

const TOKEN_RE = /[a-z0-9][a-z0-9_-]+/gi;

/**
 * Lowercase the input, extract alphanumeric tokens, drop tokens shorter than
 * 3 chars. Returns a Set of token strings.
 */
export function tokensOf(s) {
  const out = new Set();
  if (typeof s !== 'string') return out;
  const matches = s.toLowerCase().match(TOKEN_RE) ?? [];
  for (const m of matches) {
    if (m.length >= 3) out.add(m);
  }
  return out;
}

/**
 * @param {Array<{ id: any, name: string, type?: string }>} catalog
 * @param {Set<string>} queryTokens
 * @returns {Array<{ id: any, name: string, type?: string }>}
 */
export function matchCatalogEntities(catalog, queryTokens) {
  const matched = [];
  for (const ent of catalog) {
    const nameTokens = tokensOf(ent.name);
    if (nameTokens.size === 0) continue;
    let hit = false;
    for (const t of nameTokens) {
      if (queryTokens.has(t)) {
        hit = true;
        break;
      }
    }
    if (hit) matched.push({ id: ent.id, name: ent.name, type: ent.type });
  }
  return matched;
}

/**
 * Compute the entity-boost multiplier for one memo given its `about` entity
 * id-set and the set of catalog-matched query entity ids.
 *
 * @param {Set<string>|Iterable<string>} aboutIds  Entities the memo is about.
 * @param {Set<string>} matchedEntityIds           Catalog entities matched by the query.
 * @param {{ entity_boost_per_overlap?: number, entity_boost_max?: number }} cfg
 */
export function entityBoostFromAboutIds(aboutIds, matchedEntityIds, cfg = {}) {
  if (!matchedEntityIds || matchedEntityIds.size === 0) return { boost: 1.0, count: 0 };
  let overlap = 0;
  for (const eid of aboutIds) {
    if (matchedEntityIds.has(eid)) overlap++;
  }
  if (overlap === 0) return { boost: 1.0, count: 0 };
  const perOverlap = cfg.entity_boost_per_overlap ?? 0.10;
  const max = cfg.entity_boost_max ?? 1.25;
  const boost = Math.min(max, 1.0 + perOverlap * overlap);
  return { boost, count: overlap };
}

/**
 * Harvest entities mentioned in the last N biographed events of the
 * given session. Covers entities that exist in the in-flight thread but
 * haven't yet propagated into the top-N catalog (catalog is ordered by
 * `created_at DESC` and capped, so very recent entities can fall off
 * the cap until the next biographer run). See spec §3.1 candidate (2).
 *
 * @param {import('surrealdb').Surreal} db
 * @param {string|null} sessionId
 * @param {{ priorTailLimit?: number }} [opts]
 * @returns {Promise<Array<{ id: any, name?: string, type?: string }>>}
 */
export async function matchPriorTailEntities(db, sessionId, opts = {}) {
  const limit = opts.priorTailLimit ?? 3;
  if (!sessionId) return [];
  try {
    const [rows] = await db
      .query(
        new BoundQuery(
          `SELECT out AS entity FROM edges
           WHERE kind = 'mentions' AND in IN (
             SELECT id FROM events
             WHERE meta.session_id = $sid AND biographed_at IS NOT NONE
             ORDER BY ts DESC LIMIT $n
           )`,
          { sid: sessionId, n: limit },
        ),
      )
      .collect();
    const out = [];
    const seen = new Set();
    for (const r of rows ?? []) {
      const id = r.entity;
      const key = recordStringId(id);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      out.push({ id });
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * One batched `SELECT in, out FROM edges WHERE kind='about' AND in IN $ids`.
 * Returns `Map<memoIdString, Set<entityIdString>>`.
 */
export async function aboutEntitiesForMemos(db, memoIds) {
  const out = new Map();
  if (!memoIds || memoIds.length === 0) return out;
  const [rows] = await db
    .query(
      new BoundQuery(
        `SELECT in AS memo, out AS entity FROM edges WHERE kind = 'about' AND in IN $ids`,
        { ids: memoIds },
      ),
    )
    .collect();
  for (const r of rows ?? []) {
    const k = recordStringId(r.memo);
    if (!k) continue;
    if (!out.has(k)) out.set(k, new Set());
    out.get(k).add(recordStringId(r.entity));
  }
  return out;
}

// Catalog cache: 60s TTL keyed by profile (so a profile flip invalidates
// stale entries). Reads top-N entities by created_at — same pattern as
// biographer/pipeline.js:32 but with a larger cap (default 500).
let _catalogCache = null;
let _catalogCachedAt = 0;
let _catalogCachedProfile = null;

export async function readEntityCatalog(db, cfg = {}) {
  const ttlMs = (cfg.entity_catalog_ttl_seconds ?? 60) * 1000;
  const size = cfg.entity_catalog_size ?? 500;
  let profile = null;
  try {
    const [rows] = await db.query(surql`SELECT VALUE value.active_profile FROM runtime:embedder`).collect();
    profile = rows?.[0] ?? null;
  } catch {
    profile = null;
  }
  if (
    _catalogCache &&
    Date.now() - _catalogCachedAt < ttlMs &&
    _catalogCachedProfile === profile
  ) {
    return _catalogCache;
  }
  try {
    const [rows] = await db
      .query(
        new BoundQuery(
          `SELECT id, name, type FROM entities ORDER BY created_at DESC LIMIT $n`,
          { n: size },
        ),
      )
      .collect();
    _catalogCache = rows ?? [];
  } catch {
    _catalogCache = [];
  }
  _catalogCachedAt = Date.now();
  _catalogCachedProfile = profile;
  return _catalogCache;
}

export function __resetEntityCatalogCacheForTests() {
  _catalogCache = null;
  _catalogCachedAt = 0;
  _catalogCachedProfile = null;
}
```

- [ ] **Step 4: Run → pass**

```bash
npm run test:unit -- --test-name-pattern 'tokensOf|matchCatalogEntities|entityBoostFromAboutIds'
```

- [ ] **Step 5: Commit**

```bash
git commit -m "feat(intuition): entities.js — query-side match + about-edge lookup + catalog cache"
```

### Task 8.2 — Catalog cache TTL test

**Files:** `system/tests/unit/intuition-entities-catalog.test.js`

- [ ] **Step 1: Write the test**

Create `system/tests/unit/intuition-entities-catalog.test.js`:

```js
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { surql } from 'surrealdb';
import {
  readEntityCatalog,
  __resetEntityCatalogCacheForTests,
} from '../../cognition/intuition/entities.js';
import { writeConfig } from '../../config/paths.js';
import { close, connect } from '../../data/db/client.js';
import { runMigrations } from '../../data/db/migrate.js';

async function fresh() {
  const home = mkdtempSync(join(tmpdir(), 'robin-catalog-'));
  process.env.ROBIN_HOME = home;
  await writeConfig({ embedder_profile: 'mxbai-1024' });
  const db = await connect({ engine: 'mem://' });
  await runMigrations(db, resolve(import.meta.dirname, '../../data/db/migrations'));
  await db.query(surql`UPSERT runtime:embedder SET value = { active_profile: 'mxbai-1024' }`).collect();
  return db;
}

test('readEntityCatalog caches within TTL', async () => {
  __resetEntityCatalogCacheForTests();
  const db = await fresh();
  await db.query(surql`CREATE entities CONTENT ${{
    id: 'entities:e1', name: 'Alice', name_lower: 'alice', type: 'person',
  }}`).collect();

  const first = await readEntityCatalog(db, { entity_catalog_ttl_seconds: 60 });
  assert.equal(first.length, 1);

  // Mutate the DB; cache should ignore until TTL expires.
  await db.query(surql`CREATE entities CONTENT ${{
    id: 'entities:e2', name: 'Bob', name_lower: 'bob', type: 'person',
  }}`).collect();

  const second = await readEntityCatalog(db, { entity_catalog_ttl_seconds: 60 });
  assert.equal(second.length, 1, 'cache should still return 1 entry within TTL');

  __resetEntityCatalogCacheForTests();
  const third = await readEntityCatalog(db, { entity_catalog_ttl_seconds: 60 });
  assert.equal(third.length, 2);

  await close(db);
});
```

- [ ] **Step 2: Run → pass**

```bash
npm run test:unit -- --test-name-pattern 'readEntityCatalog caches within TTL'
```

- [ ] **Step 3: Commit**

```bash
git commit -m "test(intuition): entity catalog TTL cache behavior"
```

### Task 8.3 — Prior-tail biographed entities (spec §3.1 candidate 2)

**Files:** `system/cognition/intuition/entities.js` (already contains the `matchPriorTailEntities` export from Task 8.1), `system/tests/unit/intuition-entities.test.js`

> The spec specifies the entity source is the **union** of (1) catalog
> tokens-match against query+priorTail and (2) prior-assistant-tail
> biographed entities sourced from `mentions` edges. Task 8.1 already
> ships the helper. This task adds the unit test and wires the helper
> into the inject.js call site (Task 9.2 picks up the wiring).

- [ ] **Step 1: Failing test (entities-not-yet-in-catalog case)**

Append to `system/tests/unit/intuition-entities.test.js`:

```js
import { matchPriorTailEntities } from '../../cognition/intuition/entities.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { surql } from 'surrealdb';
import { writeConfig } from '../../config/paths.js';
import { close, connect } from '../../data/db/client.js';
import { runMigrations } from '../../data/db/migrate.js';

async function fresh() {
  const home = mkdtempSync(join(tmpdir(), 'robin-priortail-'));
  process.env.ROBIN_HOME = home;
  await writeConfig({ embedder_profile: 'mxbai-1024' });
  const db = await connect({ engine: 'mem://' });
  await runMigrations(db, resolve(import.meta.dirname, '../../data/db/migrations'));
  await db.query(surql`UPSERT runtime:embedder SET value = { active_profile: 'mxbai-1024' }`).collect();
  return db;
}

test('matchPriorTailEntities harvests mentions edges off recent biographed events', async () => {
  const db = await fresh();
  await db.query(surql`CREATE entities CONTENT ${{
    id: 'entities:nora', name: 'Nora', name_lower: 'nora', type: 'person',
  }}`).collect();
  const [evtRows] = await db.query(surql`CREATE events CONTENT ${{
    content: 'discussed pipeline with nora',
    meta: { session_id: 's-pt' },
    biographed_at: new Date(),
  }}`).collect();
  const evtId = evtRows[0].id;
  await db.query(surql`CREATE edges CONTENT ${{
    in: evtId, out: 'entities:nora', kind: 'mentions',
  }}`).collect();

  const out = await matchPriorTailEntities(db, 's-pt', { priorTailLimit: 3 });
  assert.equal(out.length, 1);
  assert.equal(String(out[0].id), 'entities:nora');
  await close(db);
});

test('matchPriorTailEntities returns [] when sessionId is null', async () => {
  const db = await fresh();
  const out = await matchPriorTailEntities(db, null);
  assert.deepEqual(out, []);
  await close(db);
});
```

- [ ] **Step 2: Run → pass**

```bash
npm run test:unit -- --test-name-pattern 'matchPriorTailEntities'
```

- [ ] **Step 3: Commit**

```bash
git commit -m "test(intuition): prior-tail biographed entity harvest"
```

---

## Phase 9 — A2 score-formula change

### Task 9.1 — `rank.score` accepts `entityBoost` via callerCtx

**Files:** `system/cognition/intuition/rank.js`, `system/tests/unit/rank-score-entity-boost.test.js`

> **Naming convention (intentional, audited).** Per-hit `score_components`
> uses JS-camelCase (`entityBoost`, `entityBoostCount`) to match the
> existing `cosineSim`/`scopeBoost`/`contraPenalty`/`trustFactor` keys on
> the same object. Aggregate telemetry on `intuition_telemetry.meta` uses
> snake_case (`entity_boost_applied`, `entity_boost_count`, `mmr_drops`,
> `mmr_vec_coverage`, `query_entities_matched`) to match existing
> telemetry conventions (`latency_ms`, `tokens_injected`, `query_chars`).
> Both layers are audited; do not normalize either to the other.

- [ ] **Step 1: Failing test**

Create `system/tests/unit/rank-score-entity-boost.test.js`:

```js
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { score } from '../../cognition/intuition/rank.js';

const baseHit = () => ({
  record: {
    kind: 'knowledge',
    confidence: 0.8,
    signal_count: 2,
    decay_anchor: new Date(Date.now() - 86400_000).toISOString(),
    derived_by: 'manual',
    source: undefined,
    scope: 'global',
  },
  distance: 0.2,
});

test('score(hit) defaults entityBoost=1.0 (regression guard)', () => {
  const a = score(baseHit());
  const b = score(baseHit(), { entityBoost: 1.0 });
  assert.ok(Math.abs(a.score - b.score) < 1e-9);
  assert.equal(a.components.entityBoost, 1.0);
  assert.equal(a.components.entityBoostCount, 0);
});

test('score(hit, {entityBoost: 1.25}) multiplies total by 1.25', () => {
  const baseline = score(baseHit());
  const boosted = score(baseHit(), { entityBoost: 1.25, entityBoostCount: 2 });
  assert.ok(Math.abs(boosted.score - baseline.score * 1.25) < 1e-9);
  assert.equal(boosted.components.entityBoost, 1.25);
  assert.equal(boosted.components.entityBoostCount, 2);
});

test('score: entityBoost stacks multiplicatively with scopeBoost', () => {
  const hit = baseHit();
  hit.record.scope = 'project:foo';
  const a = score(hit, { scope: 'project:foo' });             // scopeBoost=1.2
  const b = score(hit, { scope: 'project:foo', entityBoost: 1.25 });
  assert.ok(Math.abs(b.score - a.score * 1.25) < 1e-9);
});
```

- [ ] **Step 2: Run → fail**

```bash
npm run test:unit -- --test-name-pattern 'defaults entityBoost|multiplies total by 1.25|stacks multiplicatively'
```

- [ ] **Step 3: Edit `rank.js`**

In `system/cognition/intuition/rank.js`, replace the `score` function (lines 39-62) with:

```js
/**
 * Compute the ranking score for a single hit.
 *
 * @param {{
 *   record: { kind?: string, confidence?: number, signal_count?: number,
 *             decay_anchor?: any, derived_by?: string, source?: string, scope?: string },
 *   distance: number,
 *   supersededCount?: number,
 *   contradictionCount?: number,
 * }} hit
 * @param {{ scope?: string, session_id?: string, entityBoost?: number, entityBoostCount?: number }} [callerCtx]
 */
export function score(hit, callerCtx = {}) {
  const { record, distance, supersededCount = 0, contradictionCount = 0 } = hit;

  const cosineSim = Math.max(0, Math.min(1, 1 - (distance ?? 0)));
  const fresh = freshness(
    {
      kind: record.kind,
      confidence: record.confidence,
      signal_count: record.signal_count,
      decay_anchor: record.decay_anchor,
    },
    { supersededCount },
  );
  const contraPenalty = Math.max(0.1, 1 - 0.3 * contradictionCount);
  const trustKey = record.derived_by ?? record.source ?? 'manual';
  const trustFactor = TRUST_FACTOR[trustKey] ?? 0.9;
  const scopeBoost = _scopeBoost(record.scope, callerCtx);
  const entityBoost = typeof callerCtx.entityBoost === 'number' ? callerCtx.entityBoost : 1.0;
  const entityBoostCount = typeof callerCtx.entityBoostCount === 'number' ? callerCtx.entityBoostCount : 0;

  const total = cosineSim * fresh * contraPenalty * trustFactor * scopeBoost * entityBoost;
  return {
    score: total,
    components: { cosineSim, fresh, contraPenalty, trustFactor, scopeBoost, entityBoost, entityBoostCount },
  };
}
```

- [ ] **Step 4: Run → pass**

```bash
npm run test:unit -- --test-name-pattern 'defaults entityBoost|multiplies total by 1.25|stacks multiplicatively'
```

- [ ] **Step 5: Run any existing rank tests → pass (regression guard)**

```bash
npm run test:unit -- --test-name-pattern 'rank'
```

Pre-existing tests that omit `entityBoost` in callerCtx must continue to pass — the default of 1.0 keeps the product unchanged.

- [ ] **Step 6: Commit**

```bash
git commit -m "feat(rank): A2 entityBoost in score callerCtx (backward-compatible)"
```

### Task 9.2 — Wire entity boost into `inject.js`

**Files:** `system/cognition/intuition/inject.js`

- [ ] **Step 1: Edit imports**

In `inject.js`, add:

```js
import {
  aboutEntitiesForMemos,
  entityBoostFromAboutIds,
  matchCatalogEntities,
  matchPriorTailEntities,
  readEntityCatalog,
  tokensOf,
} from './entities.js';
```

- [ ] **Step 2: Declare A2 outer-scope telemetry variables**

Alongside the MMR variables declared in Phase 6 step 2:

```js
  let entityBoostAppliedOut = false;
  let entityBoostCountOut = 0;
  let queryEntitiesMatchedOut = 0;
```

- [ ] **Step 3: Compute boost per hit before the score loop**

Replace the merge-and-score block (currently `const merged = [...eventHits, ...memoHits].map((h) => ({ ...h, _scored: score(h, { session_id: undefined }) }))`):

```js
    // A2: entity boost. Gated by cfg.entity_boost_enabled. Boosts memos
    // whose `about` edges point at entities matched by (a) the query
    // tokens against the catalog, unioned with (b) entities mentioned in
    // recent prior-tail biographed events (spec §3.1 candidates 1+2).
    let matchedEntityIds = new Set();
    let aboutByMemo = new Map();
    let queryEntitiesMatched = 0;
    if (cfg.entity_boost_enabled !== false) {
      try {
        const catalog = await readEntityCatalog(db, cfg);
        const queryTokens = tokensOf(combined);
        const matched = matchCatalogEntities(catalog, queryTokens);
        const priorTail = await matchPriorTailEntities(db, sessionId).catch(() => []);
        matchedEntityIds = new Set(matched.map((m) => String(m.id)));
        for (const e of priorTail) matchedEntityIds.add(String(e.id));
        queryEntitiesMatched = matchedEntityIds.size;
        const memoIdRefs = memoHits.map((h) => h.record.id);
        if (memoIdRefs.length > 0 && matchedEntityIds.size > 0) {
          aboutByMemo = await aboutEntitiesForMemos(db, memoIdRefs);
        }
      } catch {
        // Fail-soft: no boost applied.
      }
    }

    const merged = [...eventHits, ...memoHits].map((h) => {
      let entityBoost = 1.0;
      let entityBoostCount = 0;
      if (h._kind === 'memo' && matchedEntityIds.size > 0) {
        const memoKey = recordStringId(h.record.id);
        const aboutIds = aboutByMemo.get(memoKey) ?? new Set();
        const r = entityBoostFromAboutIds(aboutIds, matchedEntityIds, cfg);
        entityBoost = r.boost;
        entityBoostCount = r.count;
      }
      return {
        ...h,
        _scored: score(h, { session_id: undefined, entityBoost, entityBoostCount }),
      };
    });
    merged.sort((a, b) => (b._scored.score ?? 0) - (a._scored.score ?? 0));

    // Capture A2 telemetry for the outer-scope variables.
    queryEntitiesMatchedOut = queryEntitiesMatched;
    for (const m of merged) {
      const eb = m._scored?.components?.entityBoost ?? 1.0;
      if (eb > 1.0) {
        entityBoostAppliedOut = true;
        entityBoostCountOut += 1;
      }
    }
```

- [ ] **Step 4: Reuse `_scored.components` in the recall_log ranked_hits**

The ranked_hits map at `inject.js:196-201` recomputes `score()` with no callerCtx — that throws away the entity boost. Replace it with reuse of the already-computed component object via `deduped`:

```js
    const dedupedById = new Map(deduped.map((d) => [String(d.record.id), d]));
    const rankedHits = hits.map((h, i) => {
      const m = dedupedById.get(String(h.id));
      return {
        record: h.id,
        kind: h._kind,
        score_components: m?._scored?.components ?? {},
        rank: i,
      };
    });
```

- [ ] **Step 5: Extend the telemetry write to include A2 fields**

Update the meta object in the telemetry write (the one from Phase 6 step 2):

```js
          meta: {
            mmr_drops: mmrDropsOut,
            mmr_path: mmrPathOut,
            mmr_vec_coverage: mmrVecCoverageOut,
            entity_boost_applied: entityBoostAppliedOut,
            entity_boost_count: entityBoostCountOut,
            query_entities_matched: queryEntitiesMatchedOut,
          },
```

- [ ] **Step 6: Run the cosine end-to-end test from Phase 6 → still passes**

```bash
npm run test:integration -- --test-name-pattern 'mmr_path=cosine'
```

- [ ] **Step 7: Commit**

```bash
git commit -m "feat(intuition): A2 entity-aware boost wired into inject.js"
```

### Task 9.3 — End-to-end entity-boost integration test

**Files:** `system/tests/integration/intuition-entity-boost-end-to-end.test.js`

- [ ] **Step 1: Write the test**

Create `system/tests/integration/intuition-entity-boost-end-to-end.test.js`:

```js
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { surql } from 'surrealdb';
import * as store from '../../cognition/memory/store.js';
import { intuitionEndpoint } from '../../cognition/intuition/inject.js';
import { __resetEntityCatalogCacheForTests } from '../../cognition/intuition/entities.js';
import { writeConfig } from '../../config/paths.js';
import { close, connect } from '../../data/db/client.js';
import { runMigrations } from '../../data/db/migrate.js';
import { createStubEmbedder } from '../../data/embed/embedder.js';

async function fresh() {
  __resetEntityCatalogCacheForTests();
  const home = mkdtempSync(join(tmpdir(), 'robin-entboost-'));
  process.env.ROBIN_HOME = home;
  await writeConfig({ embedder_profile: 'mxbai-1024' });
  const db = await connect({ engine: 'mem://' });
  await runMigrations(db, resolve(import.meta.dirname, '../../data/db/migrations'));
  await db.query(surql`UPSERT runtime:embedder SET value = { active_profile: 'mxbai-1024' }`).collect();
  return db;
}

test('intuitionEndpoint applies entity boost on memos with about-edge match', async () => {
  const db = await fresh();
  const e = createStubEmbedder({ dimension: 1024 });

  // Seed entity.
  await db.query(surql`CREATE entities CONTENT ${{
    id: 'entities:karen',
    name: 'Karen',
    name_lower: 'karen',
    type: 'person',
  }}`).collect();

  // Seed memo + about edge.
  const memo = await store.note(db, e, 'knowledge', {
    content: 'karen prefers heirloom tomatoes', derived_by: 'manual',
  });
  await store.relate(db, memo.id, 'entities:karen', 'about');

  __resetEntityCatalogCacheForTests();

  await intuitionEndpoint({
    db, embedder: e, query: 'karen plans for tomatoes', priorAssistant: '',
    k: 6, recencyDays: 30, tokenBudget: 1500, sessionId: 's1',
  });

  const [tel] = await db.query(surql`SELECT meta FROM intuition_telemetry`).collect();
  assert.equal(tel[0].meta?.entity_boost_applied, true);
  assert.ok(tel[0].meta?.entity_boost_count >= 1);
  assert.equal(tel[0].meta?.query_entities_matched, 1);

  const [recall] = await db.query(surql`SELECT ranked_hits FROM recall_log`).collect();
  const boostedHit = recall[0].ranked_hits.find((h) => h.score_components?.entityBoost > 1.0);
  assert.ok(boostedHit, 'expected at least one hit with entityBoost > 1.0');

  await close(db);
});
```

- [ ] **Step 2: Run → pass**

```bash
npm run test:integration -- --test-name-pattern 'applies entity boost on memos with about-edge match'
```

- [ ] **Step 3: Commit**

```bash
git commit -m "test(intuition): A2 entity-boost end-to-end"
```

---

## Phase 10 — Telemetry surface + MCP recall annotations

### Task 10.1 — MCP `recall` tool writes `meta.from` + `meta.latency_ms`

**Files:** `system/io/mcp/tools/recall.js`, `system/tests/unit/tool-recall.test.js`

- [ ] **Step 1: Failing test**

Append to `system/tests/unit/tool-recall.test.js`:

```js
test('mcp recall tool writes meta.from=mcp_recall and meta.latency_ms on recall_log', async () => {
  const db = await fresh();
  const e = createStubEmbedder({ dimension: 1024 });
  await recordEvent(db, e, { source: 'cli', content: 'sourdough recipe' });
  const detector = { check: () => ({ repeat: false }), observe: () => {} };
  const tool = createRecallTool({ db, embedder: e, detector, getSessionId: () => 'sess-x' });
  await tool.handler({ query: 'sourdough', limit: 3 });
  const [rows] = await db.query(surql`SELECT meta FROM recall_log`).collect();
  assert.equal(rows[0].meta?.from, 'mcp_recall');
  assert.ok(typeof rows[0].meta?.latency_ms === 'number');
});
```

(Match the file's existing import + fresh-db helper conventions.)

- [ ] **Step 2: Run → fail**

```bash
npm run test:unit -- --test-name-pattern 'mcp recall tool writes meta.from'
```

- [ ] **Step 3: Edit `recall.js`**

In `system/io/mcp/tools/recall.js`, at line 34 inside `handler: async (args) => {`, capture `const t0 = Date.now();` as the first statement. Then update the `recall_log` write at lines 113-124 to include `meta.from` and `meta.latency_ms`:

```js
      const latency_ms = Date.now() - t0;
      const baseMeta = { from: 'mcp_recall', latency_ms };
      const meta = repeat ? { ...baseMeta, repeat_query_within_5min: true } : baseMeta;
      try {
        await db
          .query(
            surql`CREATE recall_log CONTENT ${{
              query: args.query,
              k: args.limit ?? 10,
              ranked_hits: rankedHits,
              session_id: sessionId,
              meta,
            }}`,
          )
          .collect();
      } catch {
        // recall_log write is advisory — never fail the recall on telemetry errors.
      }
```

- [ ] **Step 4: Run → pass**

```bash
npm run test:unit -- --test-name-pattern 'mcp recall tool writes meta.from'
```

- [ ] **Step 5: Commit**

```bash
git commit -m "feat(mcp): recall tool tags recall_log meta.from + latency_ms"
```

---

## Phase 11 — Cross-design fix: focus_block_present in recall_log

> **Why:** Cross-design note from the brainstorming round (D1-distorts-A3). D1 introduces `focus_block` (`docs/superpowers/specs/2026-05-11-cognition-d1-state-inference-design.md:338`) which inflates the injected-context length and changes recall behavior. A3 must record `focus_block_present` + `focus_block_tokens` per `recall_log` row and stratify metrics by them. The fixture in Task 4.1 already includes the field; this phase ensures live writes set it too.

### Task 11.1 — Record `focus_block_present` / `focus_block_tokens` defaults on recall_log

**Files:** `system/cognition/intuition/inject.js`

- [ ] **Step 1: Read context**

D1 will ship `focus_block` (string) and `focus_tokens` (number) as additional response fields from the intuition endpoint. Until D1 lands, intuition produces no focus block. A3 still records the two fields (defaults: `present=false`, `tokens=0`) so the stratification baseline is valid the moment D1 starts emitting non-zero values.

- [ ] **Step 2: Edit `inject.js` — extend recall_log meta**

Update the recall_log meta object (the one from Phase 6 step 2, step 5) to include focus-block defaults:

```js
            meta: {
              latency_ms,
              truncated,
              from: 'intuition',
              focus_block_present: false,
              focus_block_tokens: 0,
            },
```

When D1 lands, those defaults flip to real values via D1's PR — the field shape stays stable.

- [ ] **Step 3: Verify scoreRows stratification still passes**

```bash
npm run test:unit -- --test-name-pattern 'scoreRows stratifies metrics by focus_block_present'
```

Task 4.1's test asserts both `focus_block` and `no_focus_block` buckets exist. New recall_log rows populate the `no_focus_block` bucket pre-D1 — the correct baseline.

- [ ] **Step 4: Verify the live recall_log write asserts the defaults**

The cosine end-to-end test (Phase 6 Task 6.2) already asserts
`recall_log.meta.focus_block_present === false` and
`recall_log.meta.focus_block_tokens === 0` on the row written during the
test. Re-run that test to confirm no regression:

```bash
npm run test:integration -- --test-name-pattern 'mmr_path=cosine'
```

- [ ] **Step 5: Commit**

```bash
git commit -m "feat(intuition): record focus_block_present + focus_block_tokens on recall_log"
```

---

## Phase 12 — Docs

### Task 12.1 — Update `docs/faculties.md`

**Files:** `docs/faculties.md`

- [ ] **Step 1: Locate the "Intuition" and "Recall" sections**

```bash
grep -n '^## \|^### ' docs/faculties.md | head -40
```

- [ ] **Step 2: Append/extend**

Under **Intuition**, add a subsection:

```markdown
### MMR diversity (A1)

When `runtime:recall.value.mmr_use_cosine = true` (default), the intuition
endpoint batches a `SELECT record, vector FROM embeddings_<profile>_<surface>
WHERE record IN $ids` for every non-empty surface and uses real cosine
similarity to drop near-duplicates. The threshold is
`runtime:recall.value.mmr_threshold` (default `0.92`). When vectors are
unavailable (legacy rows, profile mid-migration) MMR falls back to the
substring-overlap proxy with the lower threshold
`runtime:recall.value.mmr_threshold_legacy_substring` (default `0.85`). The
chosen path is recorded under `intuition_telemetry.meta.mmr_path`.

### Entity-aware boost (A2)

When `runtime:recall.value.entity_boost_enabled = true` (default), memos
whose `about` edges point at entities matched against the query + prior
assistant tail get a bounded score multiplier (`[1.0, 1.25]`, default
+0.10 per overlap, capped). The entity catalog is read with a 60-second TTL.
The boost is recorded per-hit under
`recall_log.ranked_hits[*].score_components.entityBoost` and aggregated
under `intuition_telemetry.meta.entity_boost_applied` /
`entity_boost_count` / `query_entities_matched`.
```

Under **Recall**, add:

```markdown
### Evaluation harness (A3)

`robin recall-eval` scores historical `recall_log` rows against
correction-derived labels (`negative` on `outcome=corrected`,
`soft_positive` on `outcome=reinforced`, `unlabeled` otherwise) and writes
per-run rollups to `recall_eval_runs`. Replay mode (`--replay`) re-scores
hits against the current `rank.score` + MMR + entity-boost using current
embedding vectors; mean Kendall τ between recorded and replayed orderings
is recorded under `recall_eval_runs.metrics.replay_kendall_mean`. Metrics
are stratified by `recall_log.meta.focus_block_present` so the D1 focus
block does not distort the baseline.
```

- [ ] **Step 3: Commit**

```bash
git commit -m "docs(faculties): A1 MMR + A2 entity boost + A3 eval harness"
```

### Task 12.2 — Update `docs/development.md`

**Files:** `docs/development.md`

- [ ] **Step 1: Append a "Recall evaluation" subsection**

```markdown
## Recall evaluation

Score historical recall behavior:

```bash
# Default: 30-day window, all sources, no replay
robin recall-eval

# JSON for CI/cron consumption
robin recall-eval --window 7d --json --limit 5000

# Re-score under the current rank.score + MMR + entity-boost
robin recall-eval --replay --window 30d --json
```

Exit codes:

- `0` — `rows_scored ≥ min_rows`, no metric breached.
- `1` — `rows_scored < min_rows` (inconclusive; do not page).
- `2` — at least one metric breached `runtime:recall_eval.thresholds`. Page.
- `3` — harness error (DB open, profile inactive, invalid args). Page.

Threshold defaults are seeded by migration `0010-recall-eval-and-mmr.surql`;
tune in `runtime:recall_eval.thresholds.value` after the first baseline run.
```

- [ ] **Step 2: Commit**

```bash
git commit -m "docs(development): robin recall-eval CLI usage"
```

---

## Phase 13 — Final verification

### Task 13.1 — Full test + lint sweep

- [ ] **Step 1: Run all unit tests**

```bash
npm run test:unit
```

Expected: all pass.

- [ ] **Step 2: Run all integration tests**

```bash
npm run test:integration
```

Expected: all pass.

- [ ] **Step 3: Lint**

```bash
npm run lint
```

Expected: zero errors. Biome auto-imports may need a follow-up `npm run format`.

- [ ] **Step 4: Verify the audit-introspection-readonly gate still passes**

```bash
npm run test:unit -- --test-name-pattern 'introspection tools never write'
```

The A3 CLI (`recall-eval.js`) is **not** an MCP introspection tool — it lives in `system/runtime/cli/commands/` and is allowed to write `recall_eval_runs`. The existing audit test (`system/tests/unit/audit-introspection-readonly.test.js`) scans only `system/io/mcp/tools/`, so this phase confirms no regression.

- [ ] **Step 5: Self-review checklist**

  - [ ] Spec §1 (A3 CLI surface, data sources, labels, metrics, schema, replay, output, exit codes, failure modes) → Phases 1, 2, 3, 4, 5.
  - [ ] Spec §2 (A1 vectors, cosine helper, threshold, fallback, telemetry) → Phases 6 + 7.
  - [ ] Spec §3 (A2 entity source, match, boost, formula, MCP scoping, telemetry) → Phases 8, 9.
  - [ ] Spec §4 (shared schema additions) → Phase 1 Task 1.1 + 1.2.
  - [ ] Spec §5 (file-by-file changes) → file structure table at top.
  - [ ] Spec §6 (telemetry summary) → Phases 6, 9 (inject.js), 10 (mcp recall), 11 (focus block).
  - [ ] Spec §7 (cost envelope) — reviewed at Phase 13.
  - [ ] Spec §8 (test plan):
    - §8.1 cosine helper / MMR → Task 6.1.
    - §8.2 entity boost → Task 8.1.
    - §8.3 rank.score regression → Task 9.1.
    - §8.4 eval metrics → Task 3.1.
    - §8.5 intuition end-to-end → Task 6.2 + 9.3.
    - §8.6 recall-eval replay integration → Task 5.2.
    - §8.7 recall-eval CLI → Task 5.1.
    - §8.8 substring fallback → Task 6.2 (second test file).
    - §8.9 rank pre-A2 fixture → Task 9.1 regression guard.
    - §8.10 reinforcement-loop compat → covered by Task 13.1 `npm run test:integration` (existing reinforcement tests run unchanged).
    - §8.11 exit codes → Task 5.1.
  - [ ] Spec §9 (sequencing) — A3 first (Phases 1-5), A1 second (Phases 6-7), A2 last (Phases 8-9). Migration ships in Phase 1.
  - [ ] Spec §10 (dependencies) — noted in plan header.
  - [ ] Spec §11 (open questions) — non-blocking; captured below.

- [ ] **Step 6: Commit any final cleanups**

```bash
git status
git commit -m "chore: post-cleanup after A3+A1+A2 bundle" # only if there are changes
```

### Task 13.2 — Open questions (for post-impl review)

Carry these forward as follow-ups; do not block this plan:

- Should A2 boost event hits via the `mentions` edge with lower confidence (current: memo-only)?
- Per-session entity-boost dedup if telemetry shows boost saturation.
- Single `UNION` query for vector hydration if profiler flags it.
- Tightening the `meta.from` heuristic window once 7 days of post-migration data exist (spec §1.1).
- Tightening soft-positive labels to "uncorrected AND used-marker present" when B1 ships (spec §1.3).
- Updating `explain_recall` (Theme 4 MCP tool) to surface the new `score_components.entityBoost` keys (one-line follow-up).

## Final commit

```bash
git push -u origin refactor/system-restructure
gh pr create --title "Cognition A3+A1+A2: recall eval harness, real-cosine MMR, entity boost"
```
