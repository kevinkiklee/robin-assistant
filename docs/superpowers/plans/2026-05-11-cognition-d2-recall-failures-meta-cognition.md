# Cognition D2 — Recall-failures Meta-cognition · Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up a weekly internal job (`meta-recall-narrative`) that reads `recall_log` failures from the trailing 7 days, clusters retrieved memos by shared `about` endpoints in-Node, calls one `tier:'fast'` LLM to name the patterns, and writes one `kind='reasoning'` memo (`meta.dimension='recall_failures'`) plus 0–3 `rule_candidates` (`kind='behavior'`, `payload.source='meta_cognition'`). Surface the resulting reasoning memo at intuition recall by widening `inject.js`'s `searchMemos` `kind` filter to `['knowledge','reasoning']`. Ship behind a three-valued runtime flag (`false` | `'shadow'` | `true`).

**Architecture:** A new internal job in `system/cognition/jobs/internal/meta-recall-narrative.js` fires every Sunday at 05:00 local time. It reads a runtime config row, applies a min-corrections gate (default 5/week), pulls corrected rows (and post-B1 `used=false` rows as a downweighted secondary signal), drops any row whose retrieved-memo evidence chain touches `scope='private'` (mirroring `outbound-policy.js`), hydrates `about` edges, runs pure-JS clustering (`meta_cognition/cluster.js`), builds a multi-cluster prompt (`meta_cognition/prompt.js`), invokes the LLM, validates the response (`meta_cognition/output.js`), writes a `kind='reasoning'` memo via `store.note`, and emits ≤ `max_rules_per_run` `rule_candidates`. Provenance to the source `recall_log` rows is encoded as `meta.recall_log_ids` (stringified record refs) — **not** `derived_from` edges — because `edge-registry.js` restricts `derived_from` to substrate endpoints. Telemetry rows go to `meta_cognition_telemetry`; rollup defers to C3.

**Tech Stack:** Node.js 22+ (ESM), SurrealDB 3.0.5 + `@surrealdb/node` 3.0.3 + `surrealdb` 2.0.3, `host.invokeLLM` (existing fast-tier wrapper), `node:test`.

**Spec:** `docs/superpowers/specs/2026-05-11-cognition-d2-recall-failures-meta-cognition-design.md` (revised).

**Style anchor:** `docs/superpowers/plans/2026-05-11-cognition-d1-state-inference.md` (closest analog: new internal job + new memo subkind + recall-surfacing inject.js change).

**Dependencies:**
- B1 (`recall_log.ranked_hits[].used` + `recall_log.attribution.mode`) — secondary input. D2 degrades cleanly to corrected-only mode when B1 hasn't shipped (`ranked_hits[*].used CONTAINS false` returns no rows on a column-less row).
- Theme 2a `evidence_ledger` is referenced indirectly only; D2 reads `recall_log` directly.
- Themes 1b/1c (scope inheritance) — the privacy filter mirrors `outbound-policy.js:checkOutboundScope`.
- The `refactor/system-restructure` package layout (already merged).

**Cross-cutting decisions (locked in by the spec revision):**

1. **Migration:** D2 owns `0018-meta-cognition.surql` (initial-off). Shadow / enable are separate rollout migrations (`0019-...-shadow.surql`, `0021-...-enable.surql`) — gaps below 0021 reserved for D3 follow-ups per spec §13.1. Renumber inline if a sibling spec claims one of those slots before D2 lands.
2. **`rule_candidates` discriminator:** D2 writes `kind='behavior'`, `payload.source='meta_cognition'`. D3 (sibling) writes `kind='behavior'`, `payload.source='meta_cognition_calibration'`. The two producers coexist alongside `step-reflection.js` (which writes neither discriminator).
3. **Schedule:** Sunday 05:00 **local** time. The cron parser (`system/cognition/jobs/cron.js:75-85`) evaluates `Date#getHours()`/`getDay()` against local time — not UTC.
4. **`reasoning` memo lineage:** encoded as `meta.recall_log_ids` (array of `String(r.id)`), **not** `derived_from` edges. Consumers must reconstruct each id as `new RecordId(tbl, key)` before binding into `WHERE id IN $ids`.
5. **Privacy filter:** forward arrow — `M ->derived_from-> memos[WHERE scope='private']` (per spec §3.1, §7). This is the **inverse** of `outbound-policy.js`'s `<-derived_from<-memos[…]`; both use the same edge registry but interrogate different surfaces.
6. **Array-kind ripple:** `searchMemos`'s `opts.kind` accepts string OR array. Use a shared `kindFilter(kind, bindings)` helper in `store.js` and call it from BOTH `_surfaceSearch`'s post-filter and `listMemos`'s WHERE construction.
7. **`inject.js` prologue coordination:** B2 + D1 + D2 all touch `inject.js`. Anchor edits to the `Promise.all([recall(...), store.searchMemos(...)])` fan-out site (structural anchor), not line numbers.
8. **Reserved `meta.dimension` values:** `'recall_failures'` (D2 — this plan) and `'calibration'` (D3 sibling). Documented in `kind-registry.js` comment.
9. **Three-valued `enabled` flag:** `false` | `'shadow'` | `true`. `'shadow'` runs clustering + telemetry, **never** calls the LLM, **never** writes a memo or candidate.
10. **Telemetry storage:** defers to C3 spec. D2's `meta_cognition_telemetry` table shape is locked in by `0018-meta-cognition.surql` and ratified later.
11. **`server.js` R-3 coordination:** D2 does NOT register a daemon ticker or MCP tool (the internal job is dispatched by the existing cron runner). No `server.js` edit required by D2.

---

## File structure

| File | Status | Responsibility |
|---|---|---|
| `system/data/db/migrations/0018-meta-cognition.surql` | new | D2-initial-off: `meta_cognition_telemetry` table + indexes + `runtime:\`meta_cognition.config\`` seed (`enabled: false`, `min_corrections_threshold: 5`, `unused_signal_weight: 0.33`, …) |
| `system/data/db/migrations/0019-meta-cognition-shadow.surql` | new (Phase 12) | Rollout flip: `UPSERT runtime:\`meta_cognition.config\` SET value.enabled = 'shadow'` |
| `system/data/db/migrations/0021-meta-cognition-enable.surql` | new (Phase 12) | Rollout flip: `UPSERT runtime:\`meta_cognition.config\` SET value.enabled = true` |
| `system/cognition/memory/kind-registry.js` | modify | Extend `MEMO_KIND_REGISTRY.reasoning.meta_schema` to include `dimension`, `from_signal`, `period`, `signal_count`, `week_starting`, `clusters`, `recall_log_ids`. Document reserved `meta.dimension` values. |
| `system/cognition/memory/decay.js` | modify | Add `reasoning: 30 * 24 * 60 * 60 * 1000` to `HALF_LIFE_BY_KIND_MS` |
| `system/cognition/memory/store.js` | modify | Introduce `kindFilter(kind, bindings)` helper. Refactor `_surfaceSearch` and `listMemos` to call it. String OR array `opts.kind` becomes supported. |
| `system/cognition/intuition/rank.js` | modify | Add `meta_cognition: 0.9` to `TRUST_FACTOR` |
| `system/cognition/intuition/inject.js` | modify | Inside the `Promise.all([recall(...), store.searchMemos(...)])` fan-out, change `searchMemos`'s `kind: 'knowledge'` to `kind: ['knowledge', 'reasoning']` (structural anchor — coordinate with B2/D1) |
| `system/cognition/meta_cognition/cluster.js` | new | Pure function `clusterByAboutEndpoints(hydrated, config)`. No DB imports. |
| `system/cognition/meta_cognition/prompt.js` | new | `META_COGNITION_SYSTEM` constant + `buildUserPrompt(clusters, meta, config)` |
| `system/cognition/meta_cognition/output.js` | new | `validateMetaCognitionOutput(parsed, config)` — JSON shape validator |
| `system/cognition/jobs/internal/meta-recall-narrative.js` | new | Internal-job orchestrator: read config → gate → pull corrected/unused rows → privacy filter → hydrate → cluster → LLM → validate → write memo + rule_candidates → telemetry |
| `system/cognition/jobs/builtin/meta-recall-narrative.md` | new | Manifest: `0 5 * * 0`, `runtime: internal`, `enabled: false`, `catch_up: false`, `timeout_minutes: 5` |
| `system/tests/unit/meta-cognition-cluster.test.js` | new | Pure clustering unit tests |
| `system/tests/unit/meta-cognition-prompt.test.js` | new | Prompt construction unit tests |
| `system/tests/unit/meta-cognition-output.test.js` | new | Output validator unit tests |
| `system/tests/unit/meta-cognition-kind-filter.test.js` | new | `kindFilter` helper unit tests (string & array contracts) |
| `system/tests/unit/meta-cognition-migration.test.js` | new | Migration smoke test (table exists; runtime config seeded) |
| `system/tests/integration/meta-cognition-run.test.js` | new | Full job cycle: seed `recall_log` rows → run job → assert memo + candidates + telemetry |
| `system/tests/integration/meta-cognition-recall-surface.test.js` | new | After a run, intuition recall surfaces the `kind='reasoning'` memo |
| `system/tests/integration/meta-cognition-privacy.test.js` | new | Private-scope row drop (direct + transitive); fail mode aborts |
| `docs/faculties.md` | modify | New `### meta-cognition (cognition D2)` subsection under "Process faculties" |
| `docs/architecture.md` | modify | Add item 11 to "A typical agent turn"; new "Cognition D2" entry under the evolution layer |

---

## Phase 0 — Migration, registry, decay

### Task 0.1: Add `reasoning` half-life to `decay.js`

**Files:** `system/cognition/memory/decay.js`

- [ ] **Step 1: Write a failing test asserting `freshness({kind:'reasoning'})` decays on a 30d half-life.**

Create `system/tests/unit/meta-cognition-decay.test.js`:

```js
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { freshness, HALF_LIFE_BY_KIND_MS } from '../../cognition/memory/decay.js';

test('reasoning has 30d half-life', () => {
  assert.equal(HALF_LIFE_BY_KIND_MS.reasoning, 30 * 24 * 60 * 60 * 1000);
});

test('reasoning freshness halves at 30d', () => {
  const now = new Date('2026-05-11T18:00:00Z');
  const anchor = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  const memo = { kind: 'reasoning', confidence: 1, signal_count: 1, decay_anchor: anchor };
  const v = freshness(memo, { now });
  // 0.5 (decay) × 1.0 (confidence) × log2(2) = 0.5
  assert.ok(Math.abs(v - 0.5) < 1e-6, `expected ~0.5, got ${v}`);
});

test('supersededCount>0 zeroes reasoning freshness', () => {
  const now = new Date();
  const memo = { kind: 'reasoning', confidence: 1, decay_anchor: now };
  assert.equal(freshness(memo, { supersededCount: 1, now }), 0);
});
```

- [ ] **Step 2: Run the test — expect failure.**

```bash
npm run test:unit -- --test-name-pattern='reasoning has 30d half-life'
```

Expected: `not ok` because the entry is missing.

- [ ] **Step 3: Add the entry.**

Edit `system/cognition/memory/decay.js`. Inside the `HALF_LIFE_BY_KIND_MS` object literal, append after the existing entries:

```js
  reasoning: 30 * 24 * 60 * 60 * 1000, // 30d — weekly snapshot artefact (D2 spec §4)
```

- [ ] **Step 4: Re-run the test — expect pass.**

```bash
npm run test:unit -- --test-name-pattern='reasoning'
```

Expected: all three assertions pass.

- [ ] **Step 5: Lint.**

```bash
npm run lint
```

Expected: no errors.

- [ ] **Step 6: Commit.**

```bash
git add system/cognition/memory/decay.js system/tests/unit/meta-cognition-decay.test.js
git commit -m "feat(decay): add reasoning half-life (30d) for meta-cognition D2"
```

---

### Task 0.2: Extend `kind-registry.js` `reasoning.meta_schema`

**Files:** `system/cognition/memory/kind-registry.js`

- [ ] **Step 1: Write a failing test that `validateMemoKind('reasoning', ...)` accepts D2's meta keys.**

Create `system/tests/unit/meta-cognition-kind-registry.test.js`:

```js
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MEMO_KIND_REGISTRY, validateMemoKind } from '../../cognition/memory/kind-registry.js';

test('reasoning.meta_schema declares D2 keys', () => {
  const schema = MEMO_KIND_REGISTRY.reasoning?.meta_schema ?? {};
  assert.equal(schema.dimension, 'string?');
  assert.equal(schema.from_signal, 'string?');
  assert.equal(schema.period, 'string?');
  assert.equal(schema.signal_count, 'number?');
  assert.equal(schema.week_starting, 'string?');
  assert.equal(schema.clusters, 'number?');
  assert.equal(schema.recall_log_ids, 'array?');
});

test('validateMemoKind accepts a D2-shaped reasoning payload', () => {
  const payload = {
    content: 'Across this week, recall about photo-tools kept surfacing a stale memo …',
    derived_by: 'meta_cognition',
    meta: {
      dimension: 'recall_failures',
      from_signal: 'meta_cognition',
      period: 'weekly',
      signal_count: 7,
      week_starting: '2026-05-04',
      clusters: 2,
      recall_log_ids: ['recall_log:abc', 'recall_log:def'],
    },
  };
  const r = validateMemoKind('reasoning', payload);
  assert.equal(r.ok, true, JSON.stringify(r));
});

test('validateMemoKind rejects wrong meta type for D2 keys', () => {
  const bad = {
    content: 'x',
    derived_by: 'meta_cognition',
    meta: { signal_count: 'seven' }, // wrong type
  };
  const r = validateMemoKind('reasoning', bad);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes('signal_count')), JSON.stringify(r.errors));
});
```

- [ ] **Step 2: Run the test — expect failure.**

```bash
npm run test:unit -- --test-name-pattern='reasoning.meta_schema'
```

Expected: `not ok` — current registry only declares `session_id` and `step`.

- [ ] **Step 3: Extend the registry entry.**

Edit `system/cognition/memory/kind-registry.js`. Replace the existing `reasoning` block (currently lines 39–45):

```js
  reasoning: {
    required: ['content', 'derived_by'],
    meta_schema: {
      session_id: 'string?',
      step: 'string?',
    },
  },
```

with:

```js
  // Reserved `meta.dimension` values for `reasoning` memos:
  //   - 'recall_failures' — D2 meta-cognition (weekly recall-failure summaries).
  //   - 'calibration'     — D3 meta-cognition-calibration (post-revision).
  // New dimensions extend this comment; the field itself is open-enum.
  reasoning: {
    required: ['content', 'derived_by'],
    meta_schema: {
      // Legacy keys (pre-D2 producers may write these):
      session_id: 'string?',
      step: 'string?',
      // D2 producer:
      dimension: 'string?',
      from_signal: 'string?', // string for reasoning kind (D1's state_inference uses 'array?')
      period: 'string?',
      signal_count: 'number?',
      week_starting: 'string?',
      clusters: 'number?',
      recall_log_ids: 'array?',
    },
  },
```

- [ ] **Step 4: Re-run the tests — expect pass.**

```bash
npm run test:unit -- --test-name-pattern='reasoning.meta_schema|D2-shaped reasoning|wrong meta type for D2'
```

Expected: all three tests pass.

- [ ] **Step 5: Run lint.**

```bash
npm run lint
```

Expected: no errors.

- [ ] **Step 6: Commit.**

```bash
git add system/cognition/memory/kind-registry.js system/tests/unit/meta-cognition-kind-registry.test.js
git commit -m "feat(kind-registry): extend reasoning.meta_schema for D2 meta-cognition"
```

---

### Task 0.3: Migration `0018-meta-cognition.surql` (D2-initial-off)

**Files:** `system/data/db/migrations/0018-meta-cognition.surql` (new)

- [ ] **Step 1: Verify `0018` is free.**

```bash
ls system/data/db/migrations/
```

Expected: no `0018-*` file. If a sibling cognition spec has claimed `0018`, renumber the D2 trio (0018 initial-off, 0019 shadow-flip, 0021 default-on) to the next free triplet and update every reference in this plan and in the spec §13.1 allocation map in the same commit. The D2 migration is order-independent — it touches only `meta_cognition_telemetry` and the `runtime:\`meta_cognition.config\`` row.

- [ ] **Step 2: Write the migration file.**

Create `system/data/db/migrations/0018-meta-cognition.surql`:

```surql
-- ============================================================================
-- Cognition D2-initial-off: meta-cognition over recall failures (schema +
-- dark-launch). D2 reads `recall_log` and writes one `kind='reasoning'` memo
-- + 0-3 `rule_candidates` per weekly run.
--
-- Allocation map (verify against `system/data/db/migrations/` at land time):
--   0001..0008 — shipped (init, embeddings-{384,1024,3584}, evidence-ledger,
--                action-trust-ledger, cadence, compaction, arcs, doctor).
--   0009       — B1 per-hit-reinforcement.
--   0010       — A3 recall-eval-and-mmr.
--   0011       — C1 (recall-config consolidation).
--   0012/0013/0014 — D1 state-inference (initial-off / shadow / default-on).
--   0015/0016  — B2 conflict-surfacing (initial / default-on).
--   0017       — C3 telemetry-umbrella.
--   0018       — D2 meta-cognition (this migration; initial-off).
--   0019       — D2 shadow-flip (Phase 12, follow-up PR).
--   0020       — D3 meta-cognition-calibration (sibling).
--   0021       — D2 default-on (Phase 12, follow-up PR; gap reserved past D3).
-- ============================================================================

DEFINE TABLE meta_cognition_telemetry SCHEMAFULL TYPE NORMAL;
DEFINE FIELD ts                       ON meta_cognition_telemetry TYPE datetime DEFAULT time::now() READONLY;
DEFINE FIELD outcome                  ON meta_cognition_telemetry TYPE string;
  -- 'skipped_disabled' | 'skipped_below_threshold' | 'no_clusters'
  -- | 'shadow_complete' | 'complete' | 'llm_parse_error' | 'budget_exceeded'
  -- | 'error'
DEFINE FIELD corrected_count          ON meta_cognition_telemetry TYPE option<int>;
DEFINE FIELD unused_count             ON meta_cognition_telemetry TYPE option<int>;
DEFINE FIELD rows_after_privacy       ON meta_cognition_telemetry TYPE option<int>;
DEFINE FIELD dropped_private          ON meta_cognition_telemetry TYPE option<int>;
DEFINE FIELD clusters                 ON meta_cognition_telemetry TYPE option<int>;
DEFINE FIELD rules_proposed           ON meta_cognition_telemetry TYPE option<int>;
DEFINE FIELD rules_dropped_over_cap   ON meta_cognition_telemetry TYPE option<int>;
DEFINE FIELD tokens_in                ON meta_cognition_telemetry TYPE option<int>;
DEFINE FIELD tokens_out               ON meta_cognition_telemetry TYPE option<int>;
DEFINE FIELD duration_ms              ON meta_cognition_telemetry TYPE option<int>;
DEFINE FIELD week_starting            ON meta_cognition_telemetry TYPE option<string>;
DEFINE FIELD reasoning_memo_id        ON meta_cognition_telemetry TYPE option<record<memos>>;
DEFINE FIELD error                    ON meta_cognition_telemetry TYPE option<string>;
DEFINE INDEX mct_ts                   ON meta_cognition_telemetry FIELDS ts;

-- Seed config — ships disabled. Operator flips to 'shadow' then `true` via
-- the rollout migrations (0019, 0021) or via `UPDATE runtime:`meta_cognition.config``.
UPSERT runtime:`meta_cognition.config` SET value = {
  enabled: false,
  min_corrections_threshold: 5,
  lookback_days: 7,
  max_corrected_rows: 200,
  max_unused_rows: 200,
  top_k_clusters: 3,
  min_cluster_size: 2,
  unused_signal_weight: 0.33,
  tier: 'fast',
  max_tokens_in: 3000,
  max_tokens_out: 1200,
  max_rules_per_run: 3,
  weekly_token_budget: 6000,
  private_scope_action: 'drop',
  reasoning_memo_scope: 'global'
};
```

- [ ] **Step 3: Write a migration smoke test.**

Create `system/tests/unit/meta-cognition-migration.test.js`:

```js
import assert from 'node:assert/strict';
import { mkdirSync as __mk } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { writeConfig } from '../../config/paths.js';
import { close, connect } from '../../data/db/client.js';
import { runMigrations } from '../../data/db/migrate.js';

const HOME = join(tmpdir(), `robin-d2mig-${process.pid}-${Math.random().toString(36).slice(2)}`);
__mk(HOME, { recursive: true });
process.env.ROBIN_HOME = HOME;
await writeConfig({ embedder_profile: 'mxbai-1024' });

test('0018 migration seeds runtime:`meta_cognition.config` with defaults', async () => {
  const db = await connect({ engine: 'mem://' });
  try {
    await runMigrations(db, resolve(import.meta.dirname, '../../data/db/migrations'));
    const [rows] = await db
      .query('SELECT VALUE value FROM runtime:`meta_cognition.config`')
      .collect();
    const cfg = rows?.[0];
    assert.ok(cfg, 'expected runtime:meta_cognition.config row');
    assert.equal(cfg.enabled, false);
    assert.equal(cfg.min_corrections_threshold, 5);
    assert.equal(cfg.lookback_days, 7);
    assert.equal(cfg.max_corrected_rows, 200);
    assert.equal(cfg.max_unused_rows, 200);
    assert.equal(cfg.top_k_clusters, 3);
    assert.equal(cfg.min_cluster_size, 2);
    assert.ok(Math.abs(cfg.unused_signal_weight - 0.33) < 1e-9);
    assert.equal(cfg.tier, 'fast');
    assert.equal(cfg.max_tokens_in, 3000);
    assert.equal(cfg.max_tokens_out, 1200);
    assert.equal(cfg.max_rules_per_run, 3);
    assert.equal(cfg.weekly_token_budget, 6000);
    assert.equal(cfg.private_scope_action, 'drop');
    assert.equal(cfg.reasoning_memo_scope, 'global');
  } finally {
    await close(db);
  }
});

test('meta_cognition_telemetry table is queryable after migration', async () => {
  const db = await connect({ engine: 'mem://' });
  try {
    await runMigrations(db, resolve(import.meta.dirname, '../../data/db/migrations'));
    // SELECT against a missing table throws; LIMIT 0 keeps it free.
    await db.query('SELECT 1 FROM meta_cognition_telemetry LIMIT 0').collect();
  } finally {
    await close(db);
  }
});
```

- [ ] **Step 4: Run the migration test — expect pass.**

```bash
npm run test:unit -- --test-name-pattern='0018 migration|meta_cognition_telemetry table'
```

Expected: both tests pass.

- [ ] **Step 5: Commit.**

```bash
git add system/data/db/migrations/0018-meta-cognition.surql system/tests/unit/meta-cognition-migration.test.js
git commit -m "feat(schema): 0018 meta-cognition telemetry table + runtime config seed"
```

---

## Phase 1 — Pure clustering function

### Task 1.1: `clusterByAboutEndpoints` in `meta_cognition/cluster.js`

**Files:** `system/cognition/meta_cognition/cluster.js` (new), `system/tests/unit/meta-cognition-cluster.test.js` (new)

- [ ] **Step 1: Write failing unit tests for the pure clustering function.**

Create `system/tests/unit/meta-cognition-cluster.test.js`:

```js
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { clusterByAboutEndpoints } from '../../cognition/meta_cognition/cluster.js';

const CFG = {
  top_k_clusters: 3,
  min_cluster_size: 2,
  unused_signal_weight: 0.33,
};

/**
 * @returns hydrated input shape:
 *   {
 *     rows: [{ id, outcome, source, ranked_hits: [{ record: 'memos:x', kind: 'memo' }] }],
 *     aboutByMemoId: Map<string, string[]>,
 *     entityNameById: Map<string, string>,
 *   }
 */
function H(rows, about, names = {}) {
  return {
    rows,
    aboutByMemoId: new Map(Object.entries(about).map(([k, v]) => [k, v])),
    entityNameById: new Map(Object.entries(names)),
  };
}

test('empty input → no clusters', () => {
  const r = clusterByAboutEndpoints(H([], {}), CFG);
  assert.deepEqual(r, []);
});

test('no about edges → no clusters (caller handles surface fallback)', () => {
  const rows = [
    { id: 'recall_log:1', outcome: 'corrected', ranked_hits: [{ record: 'memos:a', kind: 'memo' }] },
    { id: 'recall_log:2', outcome: 'corrected', ranked_hits: [{ record: 'memos:b', kind: 'memo' }] },
  ];
  const r = clusterByAboutEndpoints(H(rows, {}), CFG);
  assert.deepEqual(r, []);
});

test('single dominant entity returns one cluster with summed score', () => {
  const rows = Array.from({ length: 5 }, (_, i) => ({
    id: `recall_log:${i + 1}`,
    outcome: 'corrected',
    ranked_hits: [{ record: 'memos:a', kind: 'memo' }],
  }));
  const about = { 'memos:a': ['entities:E1'] };
  const r = clusterByAboutEndpoints(H(rows, about, { 'entities:E1': 'photo-tools' }), CFG);
  assert.equal(r.length, 1);
  assert.equal(r[0].entity_id, 'entities:E1');
  assert.equal(r[0].entity_name, 'photo-tools');
  assert.ok(Math.abs(r[0].score - 5.0) < 1e-9);
  assert.equal(r[0].rows.length, 5);
});

test('top_k_clusters caps result at 3', () => {
  // 6 entities each touched by 3 corrected rows.
  const rows = [];
  const about = {};
  for (let e = 1; e <= 6; e++) {
    const memoId = `memos:m${e}`;
    about[memoId] = [`entities:E${e}`];
    for (let i = 0; i < 3; i++) {
      rows.push({
        id: `recall_log:${e}-${i}`,
        outcome: 'corrected',
        ranked_hits: [{ record: memoId, kind: 'memo' }],
      });
    }
  }
  const r = clusterByAboutEndpoints(H(rows, about), CFG);
  assert.equal(r.length, 3);
});

test('min_cluster_size filters out singletons', () => {
  const rows = [
    { id: 'recall_log:1', outcome: 'corrected', ranked_hits: [{ record: 'memos:a', kind: 'memo' }] },
    { id: 'recall_log:2', outcome: 'corrected', ranked_hits: [{ record: 'memos:b', kind: 'memo' }] },
    { id: 'recall_log:3', outcome: 'corrected', ranked_hits: [{ record: 'memos:a', kind: 'memo' }] },
  ];
  const about = { 'memos:a': ['entities:E1'], 'memos:b': ['entities:E2'] };
  const r = clusterByAboutEndpoints(H(rows, about), CFG);
  assert.equal(r.length, 1, 'only E1 has ≥2 rows');
  assert.equal(r[0].entity_id, 'entities:E1');
});

test('unused-signal weight downweights secondary rows', () => {
  // 4 corrected rows touching E_A; 6 unused-hit rows touching E_B.
  // weights: A = 4 × 1.0 = 4.0; B = 6 × 0.33 = 1.98.
  const rows = [
    ...Array.from({ length: 4 }, (_, i) => ({
      id: `recall_log:a${i}`,
      outcome: 'corrected',
      ranked_hits: [{ record: 'memos:a', kind: 'memo' }],
    })),
    ...Array.from({ length: 6 }, (_, i) => ({
      id: `recall_log:b${i}`,
      outcome: 'unused', // sentinel — secondary query rows carry outcome='unused'
      ranked_hits: [{ record: 'memos:b', kind: 'memo' }],
    })),
  ];
  const about = { 'memos:a': ['entities:E_A'], 'memos:b': ['entities:E_B'] };
  const r = clusterByAboutEndpoints(H(rows, about), CFG);
  assert.equal(r.length, 2);
  assert.equal(r[0].entity_id, 'entities:E_A', 'A ranks above B');
  assert.ok(Math.abs(r[0].score - 4.0) < 1e-9);
  assert.ok(Math.abs(r[1].score - 1.98) < 1e-9);
});

test('row touching multiple top entities lands in each cluster', () => {
  const rows = [
    { id: 'recall_log:1', outcome: 'corrected', ranked_hits: [{ record: 'memos:a', kind: 'memo' }] },
    { id: 'recall_log:2', outcome: 'corrected', ranked_hits: [{ record: 'memos:a', kind: 'memo' }] },
    { id: 'recall_log:3', outcome: 'corrected', ranked_hits: [{ record: 'memos:m', kind: 'memo' }] }, // m touches A AND B
    { id: 'recall_log:4', outcome: 'corrected', ranked_hits: [{ record: 'memos:b', kind: 'memo' }] },
    { id: 'recall_log:5', outcome: 'corrected', ranked_hits: [{ record: 'memos:b', kind: 'memo' }] },
  ];
  const about = {
    'memos:a': ['entities:E_A'],
    'memos:b': ['entities:E_B'],
    'memos:m': ['entities:E_A', 'entities:E_B'],
  };
  const r = clusterByAboutEndpoints(H(rows, about), CFG);
  const a = r.find((c) => c.entity_id === 'entities:E_A');
  const b = r.find((c) => c.entity_id === 'entities:E_B');
  assert.ok(a && b);
  assert.equal(a.rows.length, 3, 'A cluster: rows 1,2,3');
  assert.equal(b.rows.length, 3, 'B cluster: rows 3,4,5');
});

test('per-cluster row cap truncates to 10', () => {
  const rows = Array.from({ length: 20 }, (_, i) => ({
    id: `recall_log:${i}`,
    outcome: 'corrected',
    ranked_hits: [{ record: 'memos:a', kind: 'memo' }],
  }));
  const about = { 'memos:a': ['entities:E1'] };
  const r = clusterByAboutEndpoints(H(rows, about), CFG);
  assert.equal(r[0].rows.length, 10);
});

test('non-memo hits are skipped (events have no about edges)', () => {
  const rows = [
    {
      id: 'recall_log:1',
      outcome: 'corrected',
      ranked_hits: [
        { record: 'events:e1', kind: 'event' },
        { record: 'memos:a', kind: 'memo' },
      ],
    },
    { id: 'recall_log:2', outcome: 'corrected', ranked_hits: [{ record: 'memos:a', kind: 'memo' }] },
  ];
  const about = { 'memos:a': ['entities:E1'] };
  const r = clusterByAboutEndpoints(H(rows, about), CFG);
  assert.equal(r.length, 1);
  assert.equal(r[0].entity_id, 'entities:E1');
  assert.ok(Math.abs(r[0].score - 2.0) < 1e-9);
});
```

- [ ] **Step 2: Run the test — expect failure (module missing).**

```bash
npm run test:unit -- --test-name-pattern='clusterByAboutEndpoints|empty input|no about edges|single dominant'
```

Expected: module-not-found error.

- [ ] **Step 3: Write the cluster module.**

Create `system/cognition/meta_cognition/cluster.js`:

```js
// cluster.js — pure in-Node clustering for D2 meta-cognition.
// Spec §3.2. No DB imports; the orchestrator hydrates `aboutByMemoId` and
// `entityNameById` upstream and passes them in.

const SECONDARY_OUTCOME = 'unused'; // sentinel set by the orchestrator on
                                    // rows pulled from the unused-hits query.

/**
 * Cluster recall failures by shared `about` endpoints of their retrieved
 * memos. Returns up to `config.top_k_clusters` clusters, each with at least
 * `config.min_cluster_size` member rows.
 *
 * @param {{
 *   rows: Array<{
 *     id: string,
 *     outcome: 'corrected' | 'unused' | string,
 *     ranked_hits: Array<{ record: string, kind?: string }>,
 *     query?: string,
 *     ts?: any,
 *     meta?: any,
 *   }>,
 *   aboutByMemoId: Map<string, string[]>,   // memo id (stringified) → entity ids
 *   entityNameById?: Map<string, string>,   // optional; only used to label clusters
 * }} hydrated
 * @param {{
 *   top_k_clusters: number,
 *   min_cluster_size: number,
 *   unused_signal_weight: number,
 * }} config
 * @returns {Array<{
 *   entity_id: string,
 *   entity_name: string | null,
 *   score: number,
 *   rows: Array<object>,           // truncated to ≤ 10
 *   memo_ids: string[],            // dedup'd retrieved memo ids in this cluster
 * }>}
 */
export function clusterByAboutEndpoints(hydrated, config) {
  const { rows = [], aboutByMemoId, entityNameById } = hydrated ?? {};
  if (!rows.length) return [];

  // Pass 1: per-entity weighted score + member-row sets.
  const entityScore = new Map();
  const memberRowsByEntity = new Map();

  for (const row of rows) {
    const weight = row.outcome === SECONDARY_OUTCOME ? config.unused_signal_weight : 1.0;
    const touched = new Set();
    for (const hit of row.ranked_hits ?? []) {
      const recordStr = String(hit?.record ?? '');
      const isMemo = hit?.kind === 'memo' || recordStr.startsWith('memos:');
      if (!isMemo) continue;
      const entities = aboutByMemoId?.get(recordStr) ?? [];
      for (const eid of entities) touched.add(eid);
    }
    for (const eid of touched) {
      entityScore.set(eid, (entityScore.get(eid) ?? 0) + weight);
      if (!memberRowsByEntity.has(eid)) memberRowsByEntity.set(eid, []);
      memberRowsByEntity.get(eid).push(row);
    }
  }

  // Pass 2: sort, cap, min-size filter.
  const sorted = [...entityScore.entries()]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .slice(0, config.top_k_clusters);

  const clusters = [];
  for (const [entity_id, score] of sorted) {
    const member = memberRowsByEntity.get(entity_id) ?? [];
    if (member.length < config.min_cluster_size) continue;
    const memo_ids = dedupRetrievedMemoIds(member);
    clusters.push({
      entity_id,
      entity_name: entityNameById?.get(entity_id) ?? null,
      score,
      rows: member.slice(0, 10),
      memo_ids,
    });
  }
  return clusters;
}

function dedupRetrievedMemoIds(rows) {
  const seen = new Set();
  for (const row of rows) {
    for (const hit of row.ranked_hits ?? []) {
      const recordStr = String(hit?.record ?? '');
      const isMemo = hit?.kind === 'memo' || recordStr.startsWith('memos:');
      if (isMemo) seen.add(recordStr);
    }
  }
  return [...seen];
}
```

- [ ] **Step 4: Re-run the tests — expect pass.**

```bash
npm run test:unit -- --test-name-pattern='clusterByAboutEndpoints|empty input → no clusters|no about edges|single dominant entity|top_k_clusters caps|min_cluster_size filters|unused-signal weight|row touching multiple|per-cluster row cap|non-memo hits'
```

Expected: all 9 tests pass.

- [ ] **Step 5: Run lint.**

```bash
npm run lint
```

- [ ] **Step 6: Commit.**

```bash
git add system/cognition/meta_cognition/cluster.js system/tests/unit/meta-cognition-cluster.test.js
git commit -m "feat(meta-cognition): pure clustering by about-edge endpoints"
```

---

## Phase 2 — Multi-cluster prompt construction

### Task 2.1: `META_COGNITION_SYSTEM` + `buildUserPrompt` in `meta_cognition/prompt.js`

**Files:** `system/cognition/meta_cognition/prompt.js` (new), `system/tests/unit/meta-cognition-prompt.test.js` (new)

- [ ] **Step 1: Write failing unit tests for the prompt builder.**

Create `system/tests/unit/meta-cognition-prompt.test.js`:

```js
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  META_COGNITION_SYSTEM,
  buildUserPrompt,
} from '../../cognition/meta_cognition/prompt.js';

function memoById(map) {
  return new Map(Object.entries(map));
}

test('META_COGNITION_SYSTEM is a non-empty string with output-shape instructions', () => {
  assert.equal(typeof META_COGNITION_SYSTEM, 'string');
  assert.ok(META_COGNITION_SYSTEM.includes('error_pattern'));
  assert.ok(META_COGNITION_SYSTEM.includes('suggested_rules'));
  assert.ok(META_COGNITION_SYSTEM.includes('rule_confidence'));
  assert.ok(META_COGNITION_SYSTEM.includes('JSON'));
});

test('buildUserPrompt includes week_starting and counts header', () => {
  const meta = {
    week_starting: '2026-05-04',
    n_corrected: 7,
    n_unused: 2,
    top_k_clusters: 3,
  };
  const out = buildUserPrompt([], meta, {
    max_tokens_in: 3000,
    top_k_clusters: 3,
  }, { memoById: memoById({}) });
  assert.ok(out.text.includes('2026-05-04'));
  assert.ok(out.text.includes('7 corrected'));
  assert.ok(out.text.includes('2 unused-hit'));
  assert.equal(out.clusters_emitted, 0);
});

test('buildUserPrompt renders one cluster block per cluster with rows and memos', () => {
  const clusters = [
    {
      cluster_id: 'entities:E1',
      entity_id: 'entities:E1',
      entity_name: 'photo-tools',
      score: 5,
      rows: [
        {
          id: 'recall_log:r1',
          ts: '2026-05-05T10:00:00Z',
          query: 'what is photo-tools',
          ranked_hits: [{ record: 'memos:a', kind: 'memo' }],
        },
      ],
      memo_ids: ['memos:a'],
    },
  ];
  const memos = memoById({
    'memos:a': {
      kind: 'knowledge',
      derived_at: '2026-04-01T00:00:00Z',
      content: 'A different photography toolkit not related to photo-tools.',
    },
  });
  const out = buildUserPrompt(clusters, {
    week_starting: '2026-05-04',
    n_corrected: 1,
    n_unused: 0,
    top_k_clusters: 3,
  }, { max_tokens_in: 3000, top_k_clusters: 3 }, { memoById: memos });
  assert.equal(out.clusters_emitted, 1);
  assert.ok(out.text.includes('Cluster 1'));
  assert.ok(out.text.includes('photo-tools'));
  assert.ok(out.text.includes('score: 5'));
  assert.ok(out.text.includes('what is photo-tools'));
  assert.ok(out.text.includes('A different photography toolkit'));
});

test('buildUserPrompt renders surface fallback when entity_id is absent', () => {
  const clusters = [
    {
      cluster_id: 'surface:intuition',
      surface: 'intuition',
      score: 4,
      rows: [
        { id: 'recall_log:r1', ts: '2026-05-05', query: 'foo', ranked_hits: [{ record: 'memos:a', kind: 'memo' }] },
        { id: 'recall_log:r2', ts: '2026-05-06', query: 'bar', ranked_hits: [{ record: 'memos:a', kind: 'memo' }] },
      ],
      memo_ids: ['memos:a'],
    },
  ];
  const out = buildUserPrompt(clusters, {
    week_starting: '2026-05-04', n_corrected: 2, n_unused: 0, top_k_clusters: 3,
  }, { max_tokens_in: 3000, top_k_clusters: 3 }, { memoById: memoById({ 'memos:a': { kind: 'knowledge', content: 'x' } }) });
  assert.ok(out.text.includes('surface=intuition'));
});

test('buildUserPrompt truncates clusters that would overflow max_tokens_in', () => {
  const longContent = 'x'.repeat(20000);
  const clusters = [
    {
      cluster_id: 'entities:E1',
      entity_id: 'entities:E1',
      entity_name: 'E1',
      score: 5,
      rows: Array.from({ length: 10 }, (_, i) => ({
        id: `recall_log:${i}`,
        ts: '2026-05-05',
        query: longContent.slice(0, 200),
        ranked_hits: [{ record: 'memos:a', kind: 'memo' }],
      })),
      memo_ids: ['memos:a'],
    },
    {
      cluster_id: 'entities:E2',
      entity_id: 'entities:E2',
      entity_name: 'E2',
      score: 4,
      rows: Array.from({ length: 10 }, (_, i) => ({
        id: `recall_log:b${i}`,
        ts: '2026-05-05',
        query: longContent.slice(0, 200),
        ranked_hits: [{ record: 'memos:b', kind: 'memo' }],
      })),
      memo_ids: ['memos:b'],
    },
  ];
  const memos = memoById({
    'memos:a': { kind: 'knowledge', content: longContent },
    'memos:b': { kind: 'knowledge', content: longContent },
  });
  const out = buildUserPrompt(clusters, {
    week_starting: '2026-05-04', n_corrected: 20, n_unused: 0, top_k_clusters: 3,
  }, { max_tokens_in: 600, top_k_clusters: 3 }, { memoById: memos });
  assert.ok(out.dropped_clusters >= 1 || out.clusters_emitted <= 2);
  // At least the header is present.
  assert.ok(out.text.includes('2026-05-04'));
});
```

- [ ] **Step 2: Run the test — expect failure (module missing).**

```bash
npm run test:unit -- --test-name-pattern='META_COGNITION_SYSTEM|buildUserPrompt'
```

Expected: module-not-found error.

- [ ] **Step 3: Write the prompt module.**

Create `system/cognition/meta_cognition/prompt.js`:

```js
// prompt.js — system + user prompt construction for D2 meta-cognition.
// Spec §3.3. Token-budget enforcement is greedy: emit header → each cluster
// in score order. If adding a cluster would exceed `max_tokens_in`, first
// truncate that cluster's rows down to min_cluster_size (defaulted at 2);
// if still overflowing, drop the cluster. Return diagnostics so the
// orchestrator can record telemetry.

export const META_COGNITION_SYSTEM = `You analyze patterns in Robin's recall failures.

You will see clusters of recall events where Robin retrieved memos that led to a user correction (or surfaced memos the agent didn't use). Each cluster groups failure events by a shared topic (an entity Robin's memos are "about") or by surface (intuition vs MCP recall).

For each cluster, output:
- error_pattern: one sentence naming what Robin got wrong (not what the user said — what Robin's recall surfaced incorrectly).
- suggested_rules: 0–3 rule strings, second person, behavioral, one sentence each. Empty array if the cluster is too thin to support a confident rule.
- rule_confidence: number in [0,1] per rule (parallel array to suggested_rules; same length).

Output JSON only:
{
  "narrative": string,                  // 2-4 sentence summary across all clusters (becomes the reasoning memo body)
  "clusters": [
    {
      "cluster_id": string,             // echoes the input cluster identifier (entity_id or surface)
      "error_pattern": string,
      "suggested_rules": string[],
      "rule_confidence": number[]
    }
  ]
}

Rules:
- Be conservative. If a cluster has only 2-3 rows and the failures rhyme by coincidence, output suggested_rules: [].
- Distinguish "the memo content was wrong" (the underlying fact is stale) from "the memo was right but irrelevant" (recall surfaced it inappropriately) from "the agent acted on the right memo but in the wrong way" (this is upstream of recall — out of scope here).
- Rules should be actionable in recall ranking or in agent behavior. Avoid rules that require new infrastructure (e.g. "build a classifier").
- Never invent a cluster the input didn't contain.`;

/**
 * Rough token estimate: 4 chars ≈ 1 token. Conservative enough that token
 * accounting matches `host.invokeLLM`'s pricing model within ±15%.
 */
function approxTokens(s) {
  return Math.ceil((s?.length ?? 0) / 4);
}

/**
 * Build the user-prompt text plus diagnostics.
 *
 * @param {Array<object>} clusters    Output of `clusterByAboutEndpoints` OR a
 *                                    surface-grouped fallback (each cluster
 *                                    carries `cluster_id` and either
 *                                    `entity_id`+`entity_name` or `surface`).
 * @param {{ week_starting:string, n_corrected:number, n_unused:number, top_k_clusters:number }} meta
 * @param {{ max_tokens_in:number, top_k_clusters:number, min_cluster_size?:number }} config
 * @param {{ memoById: Map<string, { kind?:string, content?:string, derived_at?:any }> }} ctx
 * @returns {{ text:string, clusters_emitted:number, dropped_clusters:number }}
 */
export function buildUserPrompt(clusters, meta, config, ctx) {
  const memoById = ctx?.memoById ?? new Map();
  const minRows = config.min_cluster_size ?? 2;
  const budget = config.max_tokens_in;

  const header =
    `Week of ${meta.week_starting}. ${meta.n_corrected} corrected rows + ` +
    `${meta.n_unused} unused-hit rows in the trailing 7 days. ` +
    `${clusters.length} clusters below (top-${meta.top_k_clusters} by failure-weighted touch count).\n`;

  let buf = header;
  let emitted = 0;
  let dropped = 0;

  for (let i = 0; i < clusters.length; i++) {
    const cluster = clusters[i];
    let rows = cluster.rows ?? [];
    let block = renderCluster(cluster, rows, memoById, i + 1);
    if (approxTokens(buf + block) > budget) {
      // Try truncating rows down to minRows.
      while (rows.length > minRows && approxTokens(buf + (block = renderCluster(cluster, rows, memoById, i + 1))) > budget) {
        rows = rows.slice(0, rows.length - 1);
      }
      if (approxTokens(buf + block) > budget) {
        dropped += 1;
        continue;
      }
    }
    buf += block;
    emitted += 1;
  }

  return { text: buf, clusters_emitted: emitted, dropped_clusters: dropped };
}

function renderCluster(cluster, rows, memoById, n) {
  const label = cluster.entity_id
    ? (cluster.entity_name ?? cluster.entity_id)
    : `surface=${cluster.surface ?? 'unknown'}`;
  const rowsLines = rows
    .map((r) => {
      const tsStr = r.ts ? String(r.ts).slice(0, 19) : '';
      const q = String(r.query ?? '').slice(0, 120);
      const retrieved = (r.ranked_hits ?? [])
        .map((h) => String(h.record).slice(0, 30))
        .join(', ');
      return `  - ${tsStr} | query: "${q}" | retrieved: [${retrieved}]`;
    })
    .join('\n');
  const memoLines = (cluster.memo_ids ?? [])
    .slice(0, 5)
    .map((mid) => {
      const m = memoById.get(mid);
      if (!m) return `  - [memo ${mid}] <not hydrated>`;
      const kind = m.kind ?? 'unknown';
      const derived = m.derived_at ? String(m.derived_at).slice(0, 10) : '?';
      const snippet = String(m.content ?? '').slice(0, 200);
      return `  - [memo ${kind} ${derived}] ${snippet}`;
    })
    .join('\n');
  return (
    `\n---\nCluster ${n}: ${label} (score: ${cluster.score})\n` +
    `Rows in this cluster:\n${rowsLines}\n` +
    `Representative retrieved memos:\n${memoLines}\n`
  );
}
```

- [ ] **Step 4: Re-run the tests — expect pass.**

```bash
npm run test:unit -- --test-name-pattern='META_COGNITION_SYSTEM|buildUserPrompt'
```

Expected: all 5 tests pass.

- [ ] **Step 5: Run lint.**

```bash
npm run lint
```

- [ ] **Step 6: Commit.**

```bash
git add system/cognition/meta_cognition/prompt.js system/tests/unit/meta-cognition-prompt.test.js
git commit -m "feat(meta-cognition): system prompt + multi-cluster user prompt builder"
```

---

## Phase 3 — Output validator

### Task 3.1: `validateMetaCognitionOutput` in `meta_cognition/output.js`

**Files:** `system/cognition/meta_cognition/output.js` (new), `system/tests/unit/meta-cognition-output.test.js` (new)

- [ ] **Step 1: Write failing unit tests for the output validator.**

Create `system/tests/unit/meta-cognition-output.test.js`:

```js
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validateMetaCognitionOutput } from '../../cognition/meta_cognition/output.js';

const CFG = { max_rules_per_run: 3 };

test('valid output passes', () => {
  const r = validateMetaCognitionOutput({
    narrative: 'Across this week, recall about photo-tools surfaced a stale memo.',
    clusters: [
      {
        cluster_id: 'entities:E1',
        error_pattern: 'A stale memo about a different toolkit kept surfacing.',
        suggested_rules: ['When asked about photo-tools, do not cite memos older than 60 days.'],
        rule_confidence: [0.8],
      },
    ],
  }, CFG);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.parsed.clusters.length, 1);
});

test('missing narrative is rejected', () => {
  const r = validateMetaCognitionOutput({ clusters: [] }, CFG);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes('narrative')));
});

test('non-string narrative is rejected', () => {
  const r = validateMetaCognitionOutput({ narrative: 42, clusters: [] }, CFG);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes('narrative')));
});

test('clusters not array is rejected', () => {
  const r = validateMetaCognitionOutput({ narrative: 'x', clusters: 'oops' }, CFG);
  assert.equal(r.ok, false);
});

test('cluster missing fields is rejected', () => {
  const r = validateMetaCognitionOutput({
    narrative: 'x',
    clusters: [{ cluster_id: 'a' }],
  }, CFG);
  assert.equal(r.ok, false);
  assert.ok(r.errors.join(';').match(/error_pattern|suggested_rules|rule_confidence/));
});

test('mismatched rule_confidence length is rejected', () => {
  const r = validateMetaCognitionOutput({
    narrative: 'x',
    clusters: [
      {
        cluster_id: 'a',
        error_pattern: 'p',
        suggested_rules: ['r1', 'r2'],
        rule_confidence: [0.5],
      },
    ],
  }, CFG);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes('rule_confidence')));
});

test('confidence outside [0,1] is clamped (not rejected)', () => {
  const r = validateMetaCognitionOutput({
    narrative: 'x',
    clusters: [
      {
        cluster_id: 'a',
        error_pattern: 'p',
        suggested_rules: ['r1'],
        rule_confidence: [1.5],
      },
    ],
  }, CFG);
  assert.equal(r.ok, true);
  assert.equal(r.parsed.clusters[0].rule_confidence[0], 1);
});

test('empty suggested_rules is accepted (conservative cluster)', () => {
  const r = validateMetaCognitionOutput({
    narrative: 'Patterns are too thin for confident rules this week.',
    clusters: [
      {
        cluster_id: 'a',
        error_pattern: 'maybe x',
        suggested_rules: [],
        rule_confidence: [],
      },
    ],
  }, CFG);
  assert.equal(r.ok, true);
});

test('null/non-object input is rejected gracefully', () => {
  assert.equal(validateMetaCognitionOutput(null, CFG).ok, false);
  assert.equal(validateMetaCognitionOutput('not json', CFG).ok, false);
});
```

- [ ] **Step 2: Run the test — expect failure (module missing).**

```bash
npm run test:unit -- --test-name-pattern='validateMetaCognitionOutput|valid output passes|missing narrative'
```

Expected: module-not-found error.

- [ ] **Step 3: Write the output validator.**

Create `system/cognition/meta_cognition/output.js`:

```js
// output.js — validator for the LLM JSON response in D2.
// Spec §3.3. Returns { ok: true, parsed } on success (with values clamped /
// normalised in-place), or { ok: false, errors } on shape violations.
// Rule confidences outside [0,1] are clamped — the LLM occasionally returns
// 1.2 etc and rejecting the whole response loses a week's signal for no gain.

/**
 * @param {unknown} parsed   Already-JSON.parsed response from the LLM.
 * @param {{ max_rules_per_run:number }} _config (kept for forward compatibility)
 * @returns {{ ok:true, parsed: {
 *   narrative:string,
 *   clusters: Array<{
 *     cluster_id:string,
 *     error_pattern:string,
 *     suggested_rules:string[],
 *     rule_confidence:number[],
 *   }>
 * } } | { ok:false, errors:string[] }}
 */
export function validateMetaCognitionOutput(parsed, _config) {
  const errors = [];
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, errors: ['response not an object'] };
  }
  if (typeof parsed.narrative !== 'string' || parsed.narrative.length === 0) {
    errors.push('narrative missing or not a non-empty string');
  }
  if (!Array.isArray(parsed.clusters)) {
    errors.push('clusters must be an array');
  } else {
    parsed.clusters.forEach((c, i) => {
      if (!c || typeof c !== 'object') {
        errors.push(`clusters[${i}] not an object`);
        return;
      }
      if (typeof c.cluster_id !== 'string') errors.push(`clusters[${i}].cluster_id missing`);
      if (typeof c.error_pattern !== 'string') errors.push(`clusters[${i}].error_pattern missing`);
      if (!Array.isArray(c.suggested_rules)) errors.push(`clusters[${i}].suggested_rules must be array`);
      if (!Array.isArray(c.rule_confidence)) errors.push(`clusters[${i}].rule_confidence must be array`);
      if (Array.isArray(c.suggested_rules) && Array.isArray(c.rule_confidence)) {
        if (c.suggested_rules.length !== c.rule_confidence.length) {
          errors.push(
            `clusters[${i}].rule_confidence length (${c.rule_confidence.length}) != suggested_rules length (${c.suggested_rules.length})`,
          );
        } else {
          // Clamp confidences.
          c.rule_confidence = c.rule_confidence.map((v) => clamp01(Number(v)));
        }
        // Drop non-string rules silently? No — validator is structural; leave
        // type-coerce to the writer caller.
        c.suggested_rules = c.suggested_rules.map((s) => String(s ?? ''));
      }
    });
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, parsed };
}

function clamp01(n) {
  if (!Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}
```

- [ ] **Step 4: Re-run the tests — expect pass.**

```bash
npm run test:unit -- --test-name-pattern='validateMetaCognitionOutput|valid output passes|missing narrative|non-string narrative|clusters not array|cluster missing fields|mismatched rule_confidence|confidence outside|empty suggested_rules|null/non-object'
```

Expected: all 9 tests pass.

- [ ] **Step 5: Run lint.**

```bash
npm run lint
```

- [ ] **Step 6: Commit.**

```bash
git add system/cognition/meta_cognition/output.js system/tests/unit/meta-cognition-output.test.js
git commit -m "feat(meta-cognition): output JSON validator with confidence clamping"
```

---

## Phase 4 — `kindFilter` helper + array-kind ripple in `store.js`

### Task 4.1: Introduce `kindFilter` and refactor `_surfaceSearch` + `listMemos`

**Files:** `system/cognition/memory/store.js`, `system/tests/unit/meta-cognition-kind-filter.test.js` (new)

- [ ] **Step 1: Write failing tests for the array-kind contract.**

Create `system/tests/unit/meta-cognition-kind-filter.test.js`:

```js
import assert from 'node:assert/strict';
import { mkdirSync as __mk } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { writeConfig } from '../../config/paths.js';
import { close, connect } from '../../data/db/client.js';
import { runMigrations } from '../../data/db/migrate.js';
import { createStubEmbedder } from '../../data/embed/embedder.js';
import { note, listMemos, searchMemos } from '../../cognition/memory/store.js';

const HOME = join(tmpdir(), `robin-kf-${process.pid}-${Math.random().toString(36).slice(2)}`);
__mk(HOME, { recursive: true });
process.env.ROBIN_HOME = HOME;
await writeConfig({ embedder_profile: 'mxbai-1024' });

async function fresh() {
  const db = await connect({ engine: 'mem://' });
  await runMigrations(db, resolve(import.meta.dirname, '../../data/db/migrations'));
  return db;
}

test('listMemos: single-kind string filter still works (backward-compat)', async () => {
  const db = await fresh();
  const e = createStubEmbedder({ dimension: 1024 });
  await note(db, e, 'knowledge', { content: 'k1', derived_by: 'agent' });
  await note(db, e, 'reasoning', { content: 'r1', derived_by: 'meta_cognition' });
  const rows = await listMemos(db, { kind: 'knowledge', limit: 10 });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].kind, 'knowledge');
  await close(db);
});

test('listMemos: array-kind filter returns matching rows for both kinds', async () => {
  const db = await fresh();
  const e = createStubEmbedder({ dimension: 1024 });
  await note(db, e, 'knowledge', { content: 'k1', derived_by: 'agent' });
  await note(db, e, 'reasoning', { content: 'r1', derived_by: 'meta_cognition' });
  await note(db, e, 'habit', { content: 'h1', derived_by: 'dream', meta: { name: 'h1' } });
  const rows = await listMemos(db, { kind: ['knowledge', 'reasoning'], limit: 10 });
  assert.equal(rows.length, 2);
  const kinds = rows.map((r) => r.kind).sort();
  assert.deepEqual(kinds, ['knowledge', 'reasoning']);
  await close(db);
});

test('searchMemos: single-kind string filter still works', async () => {
  const db = await fresh();
  const e = createStubEmbedder({ dimension: 1024 });
  await note(db, e, 'knowledge', { content: 'photo-tools is a Next.js app', derived_by: 'agent' });
  await note(db, e, 'reasoning', { content: 'A weekly meta note about photo-tools', derived_by: 'meta_cognition' });
  const r = await searchMemos(db, e, 'photo-tools', { kind: 'knowledge', limit: 5 });
  const kinds = (r?.hits ?? []).map((h) => h.record.kind);
  assert.ok(kinds.length > 0);
  for (const k of kinds) assert.equal(k, 'knowledge');
  await close(db);
});

test('searchMemos: array-kind filter returns both kinds', async () => {
  const db = await fresh();
  const e = createStubEmbedder({ dimension: 1024 });
  await note(db, e, 'knowledge', { content: 'photo-tools is a Next.js app', derived_by: 'agent' });
  await note(db, e, 'reasoning', { content: 'photo-tools weekly meta note', derived_by: 'meta_cognition' });
  await note(db, e, 'habit', { content: 'photo-tools habit', derived_by: 'dream', meta: { name: 'h1' } });
  const r = await searchMemos(db, e, 'photo-tools', { kind: ['knowledge', 'reasoning'], limit: 5 });
  const kinds = new Set((r?.hits ?? []).map((h) => h.record.kind));
  assert.ok(kinds.has('knowledge') || kinds.has('reasoning'), 'at least one expected kind present');
  for (const k of kinds) assert.ok(['knowledge', 'reasoning'].includes(k), `unexpected kind: ${k}`);
  await close(db);
});
```

- [ ] **Step 2: Run the test — expect failures (array branch missing).**

```bash
npm run test:unit -- --test-name-pattern='listMemos: array-kind|searchMemos: array-kind'
```

Expected: array-kind tests fail because the current filter emits `kind = $kind` which doesn't match when `$kind` is an array.

- [ ] **Step 3: Add a `kindFilter` helper near the top of `store.js`.**

Edit `system/cognition/memory/store.js`. Locate the existing private helpers section (just above `_surfaceSearch` near the `HYBRID_DEFAULTS` block — structural anchor `const HYBRID_DEFAULTS = {`). Immediately **before** `const HYBRID_DEFAULTS`, insert:

```js
/**
 * Build a SurrealQL WHERE fragment for the memo `kind` filter.
 *
 * Accepts string OR array. Pushes the value into `bindings.kind` and returns
 * the WHERE fragment for callers to push into `filters`.
 *
 * Shared by `_surfaceSearch` (post-filter SELECT after kNN+BM25 fusion) and
 * `listMemos` (chronological list). The two were the only sites in this file
 * that filtered memos by `kind`; both must accept array-kind for the public
 * API contract to hold. (Cognition D2 spec §5.)
 */
function kindFilter(kind, bindings) {
  bindings.kind = kind;
  return Array.isArray(kind) ? 'kind IN $kind' : 'kind = $kind';
}
```

- [ ] **Step 4: Refactor `_surfaceSearch` to call `kindFilter`.**

In the same file, locate the existing block (around line 567 — structural anchor: the comment-less `if (surface === 'memos' && opts.kind) {` inside `_surfaceSearch`):

```js
  if (surface === 'memos' && opts.kind) {
    bindings.kind = opts.kind;
    filters.push('kind = $kind');
  }
```

Replace with:

```js
  if (surface === 'memos' && opts.kind) {
    filters.push(kindFilter(opts.kind, bindings));
  }
```

- [ ] **Step 5: Refactor `listMemos` to call `kindFilter`.**

In the same file, locate `listMemos` (structural anchor: `export async function listMemos(db, opts = {}) {`). The existing block:

```js
  if (kind) {
    filters.push('kind = $kind');
    bindings.kind = kind;
  }
```

Replace with:

```js
  if (kind) {
    filters.push(kindFilter(kind, bindings));
  }
```

- [ ] **Step 6: Re-run the kind-filter tests — expect pass.**

```bash
npm run test:unit -- --test-name-pattern='listMemos: single-kind|listMemos: array-kind|searchMemos: single-kind|searchMemos: array-kind'
```

Expected: all 4 tests pass.

- [ ] **Step 7: Run the full unit suite for regressions.**

```bash
npm run test:unit
```

Expected: clean. Investigate any unexpected red — existing callers of `searchMemos`/`listMemos` with string `kind` must not regress (the `kindFilter` helper preserves the string path).

- [ ] **Step 8: Run lint.**

```bash
npm run lint
```

- [ ] **Step 9: Commit.**

```bash
git add system/cognition/memory/store.js system/tests/unit/meta-cognition-kind-filter.test.js
git commit -m "feat(store): kindFilter helper — searchMemos/listMemos accept array kind"
```

---

## Phase 5 — Orchestrator (`meta-recall-narrative.js`)

The orchestrator lives at `system/cognition/jobs/internal/meta-recall-narrative.js` and is the file the internal-job runner imports. It performs the full pipeline end-to-end (no peer `run.js` shim): read config → gate → pull → privacy filter → hydrate → cluster (with surface fallback) → LLM → validate → write memo + rule_candidates → telemetry.

### Task 5.1: Orchestrator scaffold (config read + gate + telemetry helpers)

**Files:** `system/cognition/jobs/internal/meta-recall-narrative.js` (new, partial)

- [ ] **Step 1: Write failing integration tests for the config gate and skipped paths.**

Create `system/tests/integration/meta-cognition-run.test.js` with the first few cases (more will be added in 5.6):

```js
import assert from 'node:assert/strict';
import { mkdirSync as __mk } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { surql } from 'surrealdb';
import { writeConfig } from '../../config/paths.js';
import { close, connect } from '../../data/db/client.js';
import { runMigrations } from '../../data/db/migrate.js';
import { createStubEmbedder } from '../../data/embed/embedder.js';
import runMetaRecallNarrative from '../../cognition/jobs/internal/meta-recall-narrative.js';

const HOME = join(tmpdir(), `robin-d2-${process.pid}-${Math.random().toString(36).slice(2)}`);
__mk(HOME, { recursive: true });
process.env.ROBIN_HOME = HOME;
await writeConfig({ embedder_profile: 'mxbai-1024' });

async function fresh() {
  const db = await connect({ engine: 'mem://' });
  await runMigrations(db, resolve(import.meta.dirname, '../../data/db/migrations'));
  return db;
}

function fakeHost(returnContent) {
  let calls = 0;
  return {
    invokeLLM: async () => {
      calls += 1;
      return { content: returnContent, usage: { input_tokens: 100, output_tokens: 200 } };
    },
    get calls() { return calls; },
  };
}

async function seedCorrected(db, n, opts = {}) {
  for (let i = 0; i < n; i++) {
    await db.query(
      surql`CREATE recall_log CONTENT {
        ts: time::now() - duration::from::days(1),
        session_id: ${`s${i}`},
        query: ${`q${i}`},
        k: 5,
        ranked_hits: ${opts.hits ?? []},
        outcome: 'corrected',
      }`,
    ).collect();
  }
}

test('T1 — disabled flag short-circuits', async () => {
  const db = await fresh();
  const e = createStubEmbedder({ dimension: 1024 });
  await seedCorrected(db, 10);
  const result = await runMetaRecallNarrative({ db, embedder: e, host: fakeHost('{}') });
  const summary = JSON.parse(result);
  assert.equal(summary.ran, false);
  assert.equal(summary.reason, 'disabled');
  const [tel] = await db.query('SELECT outcome FROM meta_cognition_telemetry ORDER BY ts DESC LIMIT 1').collect();
  assert.equal(tel?.[0]?.outcome, 'skipped_disabled');
  await close(db);
});

test('T2 — below-threshold short-circuits even when enabled', async () => {
  const db = await fresh();
  const e = createStubEmbedder({ dimension: 1024 });
  await db.query("UPDATE runtime:`meta_cognition.config` SET value.enabled = true").collect();
  await seedCorrected(db, 3); // < default 5
  const result = await runMetaRecallNarrative({ db, embedder: e, host: fakeHost('{}') });
  const summary = JSON.parse(result);
  assert.equal(summary.ran, false);
  assert.equal(summary.reason, 'below_threshold');
  assert.equal(summary.corrected_count, 3);
  const [tel] = await db.query('SELECT outcome, corrected_count FROM meta_cognition_telemetry ORDER BY ts DESC LIMIT 1').collect();
  assert.equal(tel?.[0]?.outcome, 'skipped_below_threshold');
  assert.equal(tel?.[0]?.corrected_count, 3);
  await close(db);
});
```

- [ ] **Step 2: Run the test — expect failure (module missing).**

```bash
npm run test:integration -- --test-name-pattern='T1 — disabled|T2 — below-threshold'
```

Expected: module-not-found error.

- [ ] **Step 3: Write the orchestrator scaffold (config + gate + telemetry only).**

Create `system/cognition/jobs/internal/meta-recall-narrative.js`:

```js
// meta-recall-narrative.js — weekly internal job for D2 meta-cognition.
// Spec §1.4, §3. Pulls `recall_log` failures from the trailing 7 days,
// clusters them by shared `about` endpoints, calls one tier:'fast' LLM,
// writes a `kind='reasoning'` memo + 0-3 rule_candidates.
//
// Manifest: cognition/jobs/builtin/meta-recall-narrative.md
// Schedule: 0 5 * * 0 (Sunday 05:00 local time).

import { BoundQuery, RecordId, surql } from 'surrealdb';
import { createCandidate } from '../../dream/candidates.js';
import { clusterByAboutEndpoints } from '../../meta_cognition/cluster.js';
import { validateMetaCognitionOutput } from '../../meta_cognition/output.js';
import { META_COGNITION_SYSTEM, buildUserPrompt } from '../../meta_cognition/prompt.js';
import { note } from '../../memory/store.js';

const SECONDARY_OUTCOME = 'unused';

const DEFAULT_CFG = {
  enabled: false,
  min_corrections_threshold: 5,
  lookback_days: 7,
  max_corrected_rows: 200,
  max_unused_rows: 200,
  top_k_clusters: 3,
  min_cluster_size: 2,
  unused_signal_weight: 0.33,
  tier: 'fast',
  max_tokens_in: 3000,
  max_tokens_out: 1200,
  max_rules_per_run: 3,
  weekly_token_budget: 6000,
  private_scope_action: 'drop',
  reasoning_memo_scope: 'global',
};

export default async function runMetaRecallNarrative({ db, embedder, host }) {
  const startedAt = Date.now();
  const config = await readConfig(db);

  if (config.enabled === false) {
    await emitTelemetry(db, { outcome: 'skipped_disabled', duration_ms: Date.now() - startedAt });
    return JSON.stringify({ ran: false, reason: 'disabled' });
  }

  // §1.2 gate.
  const correctedCount = await countCorrectedInWindow(db, config.lookback_days);
  if (correctedCount < config.min_corrections_threshold) {
    await emitTelemetry(db, {
      outcome: 'skipped_below_threshold',
      corrected_count: correctedCount,
      duration_ms: Date.now() - startedAt,
    });
    return JSON.stringify({ ran: false, reason: 'below_threshold', corrected_count: correctedCount });
  }

  // The rest of the pipeline is wired in subsequent tasks.
  return JSON.stringify({ ran: false, reason: 'not_yet_implemented' });
}

async function readConfig(db) {
  try {
    const [rows] = await db
      .query('SELECT VALUE value FROM runtime:`meta_cognition.config`')
      .collect();
    const v = rows?.[0] ?? {};
    return { ...DEFAULT_CFG, ...v };
  } catch {
    return { ...DEFAULT_CFG };
  }
}

async function countCorrectedInWindow(db, lookbackDays) {
  const [rows] = await db
    .query(
      `SELECT count() AS n FROM recall_log
        WHERE outcome = 'corrected'
          AND ts > time::now() - duration::from::days($d)
        GROUP ALL`,
      { d: lookbackDays },
    )
    .collect();
  return rows?.[0]?.n ?? 0;
}

async function emitTelemetry(db, fields) {
  try {
    await db.query(surql`CREATE meta_cognition_telemetry CONTENT ${fields}`).collect();
  } catch {
    // Best-effort — telemetry must not break the job.
  }
}
```

- [ ] **Step 4: Re-run the integration tests — expect pass for T1, T2.**

```bash
npm run test:integration -- --test-name-pattern='T1 — disabled|T2 — below-threshold'
```

Expected: both pass.

- [ ] **Step 5: Run lint.**

```bash
npm run lint
```

- [ ] **Step 6: Commit.**

```bash
git add system/cognition/jobs/internal/meta-recall-narrative.js system/tests/integration/meta-cognition-run.test.js
git commit -m "feat(meta-cognition): orchestrator scaffold — config + threshold gate + telemetry"
```

---

### Task 5.2: Pull corrected + unused rows; merge & dedup

**Files:** `system/cognition/jobs/internal/meta-recall-narrative.js`, `system/tests/integration/meta-cognition-run.test.js`

- [ ] **Step 1: Append a failing test for input-row gathering.**

Append to `system/tests/integration/meta-cognition-run.test.js`:

```js
test('T3 — corrected rows fetched within lookback_days', async () => {
  const db = await fresh();
  const e = createStubEmbedder({ dimension: 1024 });
  await db.query("UPDATE runtime:`meta_cognition.config` SET value.enabled = true").collect();
  // 5 within the window.
  await seedCorrected(db, 5);
  // 2 outside the window (8 days ago).
  for (let i = 0; i < 2; i++) {
    await db.query(
      surql`CREATE recall_log CONTENT {
        ts: time::now() - duration::from::days(8),
        session_id: ${`old${i}`},
        query: ${`oq${i}`},
        k: 5,
        ranked_hits: [],
        outcome: 'corrected',
      }`,
    ).collect();
  }
  const result = await runMetaRecallNarrative({ db, embedder: e, host: fakeHost('{}') });
  const summary = JSON.parse(result);
  // No clusters because seedCorrected uses empty ranked_hits.
  assert.equal(summary.reason, 'no_clusters');
  const [tel] = await db.query('SELECT outcome, corrected_count, rows_after_privacy FROM meta_cognition_telemetry ORDER BY ts DESC LIMIT 1').collect();
  assert.equal(tel?.[0]?.outcome, 'no_clusters');
  // corrected_count from gate (5 within 7d), rows_after_privacy ≤ 5.
  assert.equal(tel?.[0]?.corrected_count, 5);
  assert.ok((tel?.[0]?.rows_after_privacy ?? 0) <= 5);
  await close(db);
});
```

- [ ] **Step 2: Run the test — expect failure (`reason: 'not_yet_implemented'`).**

```bash
npm run test:integration -- --test-name-pattern='T3 — corrected rows fetched'
```

Expected: assertion failure on `summary.reason`.

- [ ] **Step 3: Extend the orchestrator.**

Edit `system/cognition/jobs/internal/meta-recall-narrative.js`. Replace the body after the gate (the line `// The rest of the pipeline is wired in subsequent tasks.` plus the `return` after it) with:

```js
  // §3.1 input gathering.
  const correctedRows = await selectCorrectedRows(db, config);
  const unusedRows = await selectUnusedRows(db, config);
  const inputRows = mergeAndDedupRows(correctedRows, unusedRows);

  // Privacy filter wired in Task 5.3 — for now, pass-through.
  const cleanRows = inputRows;
  const droppedPrivate = 0;

  if (cleanRows.length === 0) {
    await emitTelemetry(db, {
      outcome: 'no_clusters',
      corrected_count: correctedCount,
      unused_count: unusedRows.length,
      rows_after_privacy: 0,
      dropped_private: droppedPrivate,
      duration_ms: Date.now() - startedAt,
    });
    return JSON.stringify({ ran: false, reason: 'no_clusters' });
  }

  // Hydration + clustering + LLM + writes wired in Tasks 5.4–5.5.
  await emitTelemetry(db, {
    outcome: 'no_clusters',
    corrected_count: correctedCount,
    unused_count: unusedRows.length,
    rows_after_privacy: cleanRows.length,
    dropped_private: droppedPrivate,
    duration_ms: Date.now() - startedAt,
  });
  return JSON.stringify({ ran: false, reason: 'no_clusters' });
```

Then add these helpers at the bottom of the file (before the final closing of the module — append at end of file):

```js
async function selectCorrectedRows(db, config) {
  const [rows] = await db
    .query(
      `SELECT id, ts, session_id, query, ranked_hits, attribution, meta
       FROM recall_log
       WHERE outcome = 'corrected'
         AND ts > time::now() - duration::from::days($d)
       ORDER BY ts DESC
       LIMIT $cap`,
      { d: config.lookback_days, cap: config.max_corrected_rows },
    )
    .collect();
  return (rows ?? []).map((r) => ({ ...r, outcome: 'corrected' }));
}

async function selectUnusedRows(db, config) {
  // `ranked_hits[*].used CONTAINS false` only matches when B1 has populated
  // the `used` field. Pre-B1 the projection yields an empty list and the
  // CONTAINS is false — secondary query is empty by construction.
  try {
    const [rows] = await db
      .query(
        `SELECT id, ts, session_id, query, ranked_hits, attribution, meta
         FROM recall_log
         WHERE ts > time::now() - duration::from::days($d)
           AND attribution.mode != 'corrected'
           AND attribution.mode != 'off'
           AND ranked_hits[*].used CONTAINS false
         ORDER BY ts DESC
         LIMIT $cap`,
        { d: config.lookback_days, cap: config.max_unused_rows },
      )
      .collect();
    return (rows ?? []).map((r) => ({ ...r, outcome: SECONDARY_OUTCOME }));
  } catch {
    // Older engine without array projection — return empty. D2 still runs
    // on corrected-only signal.
    return [];
  }
}

function mergeAndDedupRows(corrected, unused) {
  // Corrected wins on dedup so weight stays at 1.0.
  const byId = new Map();
  for (const r of corrected) byId.set(String(r.id), r);
  for (const r of unused) if (!byId.has(String(r.id))) byId.set(String(r.id), r);
  return [...byId.values()];
}
```

- [ ] **Step 4: Re-run the test — expect pass.**

```bash
npm run test:integration -- --test-name-pattern='T3 — corrected rows fetched'
```

Expected: pass.

- [ ] **Step 5: Run lint + commit.**

```bash
npm run lint
git add system/cognition/jobs/internal/meta-recall-narrative.js system/tests/integration/meta-cognition-run.test.js
git commit -m "feat(meta-cognition): input row gathering (corrected + unused) with dedup"
```

---

### Task 5.3: Privacy filter (direct + transitive)

**Files:** `system/cognition/jobs/internal/meta-recall-narrative.js`, `system/tests/integration/meta-cognition-privacy.test.js` (new)

- [ ] **Step 1: Write failing privacy tests.**

Create `system/tests/integration/meta-cognition-privacy.test.js`:

```js
import assert from 'node:assert/strict';
import { mkdirSync as __mk } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { surql } from 'surrealdb';
import { writeConfig } from '../../config/paths.js';
import { close, connect } from '../../data/db/client.js';
import { runMigrations } from '../../data/db/migrate.js';
import { createStubEmbedder } from '../../data/embed/embedder.js';
import { note } from '../../cognition/memory/store.js';
import runMetaRecallNarrative from '../../cognition/jobs/internal/meta-recall-narrative.js';

const HOME = join(tmpdir(), `robin-d2priv-${process.pid}-${Math.random().toString(36).slice(2)}`);
__mk(HOME, { recursive: true });
process.env.ROBIN_HOME = HOME;
await writeConfig({ embedder_profile: 'mxbai-1024' });

async function fresh() {
  const db = await connect({ engine: 'mem://' });
  await runMigrations(db, resolve(import.meta.dirname, '../../data/db/migrations'));
  return db;
}

function fakeHost() {
  return { invokeLLM: async () => ({ content: '{}', usage: { input_tokens: 0, output_tokens: 0 } }), calls: 0 };
}

async function seedRowWithHit(db, memoId) {
  await db.query(
    surql`CREATE recall_log CONTENT {
      ts: time::now() - duration::from::days(1),
      session_id: 's',
      query: 'q',
      k: 5,
      ranked_hits: [{ record: ${memoId}, kind: 'memo' }],
      outcome: 'corrected',
    }`,
  ).collect();
}

test('P1 — row whose hit is a private-scope memo is dropped', async () => {
  const db = await fresh();
  const e = createStubEmbedder({ dimension: 1024 });
  await db.query("UPDATE runtime:`meta_cognition.config` SET value.enabled = true").collect();

  // 4 non-private rows + 1 private = 5 corrected (gate passes).
  const m1 = await note(db, e, 'knowledge', { content: 'k1', derived_by: 'agent', scope: 'global' });
  const mp = await note(db, e, 'knowledge', { content: 'private secret', derived_by: 'agent', scope: 'private' });
  for (let i = 0; i < 4; i++) await seedRowWithHit(db, m1.id);
  await seedRowWithHit(db, mp.id);

  const result = await runMetaRecallNarrative({ db, embedder: e, host: fakeHost() });
  const summary = JSON.parse(result);
  const [tel] = await db.query('SELECT outcome, rows_after_privacy, dropped_private FROM meta_cognition_telemetry ORDER BY ts DESC LIMIT 1').collect();
  assert.equal(tel?.[0]?.dropped_private, 1, 'one row should be dropped');
  assert.equal(tel?.[0]?.rows_after_privacy, 4, 'four rows survive');
  await close(db);
});

test('P2 — row whose hit memo is derived_from a private memo is dropped (transitive)', async () => {
  const db = await fresh();
  const e = createStubEmbedder({ dimension: 1024 });
  await db.query("UPDATE runtime:`meta_cognition.config` SET value.enabled = true").collect();

  const mPriv = await note(db, e, 'knowledge', { content: 'private', derived_by: 'agent', scope: 'private' });
  const mDerived = await note(db, e, 'knowledge', { content: 'derived', derived_by: 'agent', scope: 'global', lineage: [mPriv.id] });
  const mClean = await note(db, e, 'knowledge', { content: 'clean', derived_by: 'agent', scope: 'global' });

  // 4 clean rows + 1 transitively-private row = 5 corrected.
  for (let i = 0; i < 4; i++) await seedRowWithHit(db, mClean.id);
  await seedRowWithHit(db, mDerived.id);

  await runMetaRecallNarrative({ db, embedder: e, host: fakeHost() });
  const [tel] = await db.query('SELECT dropped_private, rows_after_privacy FROM meta_cognition_telemetry ORDER BY ts DESC LIMIT 1').collect();
  assert.equal(tel?.[0]?.dropped_private, 1);
  assert.equal(tel?.[0]?.rows_after_privacy, 4);
  await close(db);
});

test('P3 — private_scope_action=fail aborts the run', async () => {
  const db = await fresh();
  const e = createStubEmbedder({ dimension: 1024 });
  await db.query("UPDATE runtime:`meta_cognition.config` SET value.enabled = true, value.private_scope_action = 'fail'").collect();

  const m1 = await note(db, e, 'knowledge', { content: 'k1', derived_by: 'agent', scope: 'global' });
  const mp = await note(db, e, 'knowledge', { content: 'private', derived_by: 'agent', scope: 'private' });
  for (let i = 0; i < 4; i++) await seedRowWithHit(db, m1.id);
  await seedRowWithHit(db, mp.id);

  const result = await runMetaRecallNarrative({ db, embedder: e, host: fakeHost() });
  const summary = JSON.parse(result);
  assert.equal(summary.ran, false);
  assert.equal(summary.reason, 'private_scope_contamination');
  const [tel] = await db.query('SELECT outcome, error FROM meta_cognition_telemetry ORDER BY ts DESC LIMIT 1').collect();
  assert.equal(tel?.[0]?.outcome, 'error');
  assert.equal(tel?.[0]?.error, 'private_scope_contamination');
  await close(db);
});
```

- [ ] **Step 2: Run the test — expect failure.**

```bash
npm run test:integration -- --test-name-pattern='P1 —|P2 —|P3 —'
```

Expected: all three fail (privacy filter not implemented).

- [ ] **Step 3: Wire the privacy filter into the orchestrator.**

Edit `system/cognition/jobs/internal/meta-recall-narrative.js`. Find the line:

```js
  // Privacy filter wired in Task 5.3 — for now, pass-through.
  const cleanRows = inputRows;
  const droppedPrivate = 0;
```

Replace with:

```js
  // §3.1 / §7 privacy filter — direct + one-hop transitive.
  let cleanRows;
  let droppedPrivate;
  try {
    const filtered = await filterPrivateScopeRows(db, inputRows);
    cleanRows = filtered.cleanRows;
    droppedPrivate = filtered.dropped;
    if (droppedPrivate > 0 && config.private_scope_action === 'fail') {
      await emitTelemetry(db, {
        outcome: 'error',
        corrected_count: correctedCount,
        unused_count: unusedRows.length,
        rows_after_privacy: cleanRows.length,
        dropped_private: droppedPrivate,
        error: 'private_scope_contamination',
        duration_ms: Date.now() - startedAt,
      });
      return JSON.stringify({ ran: false, reason: 'private_scope_contamination' });
    }
  } catch (err) {
    await emitTelemetry(db, {
      outcome: 'error',
      corrected_count: correctedCount,
      unused_count: unusedRows.length,
      error: String(err?.message ?? err),
      duration_ms: Date.now() - startedAt,
    });
    return JSON.stringify({ ran: false, reason: 'privacy_filter_error' });
  }
```

Then append at the bottom of the file:

```js
async function filterPrivateScopeRows(db, rows) {
  if (rows.length === 0) return { cleanRows: [], dropped: 0 };

  // Gather all memo ids referenced by ranked_hits.
  const allMemoIds = new Set();
  for (const row of rows) {
    for (const hit of row.ranked_hits ?? []) {
      const ref = String(hit?.record ?? '');
      if (ref.startsWith('memos:')) allMemoIds.add(ref);
    }
  }
  if (allMemoIds.size === 0) return { cleanRows: rows, dropped: 0 };

  const memoIdList = [...allMemoIds].map((s) => {
    const [tbl, key] = s.split(':');
    return new RecordId(tbl, key);
  });

  // Direct private-scope memos.
  const [direct] = await db
    .query(new BoundQuery('SELECT id FROM memos WHERE id IN $ids AND scope = "private"', { ids: memoIdList }))
    .collect();
  const blockedDirect = new Set((direct ?? []).map((r) => String(r.id)));

  // Transitive: memos whose `->derived_from->memos[WHERE scope='private']` is non-empty.
  let blockedTransitive = new Set();
  try {
    const [trans] = await db
      .query(
        new BoundQuery(
          `SELECT id FROM memos
            WHERE id IN $ids
              AND count(->derived_from->memos[WHERE scope = 'private']) > 0`,
          { ids: memoIdList },
        ),
      )
      .collect();
    blockedTransitive = new Set((trans ?? []).map((r) => String(r.id)));
  } catch {
    // Older engine without arrow traversal — fall back to direct only.
  }

  const allBlocked = new Set([...blockedDirect, ...blockedTransitive]);
  if (allBlocked.size === 0) return { cleanRows: rows, dropped: 0 };

  const cleanRows = [];
  let dropped = 0;
  for (const row of rows) {
    const refs = (row.ranked_hits ?? [])
      .map((h) => String(h?.record ?? ''))
      .filter((ref) => ref.startsWith('memos:'));
    const isBlocked = refs.some((ref) => allBlocked.has(ref));
    if (isBlocked) {
      dropped += 1;
    } else {
      cleanRows.push(row);
    }
  }
  return { cleanRows, dropped };
}
```

- [ ] **Step 4: Re-run the tests — expect pass for P1, P2, P3.**

```bash
npm run test:integration -- --test-name-pattern='P1 —|P2 —|P3 —'
```

Expected: all three pass.

- [ ] **Step 5: Run lint + commit.**

```bash
npm run lint
git add system/cognition/jobs/internal/meta-recall-narrative.js system/tests/integration/meta-cognition-privacy.test.js
git commit -m "feat(meta-cognition): privacy filter (direct + transitive) with drop/fail modes"
```

---

### Task 5.4: Hydrate retrieved memos + about-edges + entity names; cluster

**Files:** `system/cognition/jobs/internal/meta-recall-narrative.js`, `system/tests/integration/meta-cognition-run.test.js`

- [ ] **Step 1: Append a failing test for cluster + shadow short-circuit.**

Append to `system/tests/integration/meta-cognition-run.test.js`:

```js
test('T4 — shadow mode: clusters formed, no LLM call, no memo write', async () => {
  const db = await fresh();
  const e = createStubEmbedder({ dimension: 1024 });
  const { note } = await import('../../cognition/memory/store.js');
  const ent = await db.query(surql`CREATE entities CONTENT { name: 'photo-tools', type: 'project', scope: 'global' }`).collect();
  const entityId = ent[0][0].id;

  // 5 memos all "about" the same entity.
  const memos = [];
  for (let i = 0; i < 5; i++) {
    const m = await note(db, e, 'knowledge', {
      content: `mem ${i}`,
      derived_by: 'agent',
      scope: 'global',
      subjects: [entityId],
    });
    memos.push(m.id);
  }
  // 5 corrected recall_log rows each hitting one of the memos.
  for (let i = 0; i < 5; i++) {
    await db.query(
      surql`CREATE recall_log CONTENT {
        ts: time::now() - duration::from::days(1),
        session_id: ${`s${i}`},
        query: ${`q${i}`},
        k: 5,
        ranked_hits: [{ record: ${memos[i]}, kind: 'memo' }],
        outcome: 'corrected',
      }`,
    ).collect();
  }
  await db.query("UPDATE runtime:`meta_cognition.config` SET value.enabled = 'shadow'").collect();

  const host = fakeHost('{}');
  const result = await runMetaRecallNarrative({ db, embedder: e, host });
  const summary = JSON.parse(result);
  assert.equal(summary.ran, false);
  assert.equal(summary.reason, 'shadow_mode');
  assert.ok(summary.cluster_count >= 1);
  assert.equal(host.calls, 0, 'shadow mode must not call the LLM');
  const [memoRows] = await db.query("SELECT count() AS n FROM memos WHERE kind = 'reasoning' GROUP ALL").collect();
  assert.equal(memoRows?.[0]?.n ?? 0, 0);
  const [tel] = await db.query('SELECT outcome, clusters FROM meta_cognition_telemetry ORDER BY ts DESC LIMIT 1').collect();
  assert.equal(tel?.[0]?.outcome, 'shadow_complete');
  assert.ok(tel?.[0]?.clusters >= 1);
  await close(db);
});
```

- [ ] **Step 2: Run the test — expect failure.**

```bash
npm run test:integration -- --test-name-pattern='T4 — shadow mode'
```

Expected: fail.

- [ ] **Step 3: Wire hydration + clustering + shadow short-circuit.**

Edit `system/cognition/jobs/internal/meta-recall-narrative.js`. Locate the placeholder block at the end of the orchestrator body:

```js
  // Hydration + clustering + LLM + writes wired in Tasks 5.4–5.5.
  await emitTelemetry(db, {
    outcome: 'no_clusters',
    corrected_count: correctedCount,
    unused_count: unusedRows.length,
    rows_after_privacy: cleanRows.length,
    dropped_private: droppedPrivate,
    duration_ms: Date.now() - startedAt,
  });
  return JSON.stringify({ ran: false, reason: 'no_clusters' });
```

Replace with:

```js
  // §3.1c hydration.
  const hydrated = await hydrateRetrievedMemos(db, cleanRows);

  // §3.2 clustering with surface fallback.
  let clusters = clusterByAboutEndpoints(hydrated, config);
  if (clusters.length === 0) {
    clusters = surfaceFallbackClusters(cleanRows, config);
  }

  if (clusters.length === 0) {
    await emitTelemetry(db, {
      outcome: 'no_clusters',
      corrected_count: correctedCount,
      unused_count: unusedRows.length,
      rows_after_privacy: cleanRows.length,
      dropped_private: droppedPrivate,
      duration_ms: Date.now() - startedAt,
    });
    return JSON.stringify({ ran: false, reason: 'no_clusters' });
  }

  if (config.enabled === 'shadow') {
    await emitTelemetry(db, {
      outcome: 'shadow_complete',
      corrected_count: correctedCount,
      unused_count: unusedRows.length,
      rows_after_privacy: cleanRows.length,
      dropped_private: droppedPrivate,
      clusters: clusters.length,
      duration_ms: Date.now() - startedAt,
    });
    return JSON.stringify({ ran: false, reason: 'shadow_mode', cluster_count: clusters.length });
  }

  // §3.3 LLM + §3.4 writes wired in Task 5.5.
  await emitTelemetry(db, {
    outcome: 'shadow_complete', // placeholder until 5.5 lands
    corrected_count: correctedCount,
    unused_count: unusedRows.length,
    rows_after_privacy: cleanRows.length,
    dropped_private: droppedPrivate,
    clusters: clusters.length,
    duration_ms: Date.now() - startedAt,
  });
  return JSON.stringify({ ran: false, reason: 'shadow_mode', cluster_count: clusters.length });
```

Then append at the bottom of the file:

```js
async function hydrateRetrievedMemos(db, rows) {
  const memoIds = new Set();
  for (const row of rows) {
    for (const hit of row.ranked_hits ?? []) {
      const ref = String(hit?.record ?? '');
      if (ref.startsWith('memos:')) memoIds.add(ref);
    }
  }
  const memoIdList = [...memoIds].map((s) => {
    const [tbl, key] = s.split(':');
    return new RecordId(tbl, key);
  });

  if (memoIdList.length === 0) {
    return { rows, aboutByMemoId: new Map(), entityNameById: new Map(), memoById: new Map() };
  }

  // Memo content + meta.
  const [memoRows] = await db
    .query(new BoundQuery('SELECT id, content, kind, scope, meta, derived_at FROM memos WHERE id IN $ids', { ids: memoIdList }))
    .collect();
  const memoById = new Map((memoRows ?? []).map((m) => [String(m.id), m]));

  // about-edges: edges where kind='about' and in IN memoIds.
  const [edgeRows] = await db
    .query(new BoundQuery("SELECT in, out FROM edges WHERE kind = 'about' AND in IN $ids", { ids: memoIdList }))
    .collect();
  const aboutByMemoId = new Map();
  for (const e of edgeRows ?? []) {
    const key = String(e.in);
    if (!aboutByMemoId.has(key)) aboutByMemoId.set(key, []);
    aboutByMemoId.get(key).push(String(e.out));
  }

  // Entity names for cluster labelling — only for the entities actually touched.
  const entityIds = [...new Set([...aboutByMemoId.values()].flat())];
  const entityRefs = entityIds.map((s) => {
    const [tbl, key] = s.split(':');
    return new RecordId(tbl, key);
  });
  let entityNameById = new Map();
  if (entityRefs.length > 0) {
    const [entRows] = await db
      .query(new BoundQuery('SELECT id, name FROM entities WHERE id IN $ids', { ids: entityRefs }))
      .collect();
    entityNameById = new Map((entRows ?? []).map((r) => [String(r.id), r.name]));
  }

  return { rows, aboutByMemoId, entityNameById, memoById };
}

function surfaceFallbackClusters(rows, config) {
  // Group by row.meta?.from (intuition vs mcp_recall vs unknown). Each
  // resulting "cluster" carries `surface` instead of `entity_id` so the
  // prompt builder phrases the question correctly.
  const bySurface = new Map();
  for (const row of rows) {
    const surface = row.meta?.from ?? 'unknown';
    if (!bySurface.has(surface)) bySurface.set(surface, []);
    bySurface.get(surface).push(row);
  }
  const out = [];
  for (const [surface, member] of bySurface.entries()) {
    if (member.length < config.min_cluster_size) continue;
    out.push({
      cluster_id: `surface:${surface}`,
      surface,
      score: member.length,
      rows: member.slice(0, 10),
      memo_ids: [...new Set(
        member.flatMap((r) =>
          (r.ranked_hits ?? [])
            .map((h) => String(h?.record ?? ''))
            .filter((ref) => ref.startsWith('memos:')),
        ),
      )],
    });
  }
  return out.slice(0, config.top_k_clusters);
}
```

Also extend the `clusterByAboutEndpoints` invocation to set `cluster_id` on each entity cluster. Replace the call:

```js
  let clusters = clusterByAboutEndpoints(hydrated, config);
```

with:

```js
  let clusters = clusterByAboutEndpoints(hydrated, config).map((c) => ({
    ...c,
    cluster_id: c.entity_id,
  }));
```

- [ ] **Step 4: Re-run the test — expect pass.**

```bash
npm run test:integration -- --test-name-pattern='T4 — shadow mode'
```

Expected: pass.

- [ ] **Step 5: Run the existing T3 test — should still pass (no clusters because seedCorrected has empty hits).**

```bash
npm run test:integration -- --test-name-pattern='T3 — corrected rows fetched'
```

Expected: pass.

- [ ] **Step 6: Run lint + commit.**

```bash
npm run lint
git add system/cognition/jobs/internal/meta-recall-narrative.js system/tests/integration/meta-cognition-run.test.js
git commit -m "feat(meta-cognition): hydrate about-edges, cluster, surface-fallback, shadow mode"
```

---

### Task 5.5: LLM call + writes (memo + rule_candidates) + telemetry completion

**Files:** `system/cognition/jobs/internal/meta-recall-narrative.js`, `system/tests/integration/meta-cognition-run.test.js`

- [ ] **Step 1: Append failing tests for the happy path, max_rules cap, and llm_parse_error.**

Append to `system/tests/integration/meta-cognition-run.test.js`:

```js
test('T5 — happy path: writes reasoning memo + rule_candidates', async () => {
  const db = await fresh();
  const e = createStubEmbedder({ dimension: 1024 });
  const { note } = await import('../../cognition/memory/store.js');
  await db.query("UPDATE runtime:`meta_cognition.config` SET value.enabled = true").collect();

  const ent = await db.query(surql`CREATE entities CONTENT { name: 'photo-tools', type: 'project', scope: 'global' }`).collect();
  const entityId = ent[0][0].id;

  const memos = [];
  for (let i = 0; i < 5; i++) {
    const m = await note(db, e, 'knowledge', {
      content: `mem ${i}`,
      derived_by: 'agent',
      scope: 'global',
      subjects: [entityId],
    });
    memos.push(m.id);
  }
  for (let i = 0; i < 5; i++) {
    await db.query(
      surql`CREATE recall_log CONTENT {
        ts: time::now() - duration::from::days(1),
        session_id: ${`s${i}`},
        query: ${`q${i}`},
        k: 5,
        ranked_hits: [{ record: ${memos[i]}, kind: 'memo' }],
        outcome: 'corrected',
      }`,
    ).collect();
  }

  const llmResponse = JSON.stringify({
    narrative: 'Across this week, recall about photo-tools surfaced a stale memo about a different toolkit.',
    clusters: [
      {
        cluster_id: String(entityId),
        error_pattern: 'Stale memo about a different photography toolkit kept surfacing.',
        suggested_rules: [
          'When asked about photo-tools, do not cite memos older than 60 days.',
          'Disambiguate photo-tools from other photography toolkits before citing memos.',
        ],
        rule_confidence: [0.8, 0.6],
      },
    ],
  });

  const result = await runMetaRecallNarrative({ db, embedder: e, host: fakeHost(llmResponse) });
  const summary = JSON.parse(result);
  assert.equal(summary.ran, true);
  assert.equal(summary.rules, 2);
  assert.ok(summary.reasoning_memo_id);

  const [memoRows] = await db
    .query("SELECT id, meta, derived_by FROM memos WHERE kind = 'reasoning'")
    .collect();
  assert.equal(memoRows.length, 1);
  assert.equal(memoRows[0].derived_by, 'meta_cognition');
  assert.equal(memoRows[0].meta.dimension, 'recall_failures');
  assert.equal(memoRows[0].meta.from_signal, 'meta_cognition');
  assert.equal(memoRows[0].meta.period, 'weekly');
  assert.equal(memoRows[0].meta.signal_count, 5);
  assert.equal(memoRows[0].meta.recall_log_ids.length, 5);
  assert.ok(memoRows[0].meta.week_starting?.match(/^\d{4}-\d{2}-\d{2}$/));

  const [candRows] = await db
    .query("SELECT kind, payload, content FROM rule_candidates WHERE payload.source = 'meta_cognition'")
    .collect();
  assert.equal(candRows.length, 2);
  for (const c of candRows) {
    assert.equal(c.kind, 'behavior');
    assert.equal(c.payload.source, 'meta_cognition');
    assert.equal(String(c.payload.reasoning_memo_id), String(memoRows[0].id));
  }

  // about-edge from the reasoning memo to the entity.
  const [aboutEdges] = await db
    .query(surql`SELECT out FROM edges WHERE kind = 'about' AND in = ${memoRows[0].id}`)
    .collect();
  const outIds = aboutEdges.map((r) => String(r.out));
  assert.ok(outIds.includes(String(entityId)));

  const [tel] = await db.query('SELECT outcome, clusters, rules_proposed FROM meta_cognition_telemetry ORDER BY ts DESC LIMIT 1').collect();
  assert.equal(tel?.[0]?.outcome, 'complete');
  assert.equal(tel?.[0]?.clusters, 1);
  assert.equal(tel?.[0]?.rules_proposed, 2);
  await close(db);
});

test('T6 — max_rules_per_run cap drops over-limit suggestions', async () => {
  const db = await fresh();
  const e = createStubEmbedder({ dimension: 1024 });
  const { note } = await import('../../cognition/memory/store.js');
  await db.query("UPDATE runtime:`meta_cognition.config` SET value.enabled = true, value.max_rules_per_run = 2").collect();

  const ent = await db.query(surql`CREATE entities CONTENT { name: 'x', type: 'project', scope: 'global' }`).collect();
  const entId = ent[0][0].id;
  const memos = [];
  for (let i = 0; i < 5; i++) {
    const m = await note(db, e, 'knowledge', { content: `m${i}`, derived_by: 'agent', scope: 'global', subjects: [entId] });
    memos.push(m.id);
  }
  for (let i = 0; i < 5; i++) {
    await db.query(
      surql`CREATE recall_log CONTENT {
        ts: time::now() - duration::from::days(1),
        session_id: ${`s${i}`}, query: 'q', k: 5,
        ranked_hits: [{ record: ${memos[i]}, kind: 'memo' }], outcome: 'corrected',
      }`,
    ).collect();
  }

  const llmResponse = JSON.stringify({
    narrative: 'x',
    clusters: [
      {
        cluster_id: String(entId),
        error_pattern: 'p',
        suggested_rules: ['r1', 'r2', 'r3', 'r4', 'r5'],
        rule_confidence: [0.9, 0.8, 0.7, 0.6, 0.5],
      },
    ],
  });

  await runMetaRecallNarrative({ db, embedder: e, host: fakeHost(llmResponse) });
  const [candRows] = await db.query("SELECT content FROM rule_candidates WHERE payload.source = 'meta_cognition'").collect();
  assert.equal(candRows.length, 2);
  const contents = candRows.map((r) => r.content).sort();
  assert.deepEqual(contents, ['r1', 'r2']);
  const [tel] = await db.query('SELECT rules_dropped_over_cap FROM meta_cognition_telemetry ORDER BY ts DESC LIMIT 1').collect();
  assert.equal(tel?.[0]?.rules_dropped_over_cap, 3);
  await close(db);
});

test('T7 — llm_parse_error: no memo, no candidates, telemetry only', async () => {
  const db = await fresh();
  const e = createStubEmbedder({ dimension: 1024 });
  const { note } = await import('../../cognition/memory/store.js');
  await db.query("UPDATE runtime:`meta_cognition.config` SET value.enabled = true").collect();
  const ent = await db.query(surql`CREATE entities CONTENT { name: 'x', type: 'project', scope: 'global' }`).collect();
  const entId = ent[0][0].id;
  for (let i = 0; i < 5; i++) {
    const m = await note(db, e, 'knowledge', { content: `m${i}`, derived_by: 'agent', scope: 'global', subjects: [entId] });
    await db.query(
      surql`CREATE recall_log CONTENT {
        ts: time::now() - duration::from::days(1),
        session_id: ${`s${i}`}, query: 'q', k: 5,
        ranked_hits: [{ record: ${m.id}, kind: 'memo' }], outcome: 'corrected',
      }`,
    ).collect();
  }

  const result = await runMetaRecallNarrative({ db, embedder: e, host: fakeHost('not valid json {') });
  const summary = JSON.parse(result);
  assert.equal(summary.ran, false);
  assert.equal(summary.reason, 'llm_parse_error');
  const [memoRows] = await db.query("SELECT count() AS n FROM memos WHERE kind = 'reasoning' GROUP ALL").collect();
  assert.equal(memoRows?.[0]?.n ?? 0, 0);
  const [candRows] = await db.query("SELECT count() AS n FROM rule_candidates WHERE payload.source = 'meta_cognition' GROUP ALL").collect();
  assert.equal(candRows?.[0]?.n ?? 0, 0);
  const [tel] = await db.query('SELECT outcome FROM meta_cognition_telemetry ORDER BY ts DESC LIMIT 1').collect();
  assert.equal(tel?.[0]?.outcome, 'llm_parse_error');
  await close(db);
});
```

- [ ] **Step 2: Run the tests — expect failure.**

```bash
npm run test:integration -- --test-name-pattern='T5 — happy path|T6 — max_rules_per_run|T7 — llm_parse_error'
```

Expected: all three fail.

- [ ] **Step 3: Replace the post-clustering placeholder block in the orchestrator.**

Edit `system/cognition/jobs/internal/meta-recall-narrative.js`. Locate the placeholder block:

```js
  // §3.3 LLM + §3.4 writes wired in Task 5.5.
  await emitTelemetry(db, {
    outcome: 'shadow_complete', // placeholder until 5.5 lands
    corrected_count: correctedCount,
    unused_count: unusedRows.length,
    rows_after_privacy: cleanRows.length,
    dropped_private: droppedPrivate,
    clusters: clusters.length,
    duration_ms: Date.now() - startedAt,
  });
  return JSON.stringify({ ran: false, reason: 'shadow_mode', cluster_count: clusters.length });
```

Replace with:

```js
  // §3.3 LLM call.
  const weekStarting = new Date(Date.now() - config.lookback_days * 86400_000)
    .toISOString()
    .slice(0, 10);
  const promptCtx = { memoById: hydrated.memoById };
  const promptMeta = {
    week_starting: weekStarting,
    n_corrected: correctedRows.length,
    n_unused: unusedRows.length,
    top_k_clusters: config.top_k_clusters,
  };
  const userPrompt = buildUserPrompt(clusters, promptMeta, config, promptCtx);

  let llmResp;
  try {
    llmResp = await host.invokeLLM(
      [{ role: 'user', content: userPrompt.text }],
      {
        tier: config.tier,
        json: true,
        system: [{ role: 'system', content: META_COGNITION_SYSTEM, cache_control: { type: 'ephemeral' } }],
      },
    );
  } catch (err) {
    await emitTelemetry(db, {
      outcome: 'error',
      corrected_count: correctedCount,
      unused_count: unusedRows.length,
      rows_after_privacy: cleanRows.length,
      dropped_private: droppedPrivate,
      clusters: clusters.length,
      error: String(err?.message ?? err),
      duration_ms: Date.now() - startedAt,
    });
    return JSON.stringify({ ran: false, reason: 'llm_error' });
  }

  let parsed;
  try {
    parsed = JSON.parse(llmResp?.content ?? 'null');
  } catch {
    parsed = null;
  }
  const validated = validateMetaCognitionOutput(parsed, config);
  if (!validated.ok) {
    await emitTelemetry(db, {
      outcome: 'llm_parse_error',
      corrected_count: correctedCount,
      unused_count: unusedRows.length,
      rows_after_privacy: cleanRows.length,
      dropped_private: droppedPrivate,
      clusters: clusters.length,
      tokens_in: llmResp?.usage?.input_tokens,
      tokens_out: llmResp?.usage?.output_tokens,
      error: validated.errors.join('; ').slice(0, 500),
      duration_ms: Date.now() - startedAt,
    });
    return JSON.stringify({ ran: false, reason: 'llm_parse_error' });
  }

  // §3.4 writes.
  const writeResult = await writeOutputs(db, embedder, {
    parsed: validated.parsed,
    cleanRows,
    clusters,
    config,
    weekStarting,
  });

  await emitTelemetry(db, {
    outcome: 'complete',
    corrected_count: correctedCount,
    unused_count: unusedRows.length,
    rows_after_privacy: cleanRows.length,
    dropped_private: droppedPrivate,
    clusters: clusters.length,
    rules_proposed: writeResult.rules_proposed,
    rules_dropped_over_cap: writeResult.rules_dropped_over_cap,
    tokens_in: llmResp?.usage?.input_tokens,
    tokens_out: llmResp?.usage?.output_tokens,
    week_starting: weekStarting,
    reasoning_memo_id: writeResult.reasoning_memo_id,
    duration_ms: Date.now() - startedAt,
  });

  return JSON.stringify({
    ran: true,
    reasoning_memo_id: String(writeResult.reasoning_memo_id),
    rules: writeResult.rules_proposed,
  });
```

Then append at the bottom of the file:

```js
async function writeOutputs(db, embedder, { parsed, cleanRows, clusters, config, weekStarting }) {
  const clusterEntityIds = clusters.filter((c) => c.entity_id).map((c) => {
    const [tbl, key] = c.entity_id.split(':');
    return new RecordId(tbl, key);
  });

  const memoMeta = {
    dimension: 'recall_failures',
    from_signal: 'meta_cognition',
    period: 'weekly',
    signal_count: cleanRows.length,
    week_starting: weekStarting,
    clusters: parsed.clusters.length,
    recall_log_ids: cleanRows.map((r) => String(r.id)),
  };

  const memoResult = await note(db, embedder, 'reasoning', {
    content: parsed.narrative,
    scope: config.reasoning_memo_scope,
    derived_by: 'meta_cognition',
    subjects: clusterEntityIds, // about-edges to cluster entities
    lineage: [],                // no derived_from edges to recall_log (telemetry, not substrate)
    meta: memoMeta,
  });

  // Rank suggested rules across all clusters by descending confidence;
  // emit up to config.max_rules_per_run.
  const allRules = [];
  for (const cluster of parsed.clusters) {
    const rules = cluster.suggested_rules ?? [];
    const confs = cluster.rule_confidence ?? [];
    for (let i = 0; i < rules.length; i++) {
      allRules.push({
        cluster_id: cluster.cluster_id,
        content: rules[i],
        confidence: confs[i] ?? 0.7,
      });
    }
  }
  allRules.sort((a, b) => b.confidence - a.confidence);
  const kept = allRules.slice(0, config.max_rules_per_run);
  const droppedOverCap = Math.max(0, allRules.length - kept.length);

  for (const rule of kept) {
    await createCandidate(db, {
      content: rule.content,
      kind: 'behavior',
      signal_events: [],
      confidence: clamp01(rule.confidence),
      payload: {
        source: 'meta_cognition',
        cluster_id: rule.cluster_id,
        reasoning_memo_id: String(memoResult.id),
        week_starting: weekStarting,
      },
    });
  }

  return {
    reasoning_memo_id: memoResult.id,
    rules_proposed: kept.length,
    rules_dropped_over_cap: droppedOverCap,
  };
}

function clamp01(n) {
  if (!Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}
```

- [ ] **Step 4: Re-run the tests — expect pass.**

```bash
npm run test:integration -- --test-name-pattern='T5 — happy path|T6 — max_rules_per_run|T7 — llm_parse_error'
```

Expected: all three pass.

- [ ] **Step 5: Run the full integration suite for regressions.**

```bash
npm run test:integration
```

Expected: clean. Investigate any unexpected red.

- [ ] **Step 6: Run lint + commit.**

```bash
npm run lint
git add system/cognition/jobs/internal/meta-recall-narrative.js system/tests/integration/meta-cognition-run.test.js
git commit -m "feat(meta-cognition): LLM call + writes (reasoning memo + rule_candidates)"
```

---

## Phase 6 — `inject.js` array-kind change + `rank.js` TRUST_FACTOR

### Task 6.1: Add `meta_cognition: 0.9` to `TRUST_FACTOR`

**Files:** `system/cognition/intuition/rank.js`, `system/tests/unit/meta-cognition-trust.test.js` (new)

- [ ] **Step 1: Write a failing test for the trust factor.**

Create `system/tests/unit/meta-cognition-trust.test.js`:

```js
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { score } from '../../cognition/intuition/rank.js';

test('meta_cognition derived_by yields trustFactor=0.9 (explicit table entry)', () => {
  const r = score({
    record: {
      kind: 'reasoning',
      confidence: 1.0,
      signal_count: 1,
      decay_anchor: new Date(),
      derived_by: 'meta_cognition',
      scope: 'global',
    },
    distance: 0,
  });
  assert.equal(r.components.trustFactor, 0.9);
});
```

- [ ] **Step 2: Run the test — expect pass already (default fallback is 0.9).**

```bash
npm run test:unit -- --test-name-pattern='meta_cognition derived_by yields trustFactor'
```

Expected: pass (the existing default fallback returns 0.9). The test exists to prevent drift if the default is later lowered.

- [ ] **Step 3: Add `meta_cognition: 0.9` explicitly to the TRUST_FACTOR table.**

Edit `system/cognition/intuition/rank.js`. Locate the `const TRUST_FACTOR = {` block (structural anchor) and add `meta_cognition: 0.9` between `reflection` and `ingest`:

```js
const TRUST_FACTOR = {
  manual: 1.0,
  trusted: 1.0,
  biographer: 0.95,
  dream: 0.9,
  reflection: 0.9,
  meta_cognition: 0.9, // D2 — weekly meta-cognition over recall failures.
  ingest: 0.95,
  derived: 0.85,
  action_outcome: 0.85,
  agent: 0.85,
  untrusted: 0.5,
};
```

- [ ] **Step 4: Re-run the test — still pass.**

```bash
npm run test:unit -- --test-name-pattern='meta_cognition derived_by yields trustFactor'
```

Expected: pass.

- [ ] **Step 5: Lint + commit.**

```bash
npm run lint
git add system/cognition/intuition/rank.js system/tests/unit/meta-cognition-trust.test.js
git commit -m "feat(rank): explicit TRUST_FACTOR entry for derived_by='meta_cognition' (0.9)"
```

---

### Task 6.2: `inject.js` — `searchMemos` kind: ['knowledge', 'reasoning']

**Files:** `system/cognition/intuition/inject.js`, `system/tests/integration/meta-cognition-recall-surface.test.js` (new)

- [ ] **Step 1: Write a failing test that an intuition-style recall surfaces a `kind='reasoning'` memo.**

Create `system/tests/integration/meta-cognition-recall-surface.test.js`:

```js
import assert from 'node:assert/strict';
import { mkdirSync as __mk } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { writeConfig } from '../../config/paths.js';
import { close, connect } from '../../data/db/client.js';
import { runMigrations } from '../../data/db/migrate.js';
import { createStubEmbedder } from '../../data/embed/embedder.js';
import { note } from '../../cognition/memory/store.js';
import { intuitionEndpoint } from '../../cognition/intuition/inject.js';

const HOME = join(tmpdir(), `robin-d2recall-${process.pid}-${Math.random().toString(36).slice(2)}`);
__mk(HOME, { recursive: true });
process.env.ROBIN_HOME = HOME;
await writeConfig({ embedder_profile: 'mxbai-1024' });

async function fresh() {
  const db = await connect({ engine: 'mem://' });
  await runMigrations(db, resolve(import.meta.dirname, '../../data/db/migrations'));
  return db;
}

test('S1 — reasoning memo surfaces at intuition recall', async () => {
  const db = await fresh();
  const e = createStubEmbedder({ dimension: 1024 });
  // Write a reasoning memo about photo-tools.
  await note(db, e, 'reasoning', {
    content: 'Across this week, recall about photo-tools surfaced stale memos about a different toolkit.',
    derived_by: 'meta_cognition',
    scope: 'global',
    meta: {
      dimension: 'recall_failures',
      from_signal: 'meta_cognition',
      period: 'weekly',
      signal_count: 5,
      week_starting: '2026-05-04',
    },
  });
  // And a knowledge memo as a control.
  await note(db, e, 'knowledge', {
    content: 'photo-tools is a Next.js 16 photography toolkit',
    derived_by: 'agent',
    scope: 'global',
  });

  const out = await intuitionEndpoint(db, e, {
    query: 'tell me about photo-tools recall failures',
    prior: '',
    k: 10,
    recencyDays: 30,
  });
  // The reasoning memo should be present in the rendered block.
  const block = typeof out === 'string' ? out : (out?.block ?? '');
  assert.ok(
    block.includes('photo-tools surfaced stale memos'),
    `reasoning memo content should appear in injected block; got: ${block.slice(0, 200)}`,
  );
  await close(db);
});
```

- [ ] **Step 2: Run the test — expect failure (only `kind='knowledge'` surfaces today).**

```bash
npm run test:integration -- --test-name-pattern='S1 — reasoning memo surfaces'
```

Expected: assertion failure — the reasoning memo is not present.

- [ ] **Step 3: Change the `searchMemos` `kind` argument in `inject.js`.**

Edit `system/cognition/intuition/inject.js`. Locate the `Promise.all([recall(...), store.searchMemos(...)])` fan-out (structural anchor; coordinate with B2's prologue insert and D1's focus-block insert — none of those edits touch the inside of the `searchMemos` call). The existing line:

```js
        .searchMemos(db, embedder, combined, { kind: 'knowledge', limit: k, since })
```

Replace with:

```js
        .searchMemos(db, embedder, combined, { kind: ['knowledge', 'reasoning'], limit: k, since })
```

- [ ] **Step 4: Re-run the test — expect pass.**

```bash
npm run test:integration -- --test-name-pattern='S1 — reasoning memo surfaces'
```

Expected: pass.

- [ ] **Step 5: Run the full integration suite for regressions.**

```bash
npm run test:integration
```

Expected: clean — knowledge memos must continue to surface alongside the new reasoning memos.

- [ ] **Step 6: Lint + commit.**

```bash
npm run lint
git add system/cognition/intuition/inject.js system/tests/integration/meta-cognition-recall-surface.test.js
git commit -m "feat(intuition): surface kind='reasoning' alongside 'knowledge' in inject.js fan-out"
```

---

## Phase 7 — Manifest + heartbeat wiring

### Task 7.1: Create `meta-recall-narrative.md` manifest

**Files:** `system/cognition/jobs/builtin/meta-recall-narrative.md` (new), `system/tests/unit/meta-cognition-manifest.test.js` (new)

- [ ] **Step 1: Write a failing test that the manifest loader picks up the new manifest.**

Create `system/tests/unit/meta-cognition-manifest.test.js`:

```js
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { test } from 'node:test';

const MANIFEST_PATH = resolve(
  import.meta.dirname,
  '../../cognition/jobs/builtin/meta-recall-narrative.md',
);

test('meta-recall-narrative manifest exists and has expected frontmatter', async () => {
  const text = await readFile(MANIFEST_PATH, 'utf8');
  assert.ok(text.startsWith('---\n'), 'starts with frontmatter delimiter');
  assert.ok(text.match(/name:\s*meta-recall-narrative/));
  assert.ok(text.match(/schedule:\s*"0 5 \* \* 0"/));
  assert.ok(text.match(/runtime:\s*internal/));
  assert.ok(text.match(/enabled:\s*false/));
  assert.ok(text.match(/catch_up:\s*false/));
  assert.ok(text.match(/timeout_minutes:\s*5/));
  assert.ok(text.match(/manually_runnable:\s*true/));
});

test('internal-job orchestrator exports default function', async () => {
  const mod = await import(
    '../../cognition/jobs/internal/meta-recall-narrative.js'
  );
  assert.equal(typeof mod.default, 'function');
});
```

- [ ] **Step 2: Run the test — expect failure (manifest missing).**

```bash
npm run test:unit -- --test-name-pattern='meta-recall-narrative manifest|internal-job orchestrator'
```

Expected: manifest test fails; orchestrator test passes (from Phase 5).

- [ ] **Step 3: Create the manifest.**

Create `system/cognition/jobs/builtin/meta-recall-narrative.md`:

```markdown
---
name: meta-recall-narrative
schedule: "0 5 * * 0"
runtime: internal
enabled: false
catch_up: false
timeout_minutes: 5
notify: none
notify_on_failure: true
manually_runnable: true
description: Weekly meta-cognition pass over recall failures (kind='reasoning' memo + rule_candidates).
---

Internal job. Implementation in `cognition/jobs/internal/meta-recall-narrative.js`.

Reads `recall_log` rows from the trailing 7 days where `outcome='corrected'`
(primary) and `ranked_hits[*].used CONTAINS false` (secondary, post-B1).
Clusters retrieved memos by shared `about` edges in-Node; calls one
`tier:'fast'` LLM to name the error patterns and suggest behavior rules.

Writes:
- One `kind='reasoning'` memo per run with `meta.dimension='recall_failures'`,
  `derived_by='meta_cognition'`, scope from config (default `'global'`).
- 0-3 `rule_candidates` rows with `kind='behavior'` and
  `payload.source='meta_cognition'`, ranked by LLM confidence.

Gated by:
- `runtime:\`meta_cognition.config\`.value.enabled` — three-valued:
  `false` (default; job exits immediately), `'shadow'` (runs clustering +
  telemetry, no LLM, no writes), `true` (full path).
- Min-corrections threshold (default 5/week) — fewer than this and the
  job emits a `skipped_below_threshold` telemetry row and exits.

Schedule: Sunday 05:00 **local** time (the cron parser at
`system/cognition/jobs/cron.js` evaluates `Date#getDay()` and
`Date#getHours()` in local time — not UTC). 05:00 is the trough of Robin's
activity envelope: nightly dream has finished, heartbeat-driven syncs are
at minimum, no human is mid-session.

Telemetry: `meta_cognition_telemetry` (one row per invocation). Rollup
defers to C3.

Privacy: rows whose retrieved memos transitively reach `scope='private'`
memos are dropped before clustering (default
`private_scope_action='drop'`). Set to `'fail'` to abort the run instead.
```

- [ ] **Step 4: Re-run the manifest test — expect pass.**

```bash
npm run test:unit -- --test-name-pattern='meta-recall-narrative manifest'
```

Expected: pass.

- [ ] **Step 5: Commit.**

```bash
git add system/cognition/jobs/builtin/meta-recall-narrative.md system/tests/unit/meta-cognition-manifest.test.js
git commit -m "feat(meta-cognition): builtin job manifest (Sunday 05:00 local, disabled)"
```

---

## Phase 8 — Full-cycle integration (end-to-end + idempotence)

### Task 8.1: Idempotence and B1-not-landed guards

**Files:** `system/tests/integration/meta-cognition-run.test.js`

- [ ] **Step 1: Append failing tests for idempotence and B1-absent degradation.**

Append to `system/tests/integration/meta-cognition-run.test.js`:

```js
test('T8 — idempotence: repeat invocations write a new memo each time', async () => {
  const db = await fresh();
  const e = createStubEmbedder({ dimension: 1024 });
  const { note } = await import('../../cognition/memory/store.js');
  await db.query("UPDATE runtime:`meta_cognition.config` SET value.enabled = true").collect();
  const ent = await db.query(surql`CREATE entities CONTENT { name: 'x', type: 'project', scope: 'global' }`).collect();
  const entId = ent[0][0].id;
  for (let i = 0; i < 5; i++) {
    const m = await note(db, e, 'knowledge', { content: `m${i}`, derived_by: 'agent', scope: 'global', subjects: [entId] });
    await db.query(
      surql`CREATE recall_log CONTENT {
        ts: time::now() - duration::from::days(1),
        session_id: ${`s${i}`}, query: 'q', k: 5,
        ranked_hits: [{ record: ${m.id}, kind: 'memo' }], outcome: 'corrected',
      }`,
    ).collect();
  }

  const resp = JSON.stringify({
    narrative: 'n',
    clusters: [{ cluster_id: String(entId), error_pattern: 'p', suggested_rules: ['r'], rule_confidence: [0.7] }],
  });

  await runMetaRecallNarrative({ db, embedder: e, host: fakeHost(resp) });
  await runMetaRecallNarrative({ db, embedder: e, host: fakeHost(resp) });
  const [memoRows] = await db.query("SELECT count() AS n FROM memos WHERE kind = 'reasoning' GROUP ALL").collect();
  assert.equal(memoRows?.[0]?.n, 2, 'two distinct weekly snapshots');
  const [candRows] = await db.query("SELECT count() AS n FROM rule_candidates WHERE payload.source = 'meta_cognition' GROUP ALL").collect();
  assert.equal(candRows?.[0]?.n, 2);
  await close(db);
});

test('T9 — B1 absent: secondary query yields zero unused rows; corrected-only run completes', async () => {
  const db = await fresh();
  const e = createStubEmbedder({ dimension: 1024 });
  const { note } = await import('../../cognition/memory/store.js');
  await db.query("UPDATE runtime:`meta_cognition.config` SET value.enabled = true").collect();
  const ent = await db.query(surql`CREATE entities CONTENT { name: 'x', type: 'project', scope: 'global' }`).collect();
  const entId = ent[0][0].id;

  // 5 corrected rows; ranked_hits[*].used field intentionally absent — pre-B1 shape.
  for (let i = 0; i < 5; i++) {
    const m = await note(db, e, 'knowledge', { content: `m${i}`, derived_by: 'agent', scope: 'global', subjects: [entId] });
    await db.query(
      surql`CREATE recall_log CONTENT {
        ts: time::now() - duration::from::days(1),
        session_id: ${`s${i}`}, query: 'q', k: 5,
        ranked_hits: [{ record: ${m.id}, kind: 'memo' }],
        outcome: 'corrected',
      }`,
    ).collect();
  }

  const resp = JSON.stringify({
    narrative: 'n',
    clusters: [{ cluster_id: String(entId), error_pattern: 'p', suggested_rules: ['r'], rule_confidence: [0.7] }],
  });
  const result = await runMetaRecallNarrative({ db, embedder: e, host: fakeHost(resp) });
  const summary = JSON.parse(result);
  assert.equal(summary.ran, true);
  const [tel] = await db.query('SELECT unused_count, rows_after_privacy FROM meta_cognition_telemetry ORDER BY ts DESC LIMIT 1').collect();
  assert.equal(tel?.[0]?.unused_count, 0);
  assert.equal(tel?.[0]?.rows_after_privacy, 5);
  await close(db);
});
```

- [ ] **Step 2: Run the tests — expect pass (Phase 5 already covers these paths).**

```bash
npm run test:integration -- --test-name-pattern='T8 — idempotence|T9 — B1 absent'
```

Expected: both pass.

- [ ] **Step 3: Commit.**

```bash
git add system/tests/integration/meta-cognition-run.test.js
git commit -m "test(meta-cognition): idempotence + B1-absent degradation"
```

---

## Phase 9 — Privacy contract test

The dedicated privacy integration file from Phase 5.3 already covers the contract (`P1`, `P2`, `P3`). One more end-to-end assertion confirms the **closure property** — when private rows are dropped, the resulting reasoning memo's evidence chain never reaches private scope.

### Task 9.1: Closure-property end-to-end

**Files:** `system/tests/integration/meta-cognition-privacy.test.js`

- [ ] **Step 1: Append a failing closure-property test.**

Append to `system/tests/integration/meta-cognition-privacy.test.js`:

```js
test('P4 — closure property: when private rows are dropped, the written memo has no recall_log_ids pointing at private-touching rows', async () => {
  const db = await fresh();
  const e = createStubEmbedder({ dimension: 1024 });
  await db.query("UPDATE runtime:`meta_cognition.config` SET value.enabled = true").collect();

  const ent = await db.query(surql`CREATE entities CONTENT { name: 'x', type: 'project', scope: 'global' }`).collect();
  const entId = ent[0][0].id;
  const mClean = await note(db, e, 'knowledge', { content: 'clean', derived_by: 'agent', scope: 'global', subjects: [entId] });
  const mPriv = await note(db, e, 'knowledge', { content: 'private', derived_by: 'agent', scope: 'private', subjects: [entId] });

  const cleanRowIds = [];
  for (let i = 0; i < 5; i++) {
    const [created] = await db.query(
      surql`CREATE recall_log CONTENT {
        ts: time::now() - duration::from::days(1),
        session_id: ${`c${i}`}, query: 'q', k: 5,
        ranked_hits: [{ record: ${mClean.id}, kind: 'memo' }], outcome: 'corrected',
      } RETURN id`,
    ).collect();
    cleanRowIds.push(String(created[0].id));
  }
  // 1 private-touching row should be dropped.
  const [privateCreated] = await db.query(
    surql`CREATE recall_log CONTENT {
      ts: time::now() - duration::from::days(1),
      session_id: 'p', query: 'q', k: 5,
      ranked_hits: [{ record: ${mPriv.id}, kind: 'memo' }], outcome: 'corrected',
    } RETURN id`,
  ).collect();
  const privateRowId = String(privateCreated[0].id);

  const resp = JSON.stringify({
    narrative: 'n',
    clusters: [{ cluster_id: String(entId), error_pattern: 'p', suggested_rules: ['r'], rule_confidence: [0.7] }],
  });
  const host = { invokeLLM: async () => ({ content: resp, usage: { input_tokens: 0, output_tokens: 0 } }) };

  const result = await runMetaRecallNarrative({ db, embedder: e, host });
  const summary = JSON.parse(result);
  assert.equal(summary.ran, true);

  const [memoRows] = await db.query("SELECT meta FROM memos WHERE kind = 'reasoning'").collect();
  assert.equal(memoRows.length, 1);
  const ids = memoRows[0].meta.recall_log_ids ?? [];
  assert.ok(!ids.includes(privateRowId), 'the dropped private row must not appear in recall_log_ids');
  for (const cid of cleanRowIds) {
    assert.ok(ids.includes(cid), `clean row ${cid} should appear in recall_log_ids`);
  }
  await close(db);
});
```

- [ ] **Step 2: Run the test — expect pass (closure already enforced by `cleanRows` flow).**

```bash
npm run test:integration -- --test-name-pattern='P4 — closure property'
```

Expected: pass.

- [ ] **Step 3: Commit.**

```bash
git add system/tests/integration/meta-cognition-privacy.test.js
git commit -m "test(meta-cognition): closure property — dropped private rows absent from memo meta"
```

---

## Phase 10 — Telemetry verification

Telemetry shapes were locked in by `0018-meta-cognition.surql` and exercised by tasks 5.1–5.5. This phase verifies the four required metric names map to one-line SurrealQL aggregates.

### Task 10.1: Telemetry rollup smoke test

**Files:** `system/tests/integration/meta-cognition-run.test.js`

- [ ] **Step 1: Append a failing test for the four metric aggregates.**

Append to `system/tests/integration/meta-cognition-run.test.js`:

```js
test('T10 — telemetry metric aggregates resolve to expected shape', async () => {
  const db = await fresh();
  const e = createStubEmbedder({ dimension: 1024 });
  const { note } = await import('../../cognition/memory/store.js');
  await db.query("UPDATE runtime:`meta_cognition.config` SET value.enabled = true").collect();
  const ent = await db.query(surql`CREATE entities CONTENT { name: 'x', type: 'project', scope: 'global' }`).collect();
  const entId = ent[0][0].id;
  for (let i = 0; i < 5; i++) {
    const m = await note(db, e, 'knowledge', { content: `m${i}`, derived_by: 'agent', scope: 'global', subjects: [entId] });
    await db.query(
      surql`CREATE recall_log CONTENT {
        ts: time::now() - duration::from::days(1),
        session_id: ${`s${i}`}, query: 'q', k: 5,
        ranked_hits: [{ record: ${m.id}, kind: 'memo' }], outcome: 'corrected',
      }`,
    ).collect();
  }
  const resp = JSON.stringify({
    narrative: 'n',
    clusters: [{ cluster_id: String(entId), error_pattern: 'p', suggested_rules: ['r1', 'r2'], rule_confidence: [0.8, 0.6] }],
  });
  await runMetaRecallNarrative({ db, embedder: e, host: fakeHost(resp) });

  // analysis_runs
  const [aRows] = await db.query("SELECT count() AS n FROM meta_cognition_telemetry GROUP ALL").collect();
  assert.equal(aRows?.[0]?.n, 1);
  // clusters_emitted
  const [cRows] = await db.query("SELECT math::sum(clusters) AS n FROM meta_cognition_telemetry GROUP ALL").collect();
  assert.equal(cRows?.[0]?.n, 1);
  // suggested_rules_count (complete runs only)
  const [sRows] = await db.query("SELECT math::sum(rules_proposed) AS n FROM meta_cognition_telemetry WHERE outcome = 'complete' GROUP ALL").collect();
  assert.equal(sRows?.[0]?.n, 2);
  // tokens_used = tokens_in + tokens_out
  const [tRows] = await db.query("SELECT math::sum(tokens_in + tokens_out) AS n FROM meta_cognition_telemetry GROUP ALL").collect();
  assert.equal(tRows?.[0]?.n, 300, 'fakeHost reports 100 in + 200 out');
  await close(db);
});
```

- [ ] **Step 2: Run the test — expect pass.**

```bash
npm run test:integration -- --test-name-pattern='T10 — telemetry metric aggregates'
```

Expected: pass.

- [ ] **Step 3: Commit.**

```bash
git add system/tests/integration/meta-cognition-run.test.js
git commit -m "test(meta-cognition): telemetry metric aggregates (analysis_runs, clusters, rules, tokens)"
```

---

## Phase 11 — Docs

### Task 11.1: `docs/faculties.md` — new `meta-cognition` subsection

**Files:** `docs/faculties.md`

- [ ] **Step 1: Read the existing "Process faculties" section's structure.**

```bash
grep -n "^## \|^### " docs/faculties.md
```

Expected: subsections include `### reflection`, `### reinforcement (NEW)`, `### evidence (alpha.16, Theme 2a)` etc.

- [ ] **Step 2: Add a new subsection under "Process faculties".**

In `docs/faculties.md`, locate the line `### evidence (alpha.16, Theme 2a)` (or wherever the chronological cognition-track entries end). Append immediately after that subsection:

```markdown
### meta-cognition (cognition D2)

**What:** Weekly LLM analysis of recall failures. Reads `recall_log` rows from the trailing 7 days where the user corrected the agent (and, post-B1, rows whose retrieved memos went unused). Clusters retrieved memos by shared `about` endpoints in-Node, then asks one `tier:'fast'` LLM to name the error patterns and suggest behavior rules.

**Cadence:** Sunday 05:00 **local** time, gated by a min-corrections threshold (default 5/week). Runs *outside* the trigger queue — this is pattern-level analysis at a weekly cadence, not a per-event reflection.

**Data:**
- Reads: `recall_log` (corrected + unused-hit rows), `memos` (retrieved hits), `edges` (`about` endpoints + `derived_from` for privacy filter), `entities` (cluster labels).
- Writes: one `kind='reasoning'` memo per run with `meta.dimension='recall_failures'`, `derived_by='meta_cognition'`, scope from config (default `'global'`); 0-3 `rule_candidates` of `kind='behavior'` with `payload.source='meta_cognition'`.
- Lineage: provenance to source `recall_log` rows is encoded as `meta.recall_log_ids` (array of stringified record refs) — **not** `derived_from` edges (the edge registry restricts `derived_from` to substrate endpoints).

**Code:**
- `system/cognition/meta_cognition/cluster.js` — pure clustering by `about` endpoints.
- `system/cognition/meta_cognition/prompt.js` — system + user prompt construction.
- `system/cognition/meta_cognition/output.js` — JSON response validator.
- `system/cognition/jobs/internal/meta-recall-narrative.js` — orchestrator (config → gate → pull → privacy → hydrate → cluster → LLM → write → telemetry).
- `system/cognition/jobs/builtin/meta-recall-narrative.md` — manifest.

**Privacy:** Rows whose retrieved memos transitively reach `scope='private'` memos are dropped before clustering (mirrors `outbound-policy.js:checkOutboundScope`, with forward-arrow traversal `M -> derived_from -> memos[WHERE scope='private']`). Default `private_scope_action='drop'`; `'fail'` aborts the run instead.

**Surfacing:** The resulting reasoning memo is recall-eligible — `inject.js` widens its `searchMemos` filter to `kind: ['knowledge', 'reasoning']`. `rank.js` `TRUST_FACTOR` lists `meta_cognition: 0.9` explicitly.

**Rollout flag:** `runtime:meta_cognition.config.enabled` is three-valued: `false` (default; job exits at the first guard) | `'shadow'` (runs clustering + telemetry, suppresses LLM and writes) | `true` (full path).

**Reserved `meta.dimension` values for `kind='reasoning'`:**
- `'recall_failures'` — this faculty (D2).
- `'calibration'` — D3 sibling.
```

- [ ] **Step 3: Commit.**

```bash
git add docs/faculties.md
git commit -m "docs(faculties): meta-cognition faculty entry (D2)"
```

### Task 11.2: `docs/architecture.md` — agent turn + evolution layer

**Files:** `docs/architecture.md`

- [ ] **Step 1: Locate the "A typical agent turn" section.**

```bash
grep -n "A typical agent turn\|Evolution layer\|Cognition D" docs/architecture.md
```

- [ ] **Step 2: Append an item to the agent turn.**

Find the last numbered item in "A typical agent turn" and append (renumbering as needed; if the existing list ends at item 10 because D1 added one, this becomes item 11; if D1 hasn't landed, this is item N+1):

```markdown
- **Meta-cognition (weekly).** Every Sunday at 05:00 local time, an internal job (`meta-recall-narrative`) walks `recall_log` for the trailing 7 days of failure patterns and emits a `kind='reasoning'` memo (`meta.dimension='recall_failures'`) plus 0-3 `rule_candidates` (`kind='behavior'`, `payload.source='meta_cognition'`). Skipped when corrections < 5/week. Subsequent recalls about the cluster's entity can surface the reasoning memo via the widened intuition fan-out (`kind: ['knowledge','reasoning']`).
```

- [ ] **Step 3: Add an entry to the evolution layer section.**

Locate the section that lists cognition-track entries (e.g., "Cognition D1 (state inference)") and append:

```markdown
- **Cognition D2 (recall-failures meta-cognition).** Weekly Sunday-05:00 internal job in `cognition/jobs/internal/meta-recall-narrative.js`. Pure-JS clustering by `about`-edge endpoints; one tier:'fast' LLM call per run; writes a `kind='reasoning'` memo + rule_candidates with `payload.source='meta_cognition'` (distinct from `step-reflection.js`). Gated by `runtime:meta_cognition.config.enabled` (`false` | `'shadow'` | `true`). Telemetry: `meta_cognition_telemetry` (rollup deferred to C3).
```

- [ ] **Step 4: Commit.**

```bash
git add docs/architecture.md
git commit -m "docs(architecture): meta-cognition in agent-turn + evolution layer"
```

---

## Phase 12 — Rollout (three-valued flag flips)

### Task 12.1: Initial state — `enabled: false`

**Files:** none (verification only)

- [ ] **Step 1: Confirm the migration seed is `false`.**

```bash
grep -n "enabled:" system/data/db/migrations/0018-meta-cognition.surql
```

Expected: `enabled: false,`.

- [ ] **Step 2: Run the full test suite.**

```bash
npm run test:unit && npm run test:integration
```

Expected: clean. The faculty is dark.

- [ ] **Step 3: No code change; no commit. Document in the PR that Phase 12.2 (shadow) follows in a separate PR after this lands.**

### Task 12.2: Flip to shadow — `0019-meta-cognition-shadow.surql`

**Files:** `system/data/db/migrations/0019-meta-cognition-shadow.surql` (new)

- [ ] **Step 1: Verify `0019` is free.**

```bash
ls system/data/db/migrations/
```

Expected: no `0019-*` file. If a sibling spec has claimed `0019`, renumber the rollout migrations to the next free slot in the same commit that lands them.

- [ ] **Step 2: Create the shadow-flip migration.**

Write `system/data/db/migrations/0019-meta-cognition-shadow.surql`:

```surql
-- Cognition D2 rollout: flip meta-cognition flag from false → 'shadow'.
-- After this migration the job runs the full clustering pipeline and emits
-- telemetry rows (outcome='shadow_complete'), but does NOT call the LLM
-- and does NOT write the reasoning memo or rule_candidates.
--
-- Use the shadow week's `corrected_count` and `clusters` to validate the
-- min-corrections threshold and cluster yield before promoting to true.
UPSERT runtime:`meta_cognition.config` SET value.enabled = 'shadow';
```

- [ ] **Step 3: Run the migration smoke test against the new file.**

```bash
npm run test:unit -- --test-name-pattern='0018 migration|meta_cognition_telemetry table'
```

Expected: still passes (the existing test reads the cfg after running every migration in order; this one only mutates a single field).

- [ ] **Step 4: Document shadow verification in the commit message.**

```bash
git add system/data/db/migrations/0019-meta-cognition-shadow.surql
git commit -m "feat(rollout): meta-cognition shadow mode (telemetry-only)"
```

### Task 12.3: Flip to default-on — `0021-meta-cognition-enable.surql`

**Files:** `system/data/db/migrations/0021-meta-cognition-enable.surql` (new)

The gap to `0020` leaves room for D3 (`meta-cognition-calibration`) per the spec §13.1 allocation map.

- [ ] **Step 1: Verify `0021` is free.**

```bash
ls system/data/db/migrations/
```

Expected: no `0021-*` file.

- [ ] **Step 2: Verify the shadow week's telemetry before promoting.**

```bash
# Operator-side, not part of the automated suite:
#   SELECT outcome, corrected_count, clusters, dropped_private
#   FROM meta_cognition_telemetry
#   ORDER BY ts DESC LIMIT 10;
# Expect: at least one row with outcome='shadow_complete'; corrected_count ≥
# min_corrections_threshold for the typical week; dropped_private small.
```

If shadow telemetry shows `corrected_count < 5` consistently, tune the threshold downward in `runtime:\`meta_cognition.config\`.value.min_corrections_threshold` **before** running this migration, otherwise the `true` flip never fires.

- [ ] **Step 3: Create the enable migration.**

Write `system/data/db/migrations/0021-meta-cognition-enable.surql`:

```surql
-- Cognition D2 rollout: flip meta-cognition flag from 'shadow' → true.
-- After this migration the weekly run writes a `kind='reasoning'` memo +
-- 0-3 `rule_candidates`. The intuition fan-out is already widened to
-- surface `kind='reasoning'` (inject.js change landed alongside this faculty).
--
-- Operators can disable per-instance via:
--   UPDATE runtime:`meta_cognition.config` SET value.enabled = false;
-- No restart required (config is re-read on every job invocation).
UPSERT runtime:`meta_cognition.config` SET value.enabled = true;
```

- [ ] **Step 4: Run the full test suite.**

```bash
npm run test:unit && npm run test:integration
```

Expected: clean.

- [ ] **Step 5: Commit.**

```bash
git add system/data/db/migrations/0021-meta-cognition-enable.surql
git commit -m "feat(rollout): meta-cognition default-on (Sunday-05:00 LLM run writes reasoning memo)"
```

---

## Final verification

Run before opening the PR:

- [ ] `npm run lint` — clean.
- [ ] `npm run test:unit` — all green; the new unit test files (`meta-cognition-decay.test.js`, `meta-cognition-kind-registry.test.js`, `meta-cognition-migration.test.js`, `meta-cognition-cluster.test.js`, `meta-cognition-prompt.test.js`, `meta-cognition-output.test.js`, `meta-cognition-kind-filter.test.js`, `meta-cognition-trust.test.js`, `meta-cognition-manifest.test.js`) all pass.
- [ ] `npm run test:integration` — all green; the new integration test files (`meta-cognition-run.test.js`, `meta-cognition-recall-surface.test.js`, `meta-cognition-privacy.test.js`) all pass.
- [ ] `node --check system/cognition/jobs/internal/meta-recall-narrative.js` — clean.
- [ ] `ls system/data/db/migrations/` shows `0018-meta-cognition.surql` (and, after Phase 12, `0019-meta-cognition-shadow.surql` + `0021-meta-cognition-enable.surql`).
- [ ] `grep -rn "meta_cognition\|meta-cognition" docs/` shows the expected entries in `faculties.md` and `architecture.md` only (no stray references in unrelated docs).
- [ ] `grep -n "kind: \['knowledge', 'reasoning'\]" system/cognition/intuition/inject.js` returns the single fan-out site.
- [ ] `grep -n "kindFilter" system/cognition/memory/store.js` shows the helper plus its two call sites (`_surfaceSearch`, `listMemos`).

## Open items (deferred follow-ups)

These are explicitly out of scope for this plan and tracked under the spec's §12 "Open questions":

- **Cross-producer dedup on `rule_candidates` content.** `step-reflection` and D2 can converge on near-identical rule wording. The fix is a content-similarity pass; out of scope here.
- **Reasoning memo aging when patterns recur.** No `supersedes` edge is written between weekly snapshots; revisit if reasoning memos become recall-noise.
- **PII in LLM input.** Memo content at `scope='global'` may carry sensitive substrings; a pre-LLM PII scrub is pending the cross-cutting decision in C3 / Theme 5.
- **Privacy-check depth.** The current transitive check is one hop; replace with `{1..5}` traversal if telemetry shows a leak.
- **`unused_signal_weight = 0.33` calibration.** Tune after one month of `enabled=true` telemetry.
- **Window length.** 7 days is a guess paired with weekly cadence; tunable via `lookback_days`.
- **Default-on for new installs.** Decision deferred until one quarter of dogfood telemetry.
- **Self-dedup across weeks.** D2 does not dedupe its own prior-week output; the approval UI is the human deduper.
- **Citation tag for reasoning memos.** `inject.js:formatHit` renders reasoning memos as `[event YYYY-MM-DD]`; a dedicated `[reasoning ...]` tag is a possible later refinement.
- **`signal_events` empty contract.** D2's `rule_candidates` carry `signal_events: []` because `recall_log` rows aren't `events`; provenance lives in `payload.cluster_id` + `payload.reasoning_memo_id` until the approval-tooling spec lands.
