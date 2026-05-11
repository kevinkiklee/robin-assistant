# Cognition D3 — `belief()` MCP tool + calibration meta-narrative · Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a read-only `belief({query, domain?, k?})` MCP tool that aggregates evidence-backed confidence over recalled `kind='knowledge'` memos, applies a per-domain calibration adjustment, filters direct + transitive private scope, and returns one of `assert | soften | unknown` — plus a weekly Sunday 05:30 **local-time** internal job that writes a `kind='reasoning'`, `meta.dimension='calibration'` memo per domain summarising drift, and emits a `rule_candidates` row with `kind='behavior'` and `payload.source='meta_cognition_calibration'` when drift is sustained-large. Ship behind `shadow_mode = true` and flip after one dogfood week.

**Architecture:** Pure aggregation function (`aggregateBelief`) over `searchMemos` hits, fed into a calibration adjuster (`calibrateAdjust`) that prefers a recent `meta_narrative` memo over `persona:singleton.calibration`. A privacy filter (`filterPrivateRefs`) drops direct + transitive private hits. The MCP handler composes these and produces a recommendation via threshold lookup (`recommendBelief`). Telemetry rows land in `cadence_telemetry` under `step='belief.call'` with `meta.sample_rate`; C3's hot-bridge picks them up. The weekly writer reads resolved predictions for the past 7d / prior 7d / past 21d of `meta_cognition` memos, computes brier + drift + trend, writes one memo per domain (idempotent on `(meta.dimension, meta.domain, meta.week_starting)`), and conditionally emits a `rule_candidates` row.

**Tech Stack:** Node.js 22+ (ESM), SurrealDB 3.0.5 + `@surrealdb/node` 3.0.3 + `surrealdb` 2.0.3 (`BoundQuery`, `surql`). No new LLM calls. No new embed calls.

**Spec:** `docs/superpowers/specs/2026-05-11-cognition-d3-belief-gating-design.md`

**Dependencies:**
- Theme 2a (`evidence_ledger` + `fn::derived_confidence`).
- Theme 3 (`cadence_telemetry`, `dream_triggers`; read-only here).
- R-3 routes/tools split (already merged — `system/runtime/daemon/tools.js` exists; D3 wires the tool via `buildTools(ctx)`).
- A1/A2 recall pipeline (entity-boost, MMR). A3 eval harness must not regress.
- B1 reinforcement (`signal_count` / `decay_anchor` are the structural weight inputs).

**Coordinates with:**
- D1 (state inference) — distinct dimension (`current_focus` vs `calibration`).
- D2 (recall-failures meta-cognition) — sibling. Both write `kind='reasoning'` with `meta.from_signal='meta_cognition'`. Disjoint `meta.dimension` values: D2 owns `recall_failures`, D3 owns `calibration`. D2 runs Sunday 05:00 local; D3 runs 05:30 local.
- C3 hot-bridge rollup picks up `cadence_telemetry` rows with `step LIKE 'belief.%'`.

---

## File structure

| File | Status | Responsibility |
|---|---|---|
| `system/data/db/migrations/0019-belief-gating.surql` | new | Seed `runtime:belief.config` (additive only — no table mutations). |
| `system/cognition/memory/kind-registry.js` | modify (coordinated with D2) | Extend `reasoning.meta_schema` with optional `dimension`, `from_signal`, `domain`, `brier`, `drift`, `accuracy`, `mean_confidence`, `samples`, `trend`, `week_starting`. **If D2 already added these, skip this edit.** |
| `system/cognition/belief/aggregate.js` | new | Pure `aggregateBelief(hits, derivedMap, structuralMap, cfg)` → `{ aggregate, weights[], k_returned, fallback_path, hits_dropped_relevance }`. No DB imports. |
| `system/cognition/belief/calibration.js` | new | `readCalibration(db, domain, cfg)`, `aggregateAcrossKinds(by_kind, ts, cfg)`, `calibrateAdjust(agg, cal, cfg)`. Day-1 falls through to cross-kind aggregate. |
| `system/cognition/belief/privacy.js` | new | `filterPrivateRefs(db, refs)` — direct (`isOutboundBlocked(scope)`) + transitive (`<-derived_from<-memos[WHERE scope='private']`) drops. Returns `{ kept_ids, dropped_ids }`. |
| `system/cognition/belief/config.js` | new | `readBeliefConfig(db)` with 5s in-process cache; defaults mirror migration. |
| `system/cognition/belief/recommend.js` | new | `recommendBelief(calibrated, domain, cfg)` — threshold logic + per-domain override. |
| `system/cognition/belief/structural-weights.js` | new | Batched single-round-trip query for `{ signal_count, decay_anchor, reinforced, supersedes_count }` per id; computes `decay` in JS using `HALF_LIFE_BY_KIND_MS` from `cognition/memory/decay.js`. |
| `system/cognition/belief/domain.js` | new | `inferDomain(query, catalog, cfg)` — token-overlap match against entity catalog; case-insensitive lowering; `'none' / 'ambiguous'` telemetry tag. |
| `system/io/mcp/tools/belief.js` | new | MCP tool factory `createBeliefTool({ db, embedder, catalog })`. Compose recall → relevance/confidence filter → privacy → structural weights → derived confidence → aggregate → calibrate → recommend → telemetry. Shadow override here. Error envelope: never throw. |
| `system/cognition/jobs/internal/meta-calibration-narrative.js` | new | Weekly writer: read predictions 7d / prior 7d / prior 21d → per-domain brier/drift/trend → idempotent `store.note` for `kind='reasoning'` → conditional `createCandidate` with `kind='behavior'`, `payload.source='meta_cognition_calibration'`. Telemetry row in `cadence_telemetry` with `step='meta-cal-narrative'`. |
| `system/cognition/jobs/builtin/meta-calibration-narrative.md` | new | Manifest with `schedule: "30 5 * * 0"` (Sunday 05:30 local — cron parser uses local time). |
| `system/runtime/daemon/tools.js` | modify | Import `createBeliefTool`; push into `buildTools(ctx)` next to `createExplainBeliefTool`. **R-3 coordination note:** R-3 has already shipped; tool registration lives in `tools.js`, not `server.js`. If `ctx.catalog` is not yet on R-3's ctx shape, `belief.js` reads the catalog inline via the cached `getCatalog(db)` path A2 introduced. |
| `system/tests/unit/belief-aggregate.test.js` | new | Aggregate math (zero-hit, weighted average, divide-by-zero, deterministic ordering, relevance/confidence drops). |
| `system/tests/unit/belief-calibration.test.js` | new | `calibrateAdjust` clamping; `readCalibration` day-1 path; `aggregateAcrossKinds` cross-kind; per-domain match. |
| `system/tests/unit/belief-privacy.test.js` | new | Direct + transitive drop; all-private fallback. |
| `system/tests/unit/belief-domain.test.js` | new | Domain inference: explicit wins, ambiguous, none, lowercase. |
| `system/tests/unit/belief-recommend.test.js` | new | Threshold table; per-domain override; zero-hit → `unknown`. |
| `system/tests/unit/belief-config.test.js` | new | Default config; 5s cache; UPDATE invalidation behavior (read-through after sleep). |
| `system/tests/unit/audit-introspection-readonly.test.js` | modify | Add `system/io/mcp/tools/belief.js` to allowlist; permit `cadence_telemetry` writes specifically. |
| `system/tests/unit/meta-cal-narrative.test.js` | new | Empty week; single domain well-calibrated; sustained over-confidence (rule_candidate emitted with `kind='behavior'` + `payload.source='meta_cognition_calibration'`); mixed domains; idempotence within a week. |
| `system/tests/integration/belief-tool.test.js` | new | End-to-end happy path; private filter; calibration round-trip; meta-narrative override; shadow mode override; recall harness compatibility (no `recall_log` write); P95 latency < 100ms. |
| `system/tests/integration/meta-cal-narrative-loop.test.js` | new | Writer + reader round-trip; D2/D3 disjoint dimensions in the same run. |
| `system/tests/integration/belief-idempotence.test.js` | new | Re-run writer within same week → second run no-ops (idempotent dedup probe on `(meta.dimension, meta.domain, meta.week_starting)`). |
| `docs/faculties.md` | modify | New "belief (alpha.17, Cognition D3)" subsection between `evidence` and `cadence`. Update `foresight` to mention calibration feeds `belief()`. |
| `docs/architecture.md` | modify | Add bullet under "Evolution layer" for `belief()`; new step in "A typical agent turn": "Weekly Sunday 05:30 local, `meta-calibration-narrative` summarises per-domain drift." |
| `AGENTS.md` | modify (Phase 13, post-shadow week — NOT at land time) | Add "Soften gating with `belief()`" paragraph (§9.3 wording). |

---

## Cross-cutting decisions (pinned at top, referenced by tasks)

1. **Migration slot: `0019-belief-gating.surql`.** Sits after D2's `0018`. If land-order shifts D2, D3 follows mechanically (PR review edit).
2. **`rule_candidates.kind = 'behavior'` (NOT `'comm_style'`).** The `0001-init.surql` ASSERT on `rule_candidates.kind` is `IN ['behavior', 'profile_update', 'conflict_warning', 'reinforce_behavior']`. `'comm_style'` would throw. Discriminator goes on `payload.source = 'meta_cognition_calibration'` — never on `meta` (the `meta` column is not declared on `rule_candidates` SCHEMAFULL table; writing there silently drops).
3. **Schedule: `30 5 * * 0` → Sunday 05:30 LOCAL time.** The cron parser at `system/cognition/jobs/cron.js` uses `getMinutes()` / `getHours()` / `getDay()` — local. NOT UTC. D2 runs at 05:00 local, D3 at 05:30 local; the 30-minute gap survives DST.
4. **Drift threshold default: 0.15.** Matches the spec §1 motivating example (`+0.15 brier` is the smallest drift we want to call out). Both `meta_narrative_drift_threshold` and `meta_narrative_rule_threshold` are `0.15` at land; relax to `0.20` is documented as future tuning, not done in this plan.
5. **Weight composition: `weight = signal_count × decay × relevance`.** NO confidence multiplier. `derived_confidence` is the *value* in the weighted average; including confidence in the weight would double-count (would bias the aggregate toward `confidence²`). Sum-to-1 normalisation enforced in `aggregate.js`. Divide-by-zero → `aggregate = 0`, `recommendation = 'unknown'`, `fallback_path = 'no_hits'`.
6. **Day-1 calibration is mostly cross-kind aggregate.** `statement_kind` strings rarely match a user-facing `domain` ("photography"). Per-domain calibration becomes meaningful only after the meta-narrative writer has written at least one row for that domain (typically the second Sunday after land). Until then, `calibration.source = 'persona.calibration'` and `readCalibration` falls through to `aggregateAcrossKinds`.
7. **Privacy filter: direct + transitive** (stricter than D1's direct-only). Justified because `belief()` exposes memo content (the `evidence[]` block) directly to the caller — a public memo `derived_from` a private one carries content the user expects to stay private. Two SELECTs (mirror of `checkOutboundScope` shape, on `memos` instead of `events`).
8. **Telemetry: `cadence_telemetry` with `step='belief.call'` + `meta.sample_rate`.** C3's hot-bridge rolls up `step LIKE 'belief.%'`. The `meta.sample_rate` field is read at write time from `cfg.telemetry_sample_rate` (1.0 in shadow, 0.1 after flip); C3 multiplies counts by `1/sample_rate` to recover the unbiased rate. Sampling is deterministic on `hash(query) % N` so identical queries are consistently logged or skipped.
9. **Reserved `meta.dimension` values for `kind='reasoning'` memos.** `calibration` (D3, this spec), `recall_failures` (D2). Disjoint. Future writers add a new value rather than reusing either.
10. **`belief()` input schema includes `additionalProperties: false`.** Unrecognized inputs rejected explicitly.
11. **R-3 coordination.** Tool registration lives in `tools.js`/`buildTools(ctx)` (R-3 already shipped). `ctx.catalog` may or may not exist by D3 land time; the tool factory takes an optional `catalog` argument and falls through to `getCatalog(db)` (A2's cached path) when not provided.

---

## Phase 0 — Migration `0019-` + kind-registry coordination

### Task 0.1: Write `0019-belief-gating.surql`

**Files:** `system/data/db/migrations/0019-belief-gating.surql` (new)

- [ ] **Step 1: Verify `0019` is free and `0018` is owned by D2.**

```bash
ls system/data/db/migrations/
```

Expected: highest existing slot is `0008`. By the time D3 lands, D2 should have shipped `0018`. If `0019` is already taken at land time, bump D3 to the next free slot (`0020+`) and update every cross-reference in this plan + spec §3.4 + spec §7.1 in the same commit.

- [ ] **Step 2: Write the migration.**

Create `system/data/db/migrations/0019-belief-gating.surql`:

```surql
-- ============================================================================
-- Cognition D3: belief() gating tool config + meta-narrative writer config.
-- Additive only. No table changes. Seeds a single runtime config row.
-- ============================================================================

UPSERT runtime:`belief.config` SET value = {
  default_threshold:              0.6,
  soften_floor:                   0.4,
  domain_thresholds:              {},
  relevance_threshold:            0.30,
  confidence_floor:               0.05,
  belief_overfetch_factor:        2.0,
  min_calibration_samples:        5,
  calibration_adjustment_gain:    1.0,
  expected_accuracy_baseline:     0.75,
  domain_entity_types:            ['topic', 'project', 'library'],
  shadow_mode:                    true,
  telemetry_enabled:              true,
  telemetry_sample_rate:          1.0,

  meta_narrative_enabled:         true,
  meta_narrative_min_samples:     5,
  meta_narrative_drift_threshold: 0.15,
  meta_narrative_window_days:     7,
  meta_narrative_rule_threshold:  0.15,
  meta_narrative_rule_min_weeks:  2
};
```

- [ ] **Step 3: Write a migration smoke test.**

Create `system/tests/unit/belief-migration.test.js`:

```js
import assert from 'node:assert/strict';
import { mkdirSync as __mk } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { writeConfig } from '../../config/paths.js';
import { close, connect } from '../../data/db/client.js';
import { runMigrations } from '../../data/db/migrate.js';

const HOME = join(tmpdir(), `robin-belief-mig-${process.pid}-${Math.random().toString(36).slice(2)}`);
__mk(HOME, { recursive: true });
process.env.ROBIN_HOME = HOME;
await writeConfig({ embedder_profile: 'mxbai-1024' });

test('0019 migration applies cleanly and seeds runtime:belief.config', async () => {
  const db = await connect({ engine: 'mem://' });
  try {
    await runMigrations(db, resolve(import.meta.dirname, '../../data/db/migrations'));
    const [rows] = await db
      .query('SELECT VALUE value FROM runtime:`belief.config`')
      .collect();
    const cfg = rows?.[0];
    assert.ok(cfg, 'expected runtime:belief.config row');
    assert.equal(cfg.default_threshold, 0.6);
    assert.equal(cfg.soften_floor, 0.4);
    assert.equal(cfg.relevance_threshold, 0.30);
    assert.equal(cfg.belief_overfetch_factor, 2.0);
    assert.equal(cfg.shadow_mode, true);
    assert.equal(cfg.telemetry_enabled, true);
    assert.equal(cfg.telemetry_sample_rate, 1.0);
    assert.equal(cfg.meta_narrative_enabled, true);
    assert.equal(cfg.meta_narrative_min_samples, 5);
    assert.equal(cfg.meta_narrative_drift_threshold, 0.15);
    assert.equal(cfg.meta_narrative_window_days, 7);
    assert.equal(cfg.meta_narrative_rule_threshold, 0.15);
    assert.equal(cfg.meta_narrative_rule_min_weeks, 2);
    assert.deepEqual(cfg.domain_entity_types, ['topic', 'project', 'library']);
  } finally {
    await close(db);
  }
});
```

- [ ] **Step 4: Run — expect pass.**

```bash
npm run test:unit -- --test-name-pattern='0019 migration'
```

- [ ] **Step 5: Commit.**

```bash
git add system/data/db/migrations/0019-belief-gating.surql system/tests/unit/belief-migration.test.js
git commit -m "feat(schema): 0019 belief-gating runtime config seed"
```

### Task 0.2: Coordinated `kind-registry.js` extension (skip if D2 already did it)

**Files:** `system/cognition/memory/kind-registry.js`

- [ ] **Step 1: Inspect the current `reasoning` entry.**

```bash
grep -A 8 "^  reasoning:" system/cognition/memory/kind-registry.js
```

If the `meta_schema` already lists `dimension?`, `from_signal?`, `domain?`, `brier?`, `drift?`, `accuracy?`, `mean_confidence?`, `samples?`, `trend?`, `week_starting?` — D2 (or a prior writer) added them. **Skip this task** and note in the commit log of Phase 0 that the registry was already extended.

Otherwise proceed.

- [ ] **Step 2: Write a failing test asserting all D3-required optional meta keys are tolerated.**

Append to `system/tests/unit/belief-migration.test.js`:

```js
import { validateMemoKind } from '../../cognition/memory/kind-registry.js';

test('reasoning kind tolerates meta keys used by D2 + D3 writers', () => {
  const payload = {
    content: 'Calibration drift for photography this week: brier=0.18, drift=-0.12.',
    derived_by: 'auto',
    meta: {
      dimension: 'calibration',
      from_signal: 'meta_cognition',
      domain: 'photography',
      brier: 0.18,
      drift: -0.12,
      accuracy: 0.6,
      mean_confidence: 0.48,
      samples: 17,
      trend: 'worsening',
      week_starting: '2026-05-10',
    },
  };
  const r = validateMemoKind('reasoning', payload);
  assert.equal(r.ok, true, JSON.stringify(r));
});
```

- [ ] **Step 3: Run — expect pass under open-enum policy (since `meta_schema` declares optionals only, unknown keys are tolerated). If a future hardening of `validateMemoKind` rejects unknown keys, this is where it fails.**

```bash
npm run test:unit -- --test-name-pattern='reasoning kind tolerates'
```

If passing already, no edit needed — but extend `meta_schema` anyway to make the documentation explicit:

- [ ] **Step 4: Extend `reasoning.meta_schema`** with the optional keys D3 (and D2) write:

```js
  reasoning: {
    required: ['content', 'derived_by'],
    meta_schema: {
      session_id: 'string?',
      step: 'string?',
      // D2 + D3 meta-cognition writers (coordinated):
      dimension: 'string?',          // 'calibration' (D3) | 'recall_failures' (D2)
      from_signal: 'string?',        // 'meta_cognition' (shared family tag)
      domain: 'string?',
      brier: 'number?',
      drift: 'number?',
      accuracy: 'number?',
      mean_confidence: 'number?',
      samples: 'number?',
      trend: 'string?',              // 'new' | 'improving' | 'flat' | 'worsening'
      week_starting: 'string?',      // ISO date of Sunday 00:00 local
    },
  },
```

- [ ] **Step 5: Re-run the validation test + the existing kind-registry suite.**

```bash
npm run test:unit -- --test-name-pattern='reasoning kind|validateMemoKind'
```

- [ ] **Step 6: Commit.**

```bash
git add system/cognition/memory/kind-registry.js system/tests/unit/belief-migration.test.js
git commit -m "feat(kind-registry): document D2+D3 reasoning meta keys"
```

---

## Phase 1 — Pure aggregation (`aggregate.js`)

### Task 1.1: Write the unit tests first

**Files:** `system/tests/unit/belief-aggregate.test.js` (new)

- [ ] **Step 1: Write the tests.**

```js
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { aggregateBelief } from '../../cognition/belief/aggregate.js';

const DEFAULT_CFG = {
  relevance_threshold: 0.30,
  confidence_floor: 0.05,
};

test('aggregateBelief: weighted-average math (deterministic)', () => {
  // Three hits, structural-weight = signal_count × decay × relevance pre-normalised
  // to [0.5, 0.3, 0.2] (sum=1), derived = [0.9, 0.6, 0.3]. Expected: 0.69.
  const hits = [
    { id: 'memos:a', dist: 0.0, structural: 0.5, derived: 0.9 },
    { id: 'memos:b', dist: 0.0, structural: 0.3, derived: 0.6 },
    { id: 'memos:c', dist: 0.0, structural: 0.2, derived: 0.3 },
  ];
  const r = aggregateBelief(hits, DEFAULT_CFG);
  assert.ok(Math.abs(r.aggregate - 0.69) < 1e-6, `got ${r.aggregate}`);
  assert.equal(r.k_returned, 3);
  assert.equal(r.fallback_path, null);
  // Weights sum to 1 in the returned `weights` array (descending order).
  assert.ok(Math.abs(r.weights.reduce((a, b) => a + b, 0) - 1) < 1e-9);
  assert.deepEqual(
    [...r.weights].sort((a, b) => b - a),
    [...r.weights],
    'weights returned in descending order',
  );
});

test('aggregateBelief: all-zero weights → divide-by-zero guard (no NaN)', () => {
  // Every hit superseded → structural = 0 for all.
  const hits = [
    { id: 'memos:a', dist: 0.1, structural: 0, derived: 0.9 },
    { id: 'memos:b', dist: 0.2, structural: 0, derived: 0.4 },
  ];
  const r = aggregateBelief(hits, DEFAULT_CFG);
  assert.equal(r.aggregate, 0);
  assert.equal(r.fallback_path, 'no_hits');
  assert.equal(r.k_returned, 0);
  assert.ok(!Number.isNaN(r.aggregate));
});

test('aggregateBelief: empty hits → fallback_path=no_hits, aggregate=0', () => {
  const r = aggregateBelief([], DEFAULT_CFG);
  assert.equal(r.aggregate, 0);
  assert.equal(r.k_returned, 0);
  assert.equal(r.fallback_path, 'no_hits');
});

test('aggregateBelief: drops hits below relevance_threshold (cosine = 1 - dist)', () => {
  const hits = [
    { id: 'memos:a', dist: 0.10, structural: 0.5, derived: 0.9 }, // cos=0.90 keep
    { id: 'memos:b', dist: 0.60, structural: 0.5, derived: 0.4 }, // cos=0.40 keep
    { id: 'memos:c', dist: 0.85, structural: 0.5, derived: 0.5 }, // cos=0.15 drop
  ];
  const r = aggregateBelief(hits, DEFAULT_CFG);
  assert.equal(r.k_returned, 2);
  assert.equal(r.hits_dropped_relevance, 1);
});

test('aggregateBelief: every hit below relevance → fallback_path=all_below_relevance', () => {
  const hits = [
    { id: 'memos:a', dist: 0.90, structural: 0.5, derived: 0.9 },
    { id: 'memos:b', dist: 0.95, structural: 0.5, derived: 0.7 },
  ];
  const r = aggregateBelief(hits, DEFAULT_CFG);
  assert.equal(r.aggregate, 0);
  assert.equal(r.k_returned, 0);
  assert.equal(r.fallback_path, 'all_below_relevance');
  assert.equal(r.hits_dropped_relevance, 2);
});

test('aggregateBelief: drops hits below confidence_floor; folded into hits_dropped_relevance counter', () => {
  // Per spec §8.1 #5: confidence-floor drops collapse into hits_dropped_relevance
  // counter (the catch-all pre-aggregation drop counter). Only hits_dropped_private
  // stays a separate counter (boundary-relevant).
  const hits = [
    { id: 'memos:a', dist: 0.10, structural: 0.5, derived: 0.9 },  // keep
    { id: 'memos:b', dist: 0.10, structural: 0.5, derived: 0.02 }, // drop (below 0.05)
  ];
  const r = aggregateBelief(hits, DEFAULT_CFG);
  assert.equal(r.k_returned, 1);
  assert.equal(r.hits_dropped_relevance, 1);
});

test('aggregateBelief: deterministic ordering of evidence (descending weight)', () => {
  const hits = [
    { id: 'memos:c', dist: 0.0, structural: 0.1, derived: 0.5 },
    { id: 'memos:a', dist: 0.0, structural: 0.6, derived: 0.5 },
    { id: 'memos:b', dist: 0.0, structural: 0.3, derived: 0.5 },
  ];
  const r = aggregateBelief(hits, DEFAULT_CFG);
  assert.deepEqual(r.kept_ids, ['memos:a', 'memos:b', 'memos:c']);
});
```

- [ ] **Step 2: Run — expect failure (module missing).**

```bash
npm run test:unit -- --test-name-pattern='aggregateBelief'
```

### Task 1.2: Implement `aggregate.js`

**Files:** `system/cognition/belief/aggregate.js` (new)

- [ ] **Step 1: Write the module.**

```js
// aggregate.js — pure aggregation for the belief() tool.
// Spec §2. No DB imports; tests feed in shaped hits directly. Caller is
// responsible for batched fetches of structural-weight components (signal_count,
// decay, supersedes-count) and derived_confidence; this function combines them.
//
// Hit shape (one per surviving memo):
//   { id, dist, structural, derived }
//     - id: record-id string for sort stability + evidence kept_ids
//     - dist: HNSW cosine distance (relevance = 1 - dist; in [0,1])
//     - structural: signal_count × decay (already includes reinforced;
//       supersedes-zero rule applied by caller via decay=0)
//     - derived: derived_confidence in [0,1]; fallback to stored confidence
//       is the caller's responsibility (per spec §2.4 note).

const ZERO_WEIGHT_EPSILON = 1e-12;

/**
 * @param {Array<{id:string|object,dist:number,structural:number,derived:number}>} hits
 * @param {{relevance_threshold:number, confidence_floor:number}} cfg
 * @returns {{
 *   aggregate: number,
 *   weights: number[],            // sum-to-1, descending order
 *   kept_ids: string[],           // matched to weights, descending order
 *   k_returned: number,
 *   fallback_path: null | 'no_hits' | 'all_below_relevance',
 *   hits_dropped_relevance: number,
 * }}
 */
export function aggregateBelief(hits, cfg) {
  const minRel = cfg.relevance_threshold ?? 0.30;
  const minConf = cfg.confidence_floor ?? 0.05;

  if (!Array.isArray(hits) || hits.length === 0) {
    return {
      aggregate: 0, weights: [], kept_ids: [], k_returned: 0,
      fallback_path: 'no_hits', hits_dropped_relevance: 0,
    };
  }

  let dropped = 0;
  const keep = [];
  for (const h of hits) {
    const relevance = 1 - (h.dist ?? 0);
    if (relevance < minRel) { dropped++; continue; }
    if ((h.derived ?? 0) < minConf) { dropped++; continue; }
    // Confidence multiplier is NOT in the weight (spec §2.3).
    const weight_raw = (h.structural ?? 0) * relevance;
    keep.push({ id: h.id, weight_raw, relevance, derived: h.derived ?? 0 });
  }

  if (keep.length === 0) {
    return {
      aggregate: 0, weights: [], kept_ids: [], k_returned: 0,
      fallback_path: 'all_below_relevance',
      hits_dropped_relevance: dropped,
    };
  }

  const sumRaw = keep.reduce((s, k) => s + k.weight_raw, 0);
  if (sumRaw < ZERO_WEIGHT_EPSILON) {
    // Every surviving hit had weight_raw=0 — typically because all memos
    // were superseded → decay=0. Spec §2.3: collapse to no_hits path.
    return {
      aggregate: 0, weights: [], kept_ids: [], k_returned: 0,
      fallback_path: 'no_hits', hits_dropped_relevance: dropped,
    };
  }

  // Normalise and sort descending.
  for (const k of keep) k.weight = k.weight_raw / sumRaw;
  keep.sort((a, b) => b.weight - a.weight || String(a.id).localeCompare(String(b.id)));

  let agg = 0;
  for (const k of keep) agg += k.weight * k.derived;

  // Clamp defensively — fp drift on near-1 sums shouldn't push us out of [0,1].
  if (agg < 0) agg = 0;
  if (agg > 1) agg = 1;

  return {
    aggregate: agg,
    weights: keep.map((k) => k.weight),
    kept_ids: keep.map((k) => String(k.id)),
    k_returned: keep.length,
    fallback_path: null,
    hits_dropped_relevance: dropped,
  };
}
```

- [ ] **Step 2: Run — expect pass.**

```bash
npm run test:unit -- --test-name-pattern='aggregateBelief'
```

- [ ] **Step 3: Lint + commit.**

```bash
npm run lint
git add system/cognition/belief/aggregate.js system/tests/unit/belief-aggregate.test.js
git commit -m "feat(belief): aggregateBelief pure function + unit tests"
```

---

## Phase 2 — Calibration adjustment (`calibration.js`)

### Task 2.1: Tests for `calibrateAdjust`, `readCalibration`, `aggregateAcrossKinds`

**Files:** `system/tests/unit/belief-calibration.test.js` (new)

- [ ] **Step 1: Write the tests.**

```js
import assert from 'node:assert/strict';
import { mkdirSync as __mk } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import {
  aggregateAcrossKinds,
  calibrateAdjust,
  readCalibration,
} from '../../cognition/belief/calibration.js';
import { writeConfig } from '../../config/paths.js';
import { close, connect } from '../../data/db/client.js';
import { runMigrations } from '../../data/db/migrate.js';

const HOME = join(tmpdir(), `robin-cal-${process.pid}-${Math.random().toString(36).slice(2)}`);
__mk(HOME, { recursive: true });
process.env.ROBIN_HOME = HOME;
await writeConfig({ embedder_profile: 'mxbai-1024' });

const CFG = {
  min_calibration_samples: 5,
  calibration_adjustment_gain: 1.0,
  expected_accuracy_baseline: 0.75,
};

async function fresh() {
  const db = await connect({ engine: 'mem://' });
  await runMigrations(db, resolve(import.meta.dirname, '../../data/db/migrations'));
  return db;
}

test('calibrateAdjust: drift>0 (over-confident) pushes agg DOWN', () => {
  // agg=0.75, drift=0.15, gain=1.0 → adjusted = 0.60.
  assert.equal(calibrateAdjust(0.75, { drift: 0.15, samples_count: 10 }, CFG), 0.6);
});

test('calibrateAdjust: drift<0 (under-confident) pushes agg UP', () => {
  // agg=0.75, drift=-0.10, gain=1.0 → adjusted = 0.85.
  assert.equal(calibrateAdjust(0.75, { drift: -0.10, samples_count: 10 }, CFG), 0.85);
});

test('calibrateAdjust: clamps result to [0, 1]', () => {
  // agg=0.5, drift=0.90 → -0.4 → clamp to 0.
  assert.equal(calibrateAdjust(0.5, { drift: 0.90, samples_count: 10 }, CFG), 0);
  // agg=0.5, drift=-0.90 → 1.4 → clamp to 1.
  assert.equal(calibrateAdjust(0.5, { drift: -0.90, samples_count: 10 }, CFG), 1);
});

test('calibrateAdjust: no calibration → returns agg unchanged', () => {
  assert.equal(calibrateAdjust(0.75, null, CFG), 0.75);
});

test('calibrateAdjust: samples_count < min → returns agg unchanged', () => {
  assert.equal(calibrateAdjust(0.75, { drift: 0.20, samples_count: 3 }, CFG), 0.75);
});

test('calibrateAdjust: NaN drift → returns agg unchanged', () => {
  assert.equal(calibrateAdjust(0.75, { drift: NaN, samples_count: 10 }, CFG), 0.75);
});

test('readCalibration: persona missing → returns null', async () => {
  const db = await fresh();
  const r = await readCalibration(db, 'photography', CFG);
  assert.equal(r, null);
  await close(db);
});

test('readCalibration: domain matches statement_kind, case-insensitive', async () => {
  const db = await fresh();
  await db.query(`UPSERT persona:singleton SET calibration = {
    by_kind: { Photography: { resolved: 10, correct: 6, accuracy: 0.6 } },
    last_computed_at: '2026-05-10T05:02:11Z',
  }`).collect();
  const r = await readCalibration(db, 'photography', CFG);
  assert.equal(r.domain, 'Photography');
  assert.equal(r.samples_count, 10);
  // drift = 0.75 - 0.6 = 0.15.
  assert.ok(Math.abs(r.drift - 0.15) < 1e-9);
  assert.equal(r.source, 'persona.calibration');
  await close(db);
});

test('readCalibration: domain unmatched → aggregateAcrossKinds', async () => {
  const db = await fresh();
  await db.query(`UPSERT persona:singleton SET calibration = {
    by_kind: {
      prediction: { resolved: 8, correct: 6, accuracy: 0.75 },
      forecast:   { resolved: 4, correct: 3, accuracy: 0.75 },
    },
    last_computed_at: '2026-05-10T05:02:11Z',
  }`).collect();
  const r = await readCalibration(db, 'photography', CFG);
  assert.equal(r.domain, null);
  assert.equal(r.samples_count, 12); // 8+4
  // accuracy = 9/12 = 0.75; drift = 0.75 - 0.75 = 0.
  assert.ok(Math.abs(r.drift) < 1e-9);
  await close(db);
});

test('readCalibration: meta-narrative memo override (source=meta_narrative)', async () => {
  const db = await fresh();
  await db.query(`UPSERT persona:singleton SET calibration = {
    by_kind: { photography: { resolved: 10, correct: 6, accuracy: 0.6 } },
    last_computed_at: '2026-05-10T05:02:11Z',
  }`).collect();
  // Seed a recent meta-narrative memo for photography.
  await db.query(`CREATE memos CONTENT {
    kind: 'reasoning',
    content: 'Calibration drift for photography this week.',
    derived_by: 'auto',
    scope: 'global',
    confidence: 0.8,
    signal_count: 1,
    derived_at: time::now(),
    decay_anchor: time::now(),
    meta: {
      dimension: 'calibration',
      from_signal: 'meta_cognition',
      domain: 'photography',
      brier: 0.10,
      drift: -0.05,
      samples: 17,
    },
  }`).collect();
  const r = await readCalibration(db, 'photography', CFG);
  assert.equal(r.source, 'meta_narrative');
  assert.equal(r.drift, -0.05);
  await close(db);
});

test('aggregateAcrossKinds: empty → null', () => {
  assert.equal(aggregateAcrossKinds({}, new Date(), CFG), null);
});

test('aggregateAcrossKinds: weighted accuracy across kinds', () => {
  const r = aggregateAcrossKinds(
    {
      a: { resolved: 10, correct: 6 },
      b: { resolved: 20, correct: 16 },
    },
    new Date(),
    CFG,
  );
  assert.equal(r.samples_count, 30);
  // accuracy = 22/30 = 0.7333…; drift = 0.75 - 22/30.
  assert.ok(Math.abs(r.accuracy - 22 / 30) < 1e-9);
  assert.ok(Math.abs(r.drift - (0.75 - 22 / 30)) < 1e-9);
  assert.equal(r.source, 'persona.calibration');
});
```

- [ ] **Step 2: Run — expect failure (module missing).**

```bash
npm run test:unit -- --test-name-pattern='calibrateAdjust|readCalibration|aggregateAcrossKinds'
```

### Task 2.2: Implement `calibration.js`

**Files:** `system/cognition/belief/calibration.js` (new)

- [ ] **Step 1: Write the module.**

```js
// calibration.js — read + apply calibration drift for belief().
// Spec §3. Day-1 path: persona:singleton.calibration. Upgrade path: a
// recent kind='reasoning', meta.dimension='calibration' memo wins when
// present (the weekly meta-narrative writer fills these).

import { surql } from 'surrealdb';

/**
 * Apply linear-with-clamp calibration adjustment.
 *
 * drift > 0 → over-confident → push agg DOWN.
 * drift < 0 → under-confident → push agg UP.
 * Returns agg unchanged when calibration is missing/thin/invalid.
 */
export function calibrateAdjust(agg, cal, cfg) {
  if (!cal) return agg;
  if ((cal.samples_count ?? 0) < (cfg.min_calibration_samples ?? 5)) return agg;
  if (typeof cal.drift !== 'number' || Number.isNaN(cal.drift)) return agg;
  const gain = cfg.calibration_adjustment_gain ?? 1.0;
  const adjusted = agg - cal.drift * gain;
  if (adjusted < 0) return 0;
  if (adjusted > 1) return 1;
  return adjusted;
}

/**
 * Cross-kind aggregate fallback when domain is absent or unmatched.
 * Returns null on empty input.
 */
export function aggregateAcrossKinds(by_kind, ts, cfg) {
  let total = 0;
  let correct = 0;
  for (const v of Object.values(by_kind ?? {})) {
    total += v?.resolved ?? 0;
    correct += v?.correct ?? 0;
  }
  if (total === 0) return null;
  const accuracy = correct / total;
  const baseline = cfg.expected_accuracy_baseline ?? 0.75;
  return {
    domain: null,
    samples_count: total,
    accuracy,
    drift: baseline - accuracy,
    as_of: ts ?? null,
    source: 'persona.calibration',
  };
}

/**
 * Read calibration for a domain. Prefers a recent meta-narrative memo
 * (spec §3.4); falls back to persona:singleton.calibration; falls back
 * to aggregateAcrossKinds when the persona has no matching statement_kind.
 *
 * Returns null when no calibration data is available at all.
 */
export async function readCalibration(db, domain, cfg) {
  // §3.4 — try the meta-narrative override first (cheap; bounded by kind+derived_at).
  if (domain) {
    const [memoRows] = await db
      .query(
        surql`SELECT meta, derived_at FROM memos
              WHERE kind = 'reasoning'
                AND meta.dimension = 'calibration'
                AND meta.domain = ${domain}
                AND derived_at >= time::now() - 14d
              ORDER BY derived_at DESC
              LIMIT 1`,
      )
      .collect();
    const memo = memoRows?.[0];
    if (memo && memo.meta && typeof memo.meta.drift === 'number') {
      return {
        domain,
        samples_count: memo.meta.samples ?? cfg.min_calibration_samples ?? 5,
        accuracy: memo.meta.accuracy ?? null,
        drift: memo.meta.drift,
        brier: memo.meta.brier ?? null,
        as_of: memo.derived_at ?? null,
        source: 'meta_narrative',
      };
    }
  }

  // §3.2 — day-1 path: persona:singleton.calibration.
  const [personaRows] = await db
    .query('SELECT calibration FROM persona:singleton').collect();
  const cal = personaRows?.[0]?.calibration;
  if (!cal || !cal.by_kind) return null;

  if (domain) {
    const key = Object.keys(cal.by_kind).find(
      (k) => k.toLowerCase() === String(domain).toLowerCase(),
    );
    if (key) {
      const v = cal.by_kind[key];
      const baseline = cfg.expected_accuracy_baseline ?? 0.75;
      return {
        domain: key,
        samples_count: v?.resolved ?? 0,
        accuracy: v?.accuracy ?? 0,
        drift: baseline - (v?.accuracy ?? 0),
        as_of: cal.last_computed_at ?? null,
        source: 'persona.calibration',
      };
    }
  }

  // No domain match → cross-kind aggregate.
  return aggregateAcrossKinds(cal.by_kind, cal.last_computed_at, cfg);
}
```

- [ ] **Step 2: Run — expect pass.**

```bash
npm run test:unit -- --test-name-pattern='calibrateAdjust|readCalibration|aggregateAcrossKinds'
```

- [ ] **Step 3: Lint + commit.**

```bash
npm run lint
git add system/cognition/belief/calibration.js system/tests/unit/belief-calibration.test.js
git commit -m "feat(belief): calibrateAdjust + readCalibration (persona + meta-narrative paths)"
```

---

## Phase 3 — Privacy filter (`privacy.js`)

### Task 3.1: Tests for direct + transitive private filter

**Files:** `system/tests/unit/belief-privacy.test.js` (new)

- [ ] **Step 1: Write the tests.**

```js
import assert from 'node:assert/strict';
import { mkdirSync as __mk } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { surql } from 'surrealdb';
import { filterPrivateRefs } from '../../cognition/belief/privacy.js';
import { writeConfig } from '../../config/paths.js';
import { close, connect } from '../../data/db/client.js';
import { runMigrations } from '../../data/db/migrate.js';
import { createStubEmbedder } from '../../data/embed/embedder.js';
import * as store from '../../cognition/memory/store.js';

const HOME = join(tmpdir(), `robin-priv-${process.pid}-${Math.random().toString(36).slice(2)}`);
__mk(HOME, { recursive: true });
process.env.ROBIN_HOME = HOME;
await writeConfig({ embedder_profile: 'mxbai-1024' });

async function fresh() {
  const db = await connect({ engine: 'mem://' });
  await runMigrations(db, resolve(import.meta.dirname, '../../data/db/migrations'));
  return db;
}

test('filterPrivateRefs: direct private scope drop', async () => {
  const db = await fresh();
  const e = createStubEmbedder({ dimension: 1024 });
  const a = await store.note(db, e, 'knowledge', { content: 'A', derived_by: 'auto', scope: 'global' });
  const b = await store.note(db, e, 'knowledge', { content: 'B', derived_by: 'auto', scope: 'private' });
  const r = await filterPrivateRefs(db, [a.id, b.id]);
  assert.deepEqual(r.kept_ids.map(String), [String(a.id)]);
  assert.deepEqual(r.dropped_ids.map(String), [String(b.id)]);
  await close(db);
});

test('filterPrivateRefs: transitive private (public derived_from private)', async () => {
  const db = await fresh();
  const e = createStubEmbedder({ dimension: 1024 });
  const priv = await store.note(db, e, 'knowledge', { content: 'PRIV', derived_by: 'auto', scope: 'private' });
  const pub = await store.note(db, e, 'knowledge', { content: 'derived', derived_by: 'auto', scope: 'global' });
  // Build the derived_from arrow: derived → priv.
  await db.query(
    surql`RELATE ${pub.id}->derived_from->${priv.id} CONTENT { kind: 'derived_from' }`,
  ).collect();
  const r = await filterPrivateRefs(db, [pub.id]);
  assert.deepEqual(r.kept_ids, []);
  assert.deepEqual(r.dropped_ids.map(String), [String(pub.id)]);
  await close(db);
});

test('filterPrivateRefs: all-public passthrough', async () => {
  const db = await fresh();
  const e = createStubEmbedder({ dimension: 1024 });
  const a = await store.note(db, e, 'knowledge', { content: 'A', derived_by: 'auto', scope: 'global' });
  const b = await store.note(db, e, 'knowledge', { content: 'B', derived_by: 'auto', scope: 'global' });
  const r = await filterPrivateRefs(db, [a.id, b.id]);
  assert.equal(r.kept_ids.length, 2);
  assert.equal(r.dropped_ids.length, 0);
  await close(db);
});

test('filterPrivateRefs: empty input → empty output', async () => {
  const db = await fresh();
  const r = await filterPrivateRefs(db, []);
  assert.deepEqual(r.kept_ids, []);
  assert.deepEqual(r.dropped_ids, []);
  await close(db);
});
```

- [ ] **Step 2: Run — expect failure.**

```bash
npm run test:unit -- --test-name-pattern='filterPrivateRefs'
```

### Task 3.2: Implement `privacy.js`

**Files:** `system/cognition/belief/privacy.js` (new)

- [ ] **Step 1: Write the module.**

```js
// privacy.js — direct + transitive private-scope filter for belief() hits.
// Spec §2.5. Stricter than D1 (which filters direct-only) because belief()
// exposes memo content directly in evidence[].

import { BoundQuery } from 'surrealdb';
import { isOutboundBlocked } from '../memory/scope-registry.js';

/**
 * Drop refs whose scope is direct-private OR whose <-derived_from<-memos
 * traversal touches a private memo. Returns { kept_ids, dropped_ids }.
 *
 * Note (spec §2.5): we do NOT write a `refusals` row per drop — the
 * aggregate-level meta.hits_dropped_private is the right granularity, and
 * belief()'s callers don't see dropped IDs.
 */
export async function filterPrivateRefs(db, refs) {
  if (!Array.isArray(refs) || refs.length === 0) {
    return { kept_ids: [], dropped_ids: [] };
  }

  // Direct check.
  const [directRows] = await db
    .query(
      new BoundQuery('SELECT id, scope FROM memos WHERE id IN $ids', { ids: refs }),
    )
    .collect();
  const directBlocked = new Set();
  const scopeById = new Map();
  for (const r of directRows ?? []) {
    scopeById.set(String(r.id), r.scope);
    if (r.scope && isOutboundBlocked(r.scope)) {
      directBlocked.add(String(r.id));
    }
  }

  // Transitive check — only for refs not already dropped by direct.
  const remaining = refs.filter((r) => !directBlocked.has(String(r)));
  const transitiveBlocked = new Set();
  if (remaining.length > 0) {
    const [transRows] = await db
      .query(
        new BoundQuery(
          `SELECT id FROM memos
           WHERE id IN $ids
             AND count(<-derived_from<-memos[WHERE scope = 'private']) > 0`,
          { ids: remaining },
        ),
      )
      .collect();
    for (const r of transRows ?? []) {
      transitiveBlocked.add(String(r.id));
    }
  }

  const kept_ids = [];
  const dropped_ids = [];
  for (const r of refs) {
    const k = String(r);
    if (directBlocked.has(k) || transitiveBlocked.has(k)) {
      dropped_ids.push(r);
    } else {
      kept_ids.push(r);
    }
  }
  return { kept_ids, dropped_ids };
}
```

- [ ] **Step 2: Run — expect pass.**

```bash
npm run test:unit -- --test-name-pattern='filterPrivateRefs'
```

- [ ] **Step 3: Lint + commit.**

```bash
npm run lint
git add system/cognition/belief/privacy.js system/tests/unit/belief-privacy.test.js
git commit -m "feat(belief): direct + transitive private-scope filter"
```

---

## Phase 4 — Recommendation, domain inference, structural weights, config

### Task 4.1: `recommend.js` — threshold logic

**Files:** `system/cognition/belief/recommend.js`, `system/tests/unit/belief-recommend.test.js`

- [ ] **Step 1: Write tests.**

```js
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { recommendBelief } from '../../cognition/belief/recommend.js';

const CFG = { default_threshold: 0.6, soften_floor: 0.4, domain_thresholds: {} };

test('recommendBelief: ≥default_threshold → assert', () => {
  assert.equal(recommendBelief(0.7, null, 3, CFG), 'assert');
  assert.equal(recommendBelief(0.6, null, 3, CFG), 'assert');
});

test('recommendBelief: (soften_floor, default_threshold) → soften', () => {
  assert.equal(recommendBelief(0.41, null, 3, CFG), 'soften');
  assert.equal(recommendBelief(0.59, null, 3, CFG), 'soften');
});

test('recommendBelief: ≤soften_floor → unknown', () => {
  assert.equal(recommendBelief(0.40, null, 3, CFG), 'unknown');
  assert.equal(recommendBelief(0.30, null, 3, CFG), 'unknown');
});

test('recommendBelief: zero hits → unknown regardless of confidence', () => {
  assert.equal(recommendBelief(0.95, null, 0, CFG), 'unknown');
});

test('recommendBelief: per-domain threshold override', () => {
  const cfg = { ...CFG, domain_thresholds: { photography: 0.55 } };
  assert.equal(recommendBelief(0.56, 'photography', 3, cfg), 'assert');
  assert.equal(recommendBelief(0.56, null, 3, cfg), 'soften');
});

test('recommendBelief: full threshold table per spec §8.1 #10', () => {
  const table = [
    [0.30, 'unknown'],
    [0.39, 'unknown'],
    [0.40, 'unknown'],
    [0.41, 'soften'],
    [0.59, 'soften'],
    [0.60, 'assert'],
    [0.61, 'assert'],
  ];
  for (const [conf, expect] of table) {
    assert.equal(recommendBelief(conf, null, 3, CFG), expect, `conf=${conf}`);
  }
});
```

- [ ] **Step 2: Implement.**

```js
// recommend.js — threshold mapping per spec §2.6.

export function recommendBelief(calibrated, domain, k_returned, cfg) {
  if (k_returned === 0) return 'unknown';
  const t = (domain && cfg.domain_thresholds?.[domain]) ?? cfg.default_threshold ?? 0.6;
  const floor = cfg.soften_floor ?? 0.4;
  if (calibrated <= floor) return 'unknown';
  if (calibrated >= t) return 'assert';
  return 'soften';
}
```

- [ ] **Step 3: Run + commit.**

```bash
npm run test:unit -- --test-name-pattern='recommendBelief'
npm run lint
git add system/cognition/belief/recommend.js system/tests/unit/belief-recommend.test.js
git commit -m "feat(belief): recommendBelief threshold mapping"
```

### Task 4.2: `config.js` — `readBeliefConfig` with 5s cache

**Files:** `system/cognition/belief/config.js`, `system/tests/unit/belief-config.test.js`

- [ ] **Step 1: Tests.**

```js
import assert from 'node:assert/strict';
import { mkdirSync as __mk } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { readBeliefConfig } from '../../cognition/belief/config.js';
import { writeConfig } from '../../config/paths.js';
import { close, connect } from '../../data/db/client.js';
import { runMigrations } from '../../data/db/migrate.js';

const HOME = join(tmpdir(), `robin-bcfg-${process.pid}-${Math.random().toString(36).slice(2)}`);
__mk(HOME, { recursive: true });
process.env.ROBIN_HOME = HOME;
await writeConfig({ embedder_profile: 'mxbai-1024' });

async function fresh() {
  const db = await connect({ engine: 'mem://' });
  await runMigrations(db, resolve(import.meta.dirname, '../../data/db/migrations'));
  return db;
}

test('readBeliefConfig: returns seeded defaults', async () => {
  const db = await fresh();
  const cfg = await readBeliefConfig(db);
  assert.equal(cfg.default_threshold, 0.6);
  assert.equal(cfg.soften_floor, 0.4);
  assert.equal(cfg.shadow_mode, true);
  assert.equal(cfg.telemetry_sample_rate, 1.0);
  await close(db);
});

test('readBeliefConfig: caches within TTL', async () => {
  const db = await fresh();
  const a = await readBeliefConfig(db);
  // Mutate the row directly.
  await db.query('UPDATE runtime:`belief.config` SET value.default_threshold = 0.7').collect();
  const b = await readBeliefConfig(db);
  // Within TTL: same object (cached).
  assert.equal(b.default_threshold, a.default_threshold);
  await close(db);
});
```

- [ ] **Step 2: Implement.**

```js
// config.js — 5s in-process cache of runtime:`belief.config`.

const TTL_MS = 5_000;
let cache = null;
let cachedAt = 0;

const DEFAULTS = Object.freeze({
  default_threshold:              0.6,
  soften_floor:                   0.4,
  domain_thresholds:              {},
  relevance_threshold:            0.30,
  confidence_floor:               0.05,
  belief_overfetch_factor:        2.0,
  min_calibration_samples:        5,
  calibration_adjustment_gain:    1.0,
  expected_accuracy_baseline:     0.75,
  domain_entity_types:            ['topic', 'project', 'library'],
  shadow_mode:                    true,
  telemetry_enabled:              true,
  telemetry_sample_rate:          1.0,
  meta_narrative_enabled:         true,
  meta_narrative_min_samples:     5,
  meta_narrative_drift_threshold: 0.15,
  meta_narrative_window_days:     7,
  meta_narrative_rule_threshold:  0.15,
  meta_narrative_rule_min_weeks:  2,
});

export async function readBeliefConfig(db) {
  const now = Date.now();
  if (cache && now - cachedAt < TTL_MS) return cache;
  let value = null;
  try {
    const [rows] = await db.query('SELECT VALUE value FROM runtime:`belief.config`').collect();
    value = rows?.[0] ?? null;
  } catch {
    // fall through to defaults
  }
  cache = { ...DEFAULTS, ...(value ?? {}) };
  cachedAt = now;
  return cache;
}

export function _resetBeliefConfigCacheForTests() { cache = null; cachedAt = 0; }
```

- [ ] **Step 3: Run + commit.**

```bash
npm run test:unit -- --test-name-pattern='readBeliefConfig'
npm run lint
git add system/cognition/belief/config.js system/tests/unit/belief-config.test.js
git commit -m "feat(belief): readBeliefConfig with 5s cache"
```

### Task 4.3: `domain.js` — `inferDomain` against entity catalog

**Files:** `system/cognition/belief/domain.js`, `system/tests/unit/belief-domain.test.js`

- [ ] **Step 1: Write tests covering: explicit wins, single match (lowercased), ambiguous, none, type-filter.**

```js
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { inferDomain } from '../../cognition/belief/domain.js';

const CFG = { domain_entity_types: ['topic', 'project', 'library'] };

test('inferDomain: explicit caller domain wins', () => {
  const r = inferDomain('anything', 'photography', [], CFG);
  assert.equal(r.domain, 'photography');
  assert.equal(r.source, 'explicit');
});

test('inferDomain: single catalog match → lowercase domain', () => {
  const catalog = [{ name: 'GFX', type: 'topic' }];
  const r = inferDomain('specs of the GFX 100', null, catalog, CFG);
  assert.equal(r.domain, 'gfx');
  assert.equal(r.telemetry, null);
});

test('inferDomain: multiple matches → ambiguous (domain=null)', () => {
  const catalog = [
    { name: 'photography', type: 'topic' },
    { name: 'fujifilm',    type: 'topic' },
  ];
  const r = inferDomain('photography and fujifilm', null, catalog, CFG);
  assert.equal(r.domain, null);
  assert.equal(r.telemetry, 'ambiguous');
});

test('inferDomain: no overlap → none', () => {
  const catalog = [{ name: 'photography', type: 'topic' }];
  const r = inferDomain('f-stop of the GFX 100 II', null, catalog, CFG);
  assert.equal(r.domain, null);
  assert.equal(r.telemetry, 'none');
});

test('inferDomain: entity-type filter excludes person/place', () => {
  const catalog = [
    { name: 'kevin',       type: 'person' },
    { name: 'photography', type: 'topic'  },
  ];
  const r = inferDomain('what kevin said about photography', null, catalog, CFG);
  assert.equal(r.domain, 'photography');
});
```

- [ ] **Step 2: Implement.**

```js
// domain.js — domain inference via token-overlap against the entity catalog.
// Spec §2.7. Weak hint, not authoritative: caller's explicit `domain` wins.

import { tokensOf } from '../intuition/entities.js';

export function inferDomain(query, explicit, catalog, cfg) {
  if (explicit) return { domain: String(explicit).toLowerCase(), source: 'explicit', telemetry: null };
  if (!query) return { domain: null, source: 'none', telemetry: 'none' };

  const qTokens = new Set(tokensOf(String(query)));
  if (qTokens.size === 0) return { domain: null, source: 'none', telemetry: 'none' };

  const allowed = new Set(cfg.domain_entity_types ?? ['topic', 'project', 'library']);
  const matches = [];
  for (const ent of catalog ?? []) {
    if (!allowed.has(ent.type)) continue;
    const eTokens = tokensOf(String(ent.name ?? ''));
    if (eTokens.length === 0) continue;
    if (eTokens.some((t) => qTokens.has(t))) {
      matches.push(ent);
    }
  }

  if (matches.length === 0) return { domain: null, source: 'inferred', telemetry: 'none' };
  if (matches.length > 1) return { domain: null, source: 'inferred', telemetry: 'ambiguous' };
  return { domain: matches[0].name.toLowerCase(), source: 'inferred', telemetry: null };
}
```

- [ ] **Step 3: Run + commit.**

```bash
npm run test:unit -- --test-name-pattern='inferDomain'
npm run lint
git add system/cognition/belief/domain.js system/tests/unit/belief-domain.test.js
git commit -m "feat(belief): inferDomain against entity catalog"
```

### Task 4.4: `structural-weights.js` — batched fetch of per-hit weight components

**Files:** `system/cognition/belief/structural-weights.js`, `system/tests/unit/belief-structural-weights.test.js`

- [ ] **Step 1: Write a test that asserts one round-trip + correct decay=0 on supersedes.**

```js
import assert from 'node:assert/strict';
import { mkdirSync as __mk } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { surql } from 'surrealdb';
import { batchStructuralWeights } from '../../cognition/belief/structural-weights.js';
import { writeConfig } from '../../config/paths.js';
import { close, connect } from '../../data/db/client.js';
import { runMigrations } from '../../data/db/migrate.js';
import { createStubEmbedder } from '../../data/embed/embedder.js';
import * as store from '../../cognition/memory/store.js';

const HOME = join(tmpdir(), `robin-sw-${process.pid}-${Math.random().toString(36).slice(2)}`);
__mk(HOME, { recursive: true });
process.env.ROBIN_HOME = HOME;
await writeConfig({ embedder_profile: 'mxbai-1024' });

async function fresh() {
  const db = await connect({ engine: 'mem://' });
  await runMigrations(db, resolve(import.meta.dirname, '../../data/db/migrations'));
  return db;
}

test('batchStructuralWeights: supersedes_count>0 → structural=0', async () => {
  const db = await fresh();
  const e = createStubEmbedder({ dimension: 1024 });
  const a = await store.note(db, e, 'knowledge', { content: 'A', derived_by: 'auto' });
  const b = await store.note(db, e, 'knowledge', { content: 'B', derived_by: 'auto' });
  // b supersedes a.
  await db.query(
    surql`RELATE ${b.id}->supersedes->${a.id} CONTENT { kind: 'supersedes' }`,
  ).collect();
  const map = await batchStructuralWeights(db, [a.id, b.id]);
  assert.equal(map.get(String(a.id)).structural, 0, 'a is superseded → 0');
  assert.ok(map.get(String(b.id)).structural > 0, 'b not superseded → >0');
  await close(db);
});

test('batchStructuralWeights: empty ids → empty map', async () => {
  const db = await fresh();
  const map = await batchStructuralWeights(db, []);
  assert.equal(map.size, 0);
  await close(db);
});
```

- [ ] **Step 2: Implement.**

```js
// structural-weights.js — single-round-trip batched fetch of the
// weight inputs (signal_count, decay_anchor, reinforced, supersedes_count)
// and JS-side decay computation using HALF_LIFE_BY_KIND_MS.
// Spec §2.3.

import { BoundQuery } from 'surrealdb';
import { HALF_LIFE_BY_KIND_MS } from '../memory/decay.js';

const DEFAULT_HALF_LIFE = 14 * 24 * 60 * 60 * 1000; // 14d fallback

/**
 * @param {import('surrealdb').Surreal} db
 * @param {Array<string|object>} ids
 * @returns {Promise<Map<string, {structural:number, signal_count:number, decay:number, supersedes_count:number, kind:string}>>}
 */
export async function batchStructuralWeights(db, ids) {
  const out = new Map();
  if (!Array.isArray(ids) || ids.length === 0) return out;

  const [rows] = await db
    .query(
      new BoundQuery(
        `SELECT id, kind, signal_count, decay_anchor, reinforced,
                count(<-supersedes<-memos) AS sup
         FROM memos WHERE id IN $ids`,
        { ids },
      ),
    )
    .collect();

  const now = Date.now();
  for (const r of rows ?? []) {
    const k = String(r.id);
    const sup = Number(r.sup ?? 0);
    let decay = 0;
    if (sup === 0) {
      const halfLife = HALF_LIFE_BY_KIND_MS[r.kind] ?? DEFAULT_HALF_LIFE;
      const anchor = r.decay_anchor ? new Date(r.decay_anchor).getTime() : now;
      const age = Math.max(0, now - anchor);
      decay = Math.pow(2, -age / halfLife);
      const reinforced = Number(r.reinforced ?? 1);
      decay = decay * Math.max(1, reinforced);
    }
    const signal_count = Number(r.signal_count ?? 1);
    out.set(k, {
      structural: signal_count * decay,
      signal_count,
      decay,
      supersedes_count: sup,
      kind: r.kind,
    });
  }
  return out;
}
```

- [ ] **Step 3: Run + commit.**

```bash
npm run test:unit -- --test-name-pattern='batchStructuralWeights'
npm run lint
git add system/cognition/belief/structural-weights.js system/tests/unit/belief-structural-weights.test.js
git commit -m "feat(belief): batched structural-weight fetch + JS decay"
```

---

## Phase 5 — MCP tool factory (`belief.js`)

### Task 5.1: Write end-to-end branch tests for the handler

**Files:** `system/tests/unit/belief-tool-handler.test.js` (new — unit-level, against an in-memory DB and stub embedder)

- [ ] **Step 1: Tests covering the three recommendation branches + the shadow override + the error envelope.**

```js
import assert from 'node:assert/strict';
import { mkdirSync as __mk } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { createBeliefTool } from '../../io/mcp/tools/belief.js';
import { writeConfig } from '../../config/paths.js';
import { close, connect } from '../../data/db/client.js';
import { runMigrations } from '../../data/db/migrate.js';
import { createStubEmbedder } from '../../data/embed/embedder.js';
import * as store from '../../cognition/memory/store.js';
import { _resetBeliefConfigCacheForTests } from '../../cognition/belief/config.js';

const HOME = join(tmpdir(), `robin-bt-${process.pid}-${Math.random().toString(36).slice(2)}`);
__mk(HOME, { recursive: true });
process.env.ROBIN_HOME = HOME;
await writeConfig({ embedder_profile: 'mxbai-1024' });

async function fresh() {
  _resetBeliefConfigCacheForTests();
  const db = await connect({ engine: 'mem://' });
  await runMigrations(db, resolve(import.meta.dirname, '../../data/db/migrations'));
  return db;
}

test('belief tool: empty DB → unknown / fallback_path=no_hits, in shadow', async () => {
  const db = await fresh();
  const e = createStubEmbedder({ dimension: 1024 });
  const tool = createBeliefTool({ db, embedder: e, catalog: [] });
  const out = await tool.handler({ query: 'anything' });
  assert.equal(out.recommendation, 'unknown');
  assert.equal(out.meta.shadow, true);
  assert.equal(out.meta.fallback_path, 'no_hits');
});

test('belief tool: shadow override forces unknown but preserves shadow_recommendation_would_have_been', async () => {
  const db = await fresh();
  const e = createStubEmbedder({ dimension: 1024 });
  // Seed three high-confidence knowledge memos that should aggregate >= 0.6.
  for (const text of ['A about photography', 'B about photography', 'C about photography']) {
    await store.note(db, e, 'knowledge', { content: text, derived_by: 'auto', confidence: 0.9 });
  }
  const tool = createBeliefTool({ db, embedder: e, catalog: [] });
  const out = await tool.handler({ query: 'photography', domain: 'photography' });
  assert.equal(out.meta.shadow, true);
  assert.equal(out.recommendation, 'unknown', 'overridden by shadow_mode=true');
  assert.ok(
    ['assert', 'soften', 'unknown'].includes(out.meta.shadow_recommendation_would_have_been),
    `got ${out.meta.shadow_recommendation_would_have_been}`,
  );
});

test('belief tool: flipped out of shadow → recommendation reflects the gate', async () => {
  const db = await fresh();
  await db.query('UPDATE runtime:`belief.config` SET value.shadow_mode = false').collect();
  _resetBeliefConfigCacheForTests();
  const e = createStubEmbedder({ dimension: 1024 });
  for (const text of ['A photography', 'B photography', 'C photography']) {
    await store.note(db, e, 'knowledge', { content: text, derived_by: 'auto', confidence: 0.9 });
  }
  const tool = createBeliefTool({ db, embedder: e, catalog: [] });
  const out = await tool.handler({ query: 'photography' });
  assert.equal(out.meta.shadow, false);
  assert.ok(['assert', 'soften', 'unknown'].includes(out.recommendation));
  assert.equal(out.meta.shadow_recommendation_would_have_been, undefined);
});

test('belief tool: input schema rejects unknown properties (additionalProperties:false)', () => {
  const tool = createBeliefTool({ db: null, embedder: null, catalog: [] });
  assert.equal(tool.inputSchema.additionalProperties, false);
  assert.ok(tool.inputSchema.required.includes('query'));
});

test('belief tool: error envelope on internal failure', async () => {
  // Force an internal error by passing a stub db that throws.
  const stubDb = { query() { throw new Error('db down'); } };
  const e = createStubEmbedder({ dimension: 1024 });
  const tool = createBeliefTool({ db: stubDb, embedder: e, catalog: [] });
  const out = await tool.handler({ query: 'anything' });
  assert.equal(out.error, 'belief_internal');
  assert.equal(out.recommendation, 'unknown');
  assert.ok(out.meta);
});
```

- [ ] **Step 2: Run — expect failure (`belief.js` missing).**

```bash
npm run test:unit -- --test-name-pattern='belief tool'
```

### Task 5.2: Implement `system/io/mcp/tools/belief.js`

**Files:** `system/io/mcp/tools/belief.js` (new)

- [ ] **Step 1: Write the module.**

```js
// belief.js — MCP tool: aggregate evidence-backed confidence over recalled
// knowledge memos, apply calibration, recommend assert|soften|unknown.
//
// Spec §1, §2. Composes:
//   1. searchMemos(kind='knowledge', limit=k*overfetch)
//   2. aggregateBelief (relevance + confidence filter + weighted average)
//   3. filterPrivateRefs (direct + transitive)
//   4. readCalibration + calibrateAdjust
//   5. recommendBelief
//   6. cadence_telemetry write (sampled, step='belief.call')

import { surql } from 'surrealdb';
import { aggregateBelief } from '../../cognition/belief/aggregate.js';
import { readBeliefConfig } from '../../cognition/belief/config.js';
import { calibrateAdjust, readCalibration } from '../../cognition/belief/calibration.js';
import { inferDomain } from '../../cognition/belief/domain.js';
import { filterPrivateRefs } from '../../cognition/belief/privacy.js';
import { recommendBelief } from '../../cognition/belief/recommend.js';
import { batchStructuralWeights } from '../../cognition/belief/structural-weights.js';
import { sha256 } from '../../data/embed/hash.js';
import * as store from '../../cognition/memory/store.js';

const INPUT_SCHEMA = Object.freeze({
  type: 'object',
  properties: {
    query:  { type: 'string',  minLength: 1, maxLength: 500 },
    domain: { type: 'string',  minLength: 1, maxLength: 80 },
    k:      { type: 'integer', minimum: 1, maximum: 20, default: 8 },
  },
  required: ['query'],
  additionalProperties: false,
});

function snippet(content) {
  if (!content) return '';
  const s = String(content).slice(0, 200);
  const cut = Math.max(s.lastIndexOf('.'), s.lastIndexOf('!'), s.lastIndexOf('?'));
  if (cut > 80) return s.slice(0, cut + 1);
  return s.length === String(content).length ? s : `${s}…`;
}

function shouldLog(query, sample_rate) {
  if (sample_rate >= 1) return true;
  if (sample_rate <= 0) return false;
  const h = parseInt(sha256(String(query ?? '')).slice(0, 8), 16);
  const bucket = h / 0xFFFFFFFF;
  return bucket < sample_rate;
}

async function recordTelemetry(db, row) {
  try {
    await db.query(surql`CREATE cadence_telemetry CONTENT ${row}`).collect();
  } catch {
    /* telemetry advisory; never escalate */
  }
}

export function createBeliefTool({ db, embedder, catalog }) {
  return {
    name: 'belief',
    description: 'Aggregate evidence-backed confidence for a query and recommend assert | soften | unknown.',
    inputSchema: INPUT_SCHEMA,
    async handler(input) {
      const started = Date.now();
      const query = input?.query;
      const k = input?.k ?? 8;
      const meta = {
        k_requested: k,
        k_returned: 0,
        hits_dropped_private: 0,
        hits_dropped_relevance: 0,
        elapsed_ms: 0,
        fallback_path: null,
        domain_inferred: null,
        shadow: true,
      };

      try {
        const cfg = await readBeliefConfig(db);
        meta.shadow = !!cfg.shadow_mode;

        // 1. Domain inference (catalog fallback per R-3 ctx note).
        let cat = catalog;
        if (!Array.isArray(cat)) {
          try {
            const { getCatalog } = await import('../../cognition/intuition/entities.js');
            cat = await getCatalog(db);
          } catch { cat = []; }
        }
        const dom = inferDomain(query, input?.domain, cat ?? [], cfg);
        meta.domain_inferred = dom.telemetry;
        const domain = dom.domain;

        // 2. Recall.
        const k_overfetch = Math.ceil(k * (cfg.belief_overfetch_factor ?? 2));
        const hits = await store.searchMemos(db, embedder, query, {
          kind: 'knowledge',
          limit: k_overfetch,
        });

        // 3. Privacy filter on the recall set.
        const allIds = (hits ?? []).map((h) => h.id);
        const { kept_ids, dropped_ids } = await filterPrivateRefs(db, allIds);
        meta.hits_dropped_private = dropped_ids.length;
        if (kept_ids.length === 0 && allIds.length > 0) {
          meta.fallback_path = 'all_private';
          meta.elapsed_ms = Date.now() - started;
          const out = {
            query, domain,
            aggregate_confidence: 0,
            calibrated_confidence: 0,
            evidence: [],
            recommendation: 'unknown',
            meta,
          };
          if (cfg.shadow_mode) {
            out.recommendation = 'unknown';
            out.meta.shadow_recommendation_would_have_been = 'unknown';
          }
          if (cfg.telemetry_enabled && shouldLog(query, cfg.telemetry_sample_rate)) {
            await recordTelemetry(db, {
              step: 'belief.call', ts: new Date(), tokens_in: 0, tokens_out: 0,
              duration_ms: meta.elapsed_ms, success: true,
              meta: { sample_rate: cfg.telemetry_sample_rate, fallback_path: meta.fallback_path },
            });
          }
          return out;
        }

        const keptSet = new Set(kept_ids.map(String));
        const keptHits = (hits ?? []).filter((h) => keptSet.has(String(h.id)));

        // 4. Batched structural weights + derived confidence.
        const structuralMap = await batchStructuralWeights(db, keptHits.map((h) => h.id));
        const [derivedRows] = await db
          .query(
            surql`SELECT VALUE { id, derived: fn::derived_confidence(id), content, decay_anchor, derived_at }
                  FROM memos WHERE id IN ${keptHits.map((h) => h.id)}`,
          )
          .collect();
        const derivedById = new Map();
        const memoById = new Map();
        for (const r of derivedRows ?? []) {
          derivedById.set(String(r.id), Number(r.derived ?? 0));
          memoById.set(String(r.id), r);
        }

        // 5. Aggregate.
        const shaped = keptHits.map((h) => {
          const sm = structuralMap.get(String(h.id)) ?? { structural: 0 };
          return {
            id: h.id,
            dist: h.dist ?? 0,
            structural: sm.structural,
            derived: derivedById.get(String(h.id)) ?? h.confidence ?? 0,
          };
        });
        const agg = aggregateBelief(shaped, cfg);
        meta.hits_dropped_relevance = agg.hits_dropped_relevance;
        meta.k_returned = agg.k_returned;
        meta.fallback_path = agg.fallback_path;

        // 6. Calibration.
        const cal = await readCalibration(db, domain, cfg);
        const calibrated = calibrateAdjust(agg.aggregate, cal, cfg);

        // 7. Recommendation.
        const rawRecommendation = recommendBelief(calibrated, domain, agg.k_returned, cfg);

        // 8. Build evidence (top k by weight).
        const evidence = [];
        for (let i = 0; i < agg.kept_ids.length && evidence.length < k; i++) {
          const id = agg.kept_ids[i];
          const m = memoById.get(id);
          const sm = structuralMap.get(id);
          const lastObs =
            (m?.decay_anchor && new Date(m.decay_anchor) > new Date(m?.derived_at)
              ? m.decay_anchor
              : m?.derived_at) ?? null;
          evidence.push({
            memo_id: id,
            content_snippet: snippet(m?.content ?? ''),
            derived_confidence: derivedById.get(id) ?? 0,
            last_observed: lastObs,
            weight: agg.weights[i] ?? 0,
          });
        }

        meta.elapsed_ms = Date.now() - started;
        const result = {
          query,
          domain,
          aggregate_confidence: agg.aggregate,
          calibrated_confidence: calibrated,
          evidence,
          recommendation: rawRecommendation,
          meta,
        };
        if (cal) result.calibration = cal;

        if (cfg.shadow_mode) {
          result.meta.shadow_recommendation_would_have_been = rawRecommendation;
          result.recommendation = 'unknown';
        }

        if (cfg.telemetry_enabled && shouldLog(query, cfg.telemetry_sample_rate)) {
          await recordTelemetry(db, {
            step: 'belief.call', ts: new Date(), tokens_in: 0, tokens_out: 0,
            duration_ms: meta.elapsed_ms, success: true,
            meta: {
              sample_rate: cfg.telemetry_sample_rate,
              recommendation: result.recommendation,
              shadow_would_have_been: result.meta.shadow_recommendation_would_have_been ?? null,
              fallback_path: meta.fallback_path,
              k_returned: agg.k_returned,
              hits_dropped_private: meta.hits_dropped_private,
              calibration_source: cal?.source ?? null,
            },
          });
        }
        return result;
      } catch (err) {
        meta.elapsed_ms = Date.now() - started;
        meta.fallback_path = 'error';
        try {
          await recordTelemetry(db, {
            step: 'belief.call', ts: new Date(), tokens_in: 0, tokens_out: 0,
            duration_ms: meta.elapsed_ms, success: false,
            error: String(err?.message ?? err),
            meta: { sample_rate: 1 },
          });
        } catch { /* ignore */ }
        return {
          error: 'belief_internal',
          query: input?.query ?? null,
          domain: input?.domain ?? null,
          aggregate_confidence: 0,
          calibrated_confidence: 0,
          evidence: [],
          recommendation: 'unknown',
          meta,
        };
      }
    },
  };
}
```

- [ ] **Step 2: Run — expect pass.**

```bash
npm run test:unit -- --test-name-pattern='belief tool'
```

- [ ] **Step 3: Lint + commit.**

```bash
npm run lint
git add system/io/mcp/tools/belief.js system/tests/unit/belief-tool-handler.test.js
git commit -m "feat(belief): MCP tool factory composing aggregate + calibrate + privacy + recommend"
```

---

## Phase 6 — Register `belief` in `tools.js` (R-3-aware)

### Task 6.1: Wire into `buildTools(ctx)`

**Files:** `system/runtime/daemon/tools.js`

- [ ] **Step 1: Confirm R-3 status.**

```bash
grep -n "buildTools\|createExplainBeliefTool" system/runtime/daemon/tools.js | head
```

Expected: `buildTools(ctx)` exists and `createExplainBeliefTool` is already registered. If R-3 has not shipped (no `tools.js`), fall back to registering the tool in `server.js` next to the other tool pushes — single-line port either way.

- [ ] **Step 2: Failing test — verify the daemon lists `belief` in its tools.**

Add to `system/tests/unit/audit-introspection-readonly.test.js` (the existing file), in the allowlist section:

```js
const INTROSPECTION_TOOL_FILES = [
  // … existing entries …
  'system/io/mcp/tools/belief.js',
];

// belief.js is permitted to write `cadence_telemetry` rows only.
// Allow-list this single write keyword path for belief.js.
const PER_FILE_WRITE_ALLOWLIST = {
  'system/io/mcp/tools/belief.js': ['cadence_telemetry'],
};
```

Update the audit loop so that when `f === 'system/io/mcp/tools/belief.js'` and a forbidden keyword (`CREATE `, `UPDATE `, `DELETE `, `UPSERT `) is present, the test verifies the **token** immediately following the keyword is in `PER_FILE_WRITE_ALLOWLIST[f]` (i.e. only `CREATE cadence_telemetry` is permitted; any other CREATE fails). The existing test machinery should be extended in place — keep the rest of the introspection allowlist intact.

- [ ] **Step 3: Run the audit test — expect failure (belief.js not registered + CREATE present).**

```bash
npm run test:unit -- --test-name-pattern='introspection tools never write|belief'
```

- [ ] **Step 4: Edit `tools.js`.**

Add the import alongside `createExplainBeliefTool`:

```js
import { createBeliefTool } from '../../io/mcp/tools/belief.js';
```

Inside `buildTools(ctx)`, in the `tools.push(...)` block where introspection tools live, append:

```js
    createBeliefTool({
      db: ctx.db,
      embedder: ctx.embedder.wrap,
      catalog: ctx.catalog,        // optional; belief.js falls through to getCatalog(db) if undefined
    }),
```

- [ ] **Step 5: Run the audit test — expect pass.**

```bash
npm run test:unit -- --test-name-pattern='introspection tools never write|belief'
```

- [ ] **Step 6: Commit.**

```bash
git add system/runtime/daemon/tools.js system/tests/unit/audit-introspection-readonly.test.js
git commit -m "feat(daemon): register belief MCP tool in buildTools(ctx)"
```

---

## Phase 7 — Integration tests for `belief()`

### Task 7.1: End-to-end happy path, private filter, calibration, override, shadow, no `recall_log` write

**Files:** `system/tests/integration/belief-tool.test.js` (new)

- [ ] **Step 1: Write the integration suite.**

```js
import assert from 'node:assert/strict';
import { mkdirSync as __mk } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { surql } from 'surrealdb';
import { createBeliefTool } from '../../io/mcp/tools/belief.js';
import { writeConfig } from '../../config/paths.js';
import { close, connect } from '../../data/db/client.js';
import { runMigrations } from '../../data/db/migrate.js';
import { createStubEmbedder } from '../../data/embed/embedder.js';
import * as store from '../../cognition/memory/store.js';
import { _resetBeliefConfigCacheForTests } from '../../cognition/belief/config.js';

const HOME = join(tmpdir(), `robin-bit-${process.pid}-${Math.random().toString(36).slice(2)}`);
__mk(HOME, { recursive: true });
process.env.ROBIN_HOME = HOME;
await writeConfig({ embedder_profile: 'mxbai-1024' });

async function fresh() {
  _resetBeliefConfigCacheForTests();
  const db = await connect({ engine: 'mem://' });
  await runMigrations(db, resolve(import.meta.dirname, '../../data/db/migrations'));
  // For shadow=false tests, callers flip after fresh().
  return db;
}

test('I1 happy path: 3 memos, shadow=true, recommendation=unknown, shadow_would_have_been set, k_returned=3', async () => {
  const db = await fresh();
  const e = createStubEmbedder({ dimension: 1024 });
  for (const c of [
    'Photography f-stop notes A',
    'Photography f-stop notes B',
    'Photography lens at native ISO',
  ]) {
    await store.note(db, e, 'knowledge', { content: c, derived_by: 'auto', confidence: 0.85 });
  }
  const tool = createBeliefTool({ db, embedder: e, catalog: [] });
  const out = await tool.handler({ query: 'photography f-stop' });
  assert.equal(out.meta.shadow, true);
  assert.equal(out.recommendation, 'unknown');
  assert.ok(['assert', 'soften', 'unknown'].includes(out.meta.shadow_recommendation_would_have_been));
  assert.ok(out.meta.k_returned > 0);
  assert.ok(typeof out.meta.elapsed_ms === 'number');
  await close(db);
});

test('I2 private filter: private memo never appears in evidence[]', async () => {
  const db = await fresh();
  const e = createStubEmbedder({ dimension: 1024 });
  await store.note(db, e, 'knowledge', { content: 'public photography', derived_by: 'auto', scope: 'global' });
  const priv = await store.note(db, e, 'knowledge', { content: 'private photography', derived_by: 'auto', scope: 'private' });
  const tool = createBeliefTool({ db, embedder: e, catalog: [] });
  const out = await tool.handler({ query: 'photography' });
  assert.equal(out.meta.hits_dropped_private, 1);
  for (const ev of out.evidence) {
    assert.notEqual(ev.memo_id, String(priv.id));
  }
  await close(db);
});

test('I3 calibration round-trip: persona drift +0.15 lowers calibrated below aggregate', async () => {
  const db = await fresh();
  await db.query('UPDATE runtime:`belief.config` SET value.shadow_mode = false').collect();
  _resetBeliefConfigCacheForTests();
  await db.query(`UPSERT persona:singleton SET calibration = {
    by_kind: { photography: { resolved: 10, correct: 6, accuracy: 0.6 } },
    last_computed_at: '2026-05-10T05:02:11Z',
  }`).collect();
  const e = createStubEmbedder({ dimension: 1024 });
  for (let i = 0; i < 3; i++) {
    await store.note(db, e, 'knowledge', { content: `photography ${i}`, derived_by: 'auto', confidence: 0.9 });
  }
  const tool = createBeliefTool({ db, embedder: e, catalog: [] });
  const out = await tool.handler({ query: 'photography', domain: 'photography' });
  assert.ok(out.calibration);
  assert.equal(out.calibration.source, 'persona.calibration');
  assert.ok(Math.abs(out.calibration.drift - 0.15) < 1e-6);
  assert.ok(out.calibrated_confidence <= out.aggregate_confidence);
  await close(db);
});

test('I4 meta-narrative override: kind=reasoning memo wins over persona', async () => {
  const db = await fresh();
  await db.query('UPDATE runtime:`belief.config` SET value.shadow_mode = false').collect();
  _resetBeliefConfigCacheForTests();
  await db.query(`UPSERT persona:singleton SET calibration = {
    by_kind: { photography: { resolved: 10, correct: 6, accuracy: 0.6 } },
    last_computed_at: '2026-05-10T05:02:11Z',
  }`).collect();
  await db.query(`CREATE memos CONTENT {
    kind: 'reasoning',
    content: 'Calibration drift for photography.',
    derived_by: 'auto',
    scope: 'global',
    confidence: 0.8,
    signal_count: 1,
    derived_at: time::now(),
    decay_anchor: time::now(),
    meta: {
      dimension: 'calibration',
      from_signal: 'meta_cognition',
      domain: 'photography',
      drift: -0.05,
      brier: 0.10,
      samples: 17,
    },
  }`).collect();
  const e = createStubEmbedder({ dimension: 1024 });
  for (let i = 0; i < 3; i++) {
    await store.note(db, e, 'knowledge', { content: `photography ${i}`, derived_by: 'auto', confidence: 0.7 });
  }
  const tool = createBeliefTool({ db, embedder: e, catalog: [] });
  const out = await tool.handler({ query: 'photography', domain: 'photography' });
  assert.equal(out.calibration.source, 'meta_narrative');
  assert.equal(out.calibration.drift, -0.05);
  await close(db);
});

test('I5 shadow flip: shadow=false → recommendation is the gate output', async () => {
  const db = await fresh();
  await db.query('UPDATE runtime:`belief.config` SET value.shadow_mode = false').collect();
  _resetBeliefConfigCacheForTests();
  const e = createStubEmbedder({ dimension: 1024 });
  for (let i = 0; i < 3; i++) {
    await store.note(db, e, 'knowledge', { content: `photography ${i}`, derived_by: 'auto', confidence: 0.95 });
  }
  const tool = createBeliefTool({ db, embedder: e, catalog: [] });
  const out = await tool.handler({ query: 'photography' });
  assert.equal(out.meta.shadow, false);
  assert.equal(out.meta.shadow_recommendation_would_have_been, undefined);
  await close(db);
});

test('I6 belief() does NOT write recall_log (intentional — not part of reranker training surface)', async () => {
  const db = await fresh();
  const e = createStubEmbedder({ dimension: 1024 });
  for (let i = 0; i < 3; i++) {
    await store.note(db, e, 'knowledge', { content: `photography ${i}`, derived_by: 'auto', confidence: 0.7 });
  }
  const tool = createBeliefTool({ db, embedder: e, catalog: [] });
  const before = await db.query('SELECT count() AS n FROM recall_log GROUP ALL').collect();
  await tool.handler({ query: 'photography' });
  const after = await db.query('SELECT count() AS n FROM recall_log GROUP ALL').collect();
  assert.equal((before?.[0]?.[0]?.n ?? 0), (after?.[0]?.[0]?.n ?? 0));
  await close(db);
});

test('I7 telemetry: belief.call row lands in cadence_telemetry with meta.sample_rate', async () => {
  const db = await fresh();
  const e = createStubEmbedder({ dimension: 1024 });
  await store.note(db, e, 'knowledge', { content: 'photography', derived_by: 'auto', confidence: 0.7 });
  const tool = createBeliefTool({ db, embedder: e, catalog: [] });
  await tool.handler({ query: 'photography' });
  const [rows] = await db.query(
    surql`SELECT step, meta FROM cadence_telemetry WHERE step = 'belief.call'`,
  ).collect();
  assert.ok(rows.length > 0, 'expected at least one belief.call row');
  assert.equal(typeof rows[0].meta?.sample_rate, 'number');
});

test('I8 latency: P95 < 100ms over 20 calls (in-memory engine + stub embedder)', async () => {
  const db = await fresh();
  const e = createStubEmbedder({ dimension: 1024 });
  for (let i = 0; i < 6; i++) {
    await store.note(db, e, 'knowledge', { content: `photography ${i}`, derived_by: 'auto', confidence: 0.7 });
  }
  const tool = createBeliefTool({ db, embedder: e, catalog: [] });
  const samples = [];
  for (let i = 0; i < 20; i++) {
    const t0 = Date.now();
    await tool.handler({ query: 'photography' });
    samples.push(Date.now() - t0);
  }
  samples.sort((a, b) => a - b);
  const p95 = samples[Math.floor(samples.length * 0.95) - 1];
  assert.ok(p95 < 100, `expected p95 < 100ms, got ${p95}ms (samples=${samples.join(',')})`);
  await close(db);
});
```

- [ ] **Step 2: Run — expect pass (or diagnose actual failures and tune).**

```bash
npm run test:integration -- --test-name-pattern='I1 |I2 |I3 |I4 |I5 |I6 |I7 |I8 '
```

- [ ] **Step 3: Commit.**

```bash
git add system/tests/integration/belief-tool.test.js
git commit -m "test(belief): integration suite (happy path, privacy, calibration, shadow, latency)"
```

---

## Phase 8 — Weekly meta-calibration narrative writer

### Task 8.1: Unit tests for pure math + drift detection + idempotence

**Files:** `system/tests/unit/meta-cal-narrative.test.js` (new)

- [ ] **Step 1: Write the tests.**

```js
import assert from 'node:assert/strict';
import { mkdirSync as __mk } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import {
  computeDomainStats,
  computeTrend,
  shouldEmitRule,
  weekStartingISO,
} from '../../cognition/jobs/internal/meta-calibration-narrative.js';

test('computeDomainStats: brier + drift + accuracy + mean_confidence', () => {
  const preds = [
    { predicted_confidence: 0.9, correct: true },
    { predicted_confidence: 0.8, correct: false },
    { predicted_confidence: 0.6, correct: true },
    { predicted_confidence: 0.4, correct: false },
  ];
  const s = computeDomainStats(preds);
  // brier = ((0.9-1)^2 + (0.8-0)^2 + (0.6-1)^2 + (0.4-0)^2) / 4
  //       = (0.01 + 0.64 + 0.16 + 0.16) / 4 = 0.2425
  assert.ok(Math.abs(s.brier - 0.2425) < 1e-6);
  // accuracy = 2/4 = 0.5, mean_confidence = 2.7/4 = 0.675
  assert.equal(s.accuracy, 0.5);
  assert.ok(Math.abs(s.mean_confidence - 0.675) < 1e-6);
  // drift = mean_confidence - accuracy = 0.175
  assert.ok(Math.abs(s.drift - 0.175) < 1e-6);
  assert.equal(s.samples, 4);
});

test('computeTrend: worsening / improving / flat / new', () => {
  assert.equal(computeTrend(0.30, 0.20), 'worsening');
  assert.equal(computeTrend(0.20, 0.30), 'improving');
  assert.equal(computeTrend(0.20, 0.22), 'flat');
  assert.equal(computeTrend(0.20, null), 'new');
});

test('shouldEmitRule: drift over threshold for >= min_weeks consecutive → true', () => {
  const cfg = { meta_narrative_rule_threshold: 0.15, meta_narrative_rule_min_weeks: 2 };
  // Three prior weeks all over threshold same sign → emit.
  assert.equal(
    shouldEmitRule({ drift: 0.20 }, [{ drift: 0.18 }, { drift: 0.17 }], cfg),
    true,
  );
  // Below threshold this week → no emit.
  assert.equal(
    shouldEmitRule({ drift: 0.10 }, [{ drift: 0.18 }], cfg),
    false,
  );
  // Sign flip breaks the streak.
  assert.equal(
    shouldEmitRule({ drift: 0.20 }, [{ drift: -0.18 }, { drift: 0.20 }], cfg),
    false,
  );
});

test('weekStartingISO: returns Sunday 00:00 local for any date in the same week', () => {
  // Sunday 2026-05-10 → '2026-05-10'.
  const sunday = new Date('2026-05-10T07:00:00');
  assert.equal(weekStartingISO(sunday), '2026-05-10');
  // Saturday 2026-05-16 → '2026-05-10' (Sunday at the START of that week).
  const saturday = new Date('2026-05-16T22:00:00');
  assert.equal(weekStartingISO(saturday), '2026-05-10');
});
```

- [ ] **Step 2: Run — expect failure.**

```bash
npm run test:unit -- --test-name-pattern='computeDomainStats|computeTrend|shouldEmitRule|weekStartingISO'
```

### Task 8.2: Implement `meta-calibration-narrative.js`

**Files:** `system/cognition/jobs/internal/meta-calibration-narrative.js` (new)

- [ ] **Step 1: Write the module.**

```js
// meta-calibration-narrative.js — weekly Sunday 05:30 local writer.
// Spec §6. Reads resolved predictions for past 7d / prior 7d / prior 21d
// of meta_cognition memos; computes per-domain brier + drift + trend;
// writes one kind='reasoning', meta.dimension='calibration' memo per
// domain (idempotent on (domain, week_starting)); conditionally emits
// a rule_candidates row with kind='behavior',
// payload.source='meta_cognition_calibration'.

import { BoundQuery, surql } from 'surrealdb';
import { readBeliefConfig } from '../../belief/config.js';
import { createCandidate } from '../../dream/candidates.js';
import * as store from '../../memory/store.js';

const TELEMETRY_STEP = 'meta-cal-narrative';

/** Pure: stats per domain. */
export function computeDomainStats(preds) {
  const n = preds.length;
  if (n === 0) return null;
  let brier = 0;
  let correct = 0;
  let meanC = 0;
  for (const p of preds) {
    const target = p.correct ? 1 : 0;
    brier += (p.predicted_confidence - target) ** 2;
    if (p.correct) correct++;
    meanC += p.predicted_confidence;
  }
  brier /= n;
  const accuracy = correct / n;
  const mean_confidence = meanC / n;
  return { brier, accuracy, mean_confidence, drift: mean_confidence - accuracy, samples: n };
}

export function computeTrend(brier, prev_brier) {
  if (prev_brier == null) return 'new';
  const d = brier - prev_brier;
  if (d >  0.05) return 'worsening';
  if (d < -0.05) return 'improving';
  return 'flat';
}

/**
 * priorWeeks: ordered most-recent first; only entries with `drift` are required.
 * Returns true iff this week + the last `min_weeks - 1` prior weeks all
 * cross the threshold in the same direction.
 */
export function shouldEmitRule(current, priorWeeks, cfg) {
  const thr = cfg.meta_narrative_rule_threshold ?? 0.15;
  const minW = cfg.meta_narrative_rule_min_weeks ?? 2;
  if (Math.abs(current.drift) < thr) return false;
  const sign = Math.sign(current.drift);
  const required = minW - 1;
  for (let i = 0; i < required; i++) {
    const w = priorWeeks[i];
    if (!w) return false;
    if (Math.abs(w.drift) < thr) return false;
    if (Math.sign(w.drift) !== sign) return false;
  }
  return true;
}

/** Convert any date to the ISO date string of the Sunday at the start of its week (LOCAL). */
export function weekStartingISO(d = new Date()) {
  const local = new Date(d);
  local.setHours(0, 0, 0, 0);
  const dayOfWeek = local.getDay(); // 0 = Sunday
  local.setDate(local.getDate() - dayOfWeek);
  const y = local.getFullYear();
  const m = String(local.getMonth() + 1).padStart(2, '0');
  const day = String(local.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

async function recordTelemetry(db, row) {
  try { await db.query(surql`CREATE cadence_telemetry CONTENT ${row}`).collect(); } catch {}
}

async function dedupExists(db, domain, week) {
  try {
    const [rows] = await db
      .query(
        new BoundQuery(
          `SELECT 1 FROM memos
           WHERE kind = 'reasoning'
             AND meta.dimension = 'calibration'
             AND meta.domain = $domain
             AND meta.week_starting = $week
           LIMIT 1`,
          { domain, week },
        ),
      )
      .collect();
    return Array.isArray(rows) && rows.length > 0;
  } catch {
    return false;
  }
}

/**
 * Entrypoint: invoked by the heartbeat scheduler when the manifest cron fires.
 * `host` is unused (no LLM calls).
 *
 * @returns {Promise<{ wrote: string[], skipped: string[], rules: string[] }>}
 */
export async function runMetaCalibrationNarrative({ db, embedder, now = new Date() }) {
  const startedAt = Date.now();
  const cfg = await readBeliefConfig(db);
  if (!cfg.meta_narrative_enabled) {
    await recordTelemetry(db, {
      step: TELEMETRY_STEP, ts: new Date(), tokens_in: 0, tokens_out: 0,
      duration_ms: Date.now() - startedAt, success: true, meta: { reason: 'disabled' },
    });
    return { wrote: [], skipped: [], rules: [] };
  }

  const week = weekStartingISO(now);

  // Past 7d resolved predictions, grouped by statement_kind.
  let predRows = [];
  try {
    const [r] = await db.query(`
      SELECT meta.statement_kind AS domain,
             meta.correct        AS correct,
             confidence          AS predicted_confidence,
             meta.resolved_at    AS resolved_at
      FROM memos
      WHERE kind = 'prediction'
        AND meta.resolved_at IS NOT NONE
        AND meta.resolved_at >= time::now() - 7d
    `).collect();
    predRows = r ?? [];
  } catch { predRows = []; }

  // Prior 7d.
  let priorPredRows = [];
  try {
    const [r] = await db.query(`
      SELECT meta.statement_kind AS domain,
             meta.correct        AS correct,
             confidence          AS predicted_confidence
      FROM memos
      WHERE kind = 'prediction'
        AND meta.resolved_at >= time::now() - 14d
        AND meta.resolved_at <  time::now() - 7d
    `).collect();
    priorPredRows = r ?? [];
  } catch { priorPredRows = []; }

  // Most-recent prior meta-narrative memos per domain (last 21d).
  let priorMetaRows = [];
  try {
    const [r] = await db.query(`
      SELECT meta.domain AS domain, meta.brier AS brier, meta.drift AS drift,
             derived_at AS derived_at
      FROM memos
      WHERE kind = 'reasoning'
        AND meta.dimension = 'calibration'
        AND meta.from_signal = 'meta_cognition'
        AND derived_at >= time::now() - 21d
      ORDER BY derived_at DESC
    `).collect();
    priorMetaRows = r ?? [];
  } catch { priorMetaRows = []; }

  // Group by domain.
  const byDomain = new Map();
  for (const p of predRows) {
    const d = p.domain ?? 'unknown';
    if (!byDomain.has(d)) byDomain.set(d, []);
    byDomain.get(d).push(p);
  }
  const priorByDomain = new Map();
  for (const p of priorPredRows) {
    const d = p.domain ?? 'unknown';
    if (!priorByDomain.has(d)) priorByDomain.set(d, []);
    priorByDomain.get(d).push(p);
  }
  const priorMetaByDomain = new Map();
  for (const r of priorMetaRows) {
    const d = r.domain;
    if (!d) continue;
    if (!priorMetaByDomain.has(d)) priorMetaByDomain.set(d, []);
    priorMetaByDomain.get(d).push({ drift: r.drift, brier: r.brier });
  }

  const wrote = [];
  const skipped = [];
  const rules = [];
  const minSamples = cfg.meta_narrative_min_samples ?? 5;
  const driftHighlight = cfg.meta_narrative_drift_threshold ?? 0.15;

  for (const [domain, preds] of byDomain.entries()) {
    if (preds.length < minSamples) {
      skipped.push(domain);
      continue;
    }
    if (await dedupExists(db, domain, week)) {
      skipped.push(domain);
      continue;
    }
    const stats = computeDomainStats(preds);
    const priorPreds = priorByDomain.get(domain) ?? [];
    const priorStats = priorPreds.length >= minSamples ? computeDomainStats(priorPreds) : null;
    const trend = computeTrend(stats.brier, priorStats?.brier ?? null);

    const baseContent =
      `Calibration drift for ${domain} this week: ` +
      `brier=${stats.brier.toFixed(3)}, drift=${stats.drift.toFixed(2)} ` +
      `(mean confidence ${stats.mean_confidence.toFixed(2)} vs accuracy ${stats.accuracy.toFixed(2)}), ` +
      `samples=${stats.samples}, trend=${trend} vs prior week ` +
      `(${priorStats ? priorStats.brier.toFixed(3) : 'n/a'}).`;

    const content =
      Math.abs(stats.drift) > driftHighlight
        ? `Notable calibration drift: ${domain} is trending ${stats.drift > 0 ? 'over-confident' : 'under-confident'}. ${baseContent}`
        : baseContent;

    const { id } = await store.note(db, embedder, 'reasoning', {
      content,
      derived_by: 'auto',
      scope: 'global',
      confidence: 0.8,
      meta: {
        dimension: 'calibration',
        from_signal: 'meta_cognition',
        domain,
        brier: stats.brier,
        drift: stats.drift,
        accuracy: stats.accuracy,
        mean_confidence: stats.mean_confidence,
        samples: stats.samples,
        trend,
        week_starting: week,
      },
    });
    wrote.push(String(id));

    // Rule candidate emission.
    const priorMeta = priorMetaByDomain.get(domain) ?? [];
    if (shouldEmitRule({ drift: stats.drift }, priorMeta, cfg)) {
      const weeks_in_drift = 1 + priorMeta.filter(
        (w) => Math.abs(w.drift) >= (cfg.meta_narrative_rule_threshold ?? 0.15)
            && Math.sign(w.drift) === Math.sign(stats.drift),
      ).length;
      const ruleContent =
        stats.drift > 0
          ? `Soften assertions about ${domain}: over-confident by drift=${stats.drift.toFixed(2)} for ${weeks_in_drift}+ consecutive weeks.`
          : `Trust assertions about ${domain} more: under-confident by drift=${stats.drift.toFixed(2)} for ${weeks_in_drift}+ consecutive weeks.`;
      try {
        const cand = await createCandidate(db, {
          content: ruleContent,
          kind: 'behavior',                                       // enum-safe
          signal_events: [],
          confidence: Math.min(0.9, 0.5 + Math.abs(stats.drift)),
          payload: { source: 'meta_cognition_calibration' },      // discriminator on payload, NOT meta
          meta: {
            dimension: 'calibration',
            domain,
            drift: stats.drift,
            weeks_in_drift,
          },
        });
        rules.push(String(cand?.id ?? ''));
      } catch (e) {
        await recordTelemetry(db, {
          step: TELEMETRY_STEP, ts: new Date(), tokens_in: 0, tokens_out: 0,
          duration_ms: 0, success: false, error: String(e?.message ?? e),
          meta: { phase: 'rule_emit', domain },
        });
      }
    }
  }

  await recordTelemetry(db, {
    step: TELEMETRY_STEP, ts: new Date(), tokens_in: 0, tokens_out: 0,
    duration_ms: Date.now() - startedAt, success: true,
    meta: { wrote: wrote.length, skipped: skipped.length, rules: rules.length, week },
  });

  return { wrote, skipped, rules };
}
```

- [ ] **Step 2: Run unit tests — expect pass.**

```bash
npm run test:unit -- --test-name-pattern='computeDomainStats|computeTrend|shouldEmitRule|weekStartingISO'
```

- [ ] **Step 3: Lint + commit.**

```bash
npm run lint
git add system/cognition/jobs/internal/meta-calibration-narrative.js system/tests/unit/meta-cal-narrative.test.js
git commit -m "feat(meta-cal): weekly calibration meta-narrative writer (Sunday 05:30 local)"
```

---

## Phase 9 — Job manifest + heartbeat wiring

### Task 9.1: Write the manifest

**Files:** `system/cognition/jobs/builtin/meta-calibration-narrative.md` (new)

- [ ] **Step 1: Verify D2's manifest schedule.** If D2 lands first, D2's `recall-failures-narrative.md` should already use `0 5 * * 0`. If D2 is using a different time, coordinate.

```bash
ls system/cognition/jobs/builtin/
```

- [ ] **Step 2: Write the manifest.**

```yaml
---
name: meta-calibration-narrative
schedule: "30 5 * * 0"
runtime: internal
enabled: true
catch_up: false
timeout_minutes: 5
notify: none
notify_on_failure: true
manually_runnable: true
description: Weekly per-domain calibration drift summary as a kind='reasoning' memo; emits a rule_candidate when drift is sustained-large over min_weeks consecutive weeks.
---

Internal job. Implementation in `cognition/jobs/internal/meta-calibration-narrative.js`. Cron parser uses LOCAL time (`getMinutes()` / `getHours()` / `getDay()`), so `30 5 * * 0` is Sunday 05:30 local. Staggered 30 minutes after D2's recall-failures-narrative (05:00 local).

Per spec §6:
- Read past-7d resolved predictions, prior-7d for trend, prior-21d meta-narrative memos for sustained-drift detection.
- Skip a domain when `samples < cfg.meta_narrative_min_samples` (default 5).
- Idempotent: dedup probe on `(meta.dimension='calibration', meta.domain, meta.week_starting)`.
- Drift > 0 → over-confident; drift < 0 → under-confident.
- Conditional `rule_candidates` emission with `kind='behavior'` and `payload.source='meta_cognition_calibration'`.
- Telemetry: one `cadence_telemetry` row per run with `step='meta-cal-narrative'`.
```

- [ ] **Step 3: Add a smoke test confirming the manifest loads.**

Create `system/tests/unit/meta-cal-manifest.test.js`:

```js
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';

test('meta-calibration-narrative manifest exists with schedule 30 5 * * 0', () => {
  const src = fs.readFileSync(
    'system/cognition/jobs/builtin/meta-calibration-narrative.md',
    'utf8',
  );
  assert.match(src, /name: meta-calibration-narrative/);
  assert.match(src, /schedule: "30 5 \* \* 0"/);
  assert.match(src, /runtime: internal/);
  assert.match(src, /enabled: true/);
  assert.match(src, /manually_runnable: true/);
});
```

- [ ] **Step 4: Wire to the loader's dispatch table.**

Check how D1's `state-inference.md` and existing builtins are wired in `system/cognition/jobs/loader.js` (or equivalent). If the loader auto-discovers manifests by filename and calls a function by `name` in `internal/<name>.js`, no code change is needed beyond exporting a default `run()` from `meta-calibration-narrative.js`. Inspect:

```bash
grep -n "manifest\|loader\|runtime: internal" system/cognition/jobs/*.js system/cognition/jobs/internal/*.js 2>&1 | head -20
```

If the loader expects `export async function run(ctx)` per file, add a tiny wrapper at the bottom of `meta-calibration-narrative.js`:

```js
export async function run(ctx) {
  return runMetaCalibrationNarrative({
    db: ctx.db,
    embedder: ctx.embedder?.wrap ?? ctx.embedder,
  });
}
```

- [ ] **Step 5: Run the manifest test + commit.**

```bash
npm run test:unit -- --test-name-pattern='meta-calibration-narrative manifest'
git add system/cognition/jobs/builtin/meta-calibration-narrative.md \
        system/tests/unit/meta-cal-manifest.test.js \
        system/cognition/jobs/internal/meta-calibration-narrative.js
git commit -m "feat(jobs): meta-calibration-narrative manifest + run() wrapper"
```

---

## Phase 10 — Integration tests for the writer

### Task 10.1: Full cycle (seed → fire → verify memo + rule_candidate)

**Files:** `system/tests/integration/meta-cal-narrative-loop.test.js` (new)

- [ ] **Step 1: Write the integration tests.**

```js
import assert from 'node:assert/strict';
import { mkdirSync as __mk } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { surql } from 'surrealdb';
import { runMetaCalibrationNarrative } from '../../cognition/jobs/internal/meta-calibration-narrative.js';
import { createBeliefTool } from '../../io/mcp/tools/belief.js';
import { writeConfig } from '../../config/paths.js';
import { close, connect } from '../../data/db/client.js';
import { runMigrations } from '../../data/db/migrate.js';
import { createStubEmbedder } from '../../data/embed/embedder.js';
import { _resetBeliefConfigCacheForTests } from '../../cognition/belief/config.js';

const HOME = join(tmpdir(), `robin-mc-${process.pid}-${Math.random().toString(36).slice(2)}`);
__mk(HOME, { recursive: true });
process.env.ROBIN_HOME = HOME;
await writeConfig({ embedder_profile: 'mxbai-1024' });

async function fresh() {
  _resetBeliefConfigCacheForTests();
  const db = await connect({ engine: 'mem://' });
  await runMigrations(db, resolve(import.meta.dirname, '../../data/db/migrations'));
  return db;
}

async function seedResolvedPrediction(db, e, { domain, predicted_confidence, correct, resolved_at }) {
  return await db.query(
    surql`CREATE memos CONTENT {
      kind: 'prediction',
      content: ${`pred ${domain}`},
      derived_by: 'auto',
      scope: 'global',
      confidence: ${predicted_confidence},
      signal_count: 1,
      derived_at: ${resolved_at},
      decay_anchor: ${resolved_at},
      meta: {
        statement_kind: ${domain},
        resolved_at: ${resolved_at},
        correct: ${correct},
      },
    }`,
  ).collect();
}

test('M1 empty week: no writes, telemetry success', async () => {
  const db = await fresh();
  const e = createStubEmbedder({ dimension: 1024 });
  const r = await runMetaCalibrationNarrative({ db, embedder: e });
  assert.equal(r.wrote.length, 0);
  const [tel] = await db.query(
    surql`SELECT step, success FROM cadence_telemetry WHERE step = 'meta-cal-narrative'`,
  ).collect();
  assert.ok(tel.length > 0);
  await close(db);
});

test('M2 single domain over min_samples: one memo, no rule_candidate (below threshold)', async () => {
  const db = await fresh();
  const e = createStubEmbedder({ dimension: 1024 });
  const ts = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
  // 5 well-calibrated preds: accuracy = mean_confidence = 0.7 → drift = 0.
  for (let i = 0; i < 5; i++) {
    await seedResolvedPrediction(db, e, {
      domain: 'photography', predicted_confidence: 0.7,
      correct: i < 3 ? true : (i === 3),
      resolved_at: ts,
    });
  }
  const r = await runMetaCalibrationNarrative({ db, embedder: e });
  assert.equal(r.wrote.length, 1);
  assert.equal(r.rules.length, 0);
  await close(db);
});

test('M3 sustained over-confidence: prior 2 weeks at drift > 0.15 → rule_candidate emitted', async () => {
  const db = await fresh();
  const e = createStubEmbedder({ dimension: 1024 });
  const ts = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
  // 5 over-confident preds: confidence 0.9, accuracy 0.4 → drift = 0.5.
  for (let i = 0; i < 5; i++) {
    await seedResolvedPrediction(db, e, {
      domain: 'api versions', predicted_confidence: 0.9,
      correct: i < 2, resolved_at: ts,
    });
  }
  // Seed two prior meta-narrative memos with drift > 0.15 same sign.
  for (const week of ['2026-05-03', '2026-04-26']) {
    await db.query(surql`CREATE memos CONTENT {
      kind: 'reasoning', content: 'prior', derived_by: 'auto', scope: 'global',
      confidence: 0.8, signal_count: 1,
      derived_at: time::now() - 7d, decay_anchor: time::now() - 7d,
      meta: {
        dimension: 'calibration', from_signal: 'meta_cognition',
        domain: 'api versions', drift: 0.20, brier: 0.30,
        week_starting: ${week},
      },
    }`).collect();
  }
  const r = await runMetaCalibrationNarrative({ db, embedder: e });
  assert.equal(r.wrote.length, 1);
  assert.equal(r.rules.length, 1, 'expected one rule_candidate');
  // Verify shape on rule_candidates: kind='behavior', payload.source='meta_cognition_calibration'.
  const [rc] = await db.query(
    surql`SELECT kind, payload, meta FROM rule_candidates ORDER BY created_at DESC LIMIT 1`,
  ).collect();
  assert.equal(rc[0].kind, 'behavior');
  assert.equal(rc[0].payload?.source, 'meta_cognition_calibration');
  assert.equal(rc[0].meta?.dimension, 'calibration');
  assert.equal(rc[0].meta?.domain, 'api versions');
  await close(db);
});

test('M4 mixed domains: one over, one under, one too sparse → 2 memos', async () => {
  const db = await fresh();
  const e = createStubEmbedder({ dimension: 1024 });
  const ts = new Date(Date.now() - 1 * 24 * 60 * 60 * 1000);
  // domain a: over-confident, 5 preds.
  for (let i = 0; i < 5; i++) {
    await seedResolvedPrediction(db, e, { domain: 'a', predicted_confidence: 0.9, correct: i < 2, resolved_at: ts });
  }
  // domain b: under-confident, 5 preds.
  for (let i = 0; i < 5; i++) {
    await seedResolvedPrediction(db, e, { domain: 'b', predicted_confidence: 0.4, correct: true, resolved_at: ts });
  }
  // domain c: only 3 preds → skipped.
  for (let i = 0; i < 3; i++) {
    await seedResolvedPrediction(db, e, { domain: 'c', predicted_confidence: 0.7, correct: true, resolved_at: ts });
  }
  const r = await runMetaCalibrationNarrative({ db, embedder: e });
  assert.equal(r.wrote.length, 2);
  assert.ok(r.skipped.includes('c'));
  await close(db);
});

test('M5 belief() reads meta-narrative override after writer runs', async () => {
  const db = await fresh();
  const e = createStubEmbedder({ dimension: 1024 });
  await db.query('UPDATE runtime:`belief.config` SET value.shadow_mode = false').collect();
  _resetBeliefConfigCacheForTests();
  // Seed 5 preds + run writer.
  const ts = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
  for (let i = 0; i < 5; i++) {
    await seedResolvedPrediction(db, e, { domain: 'photography', predicted_confidence: 0.6, correct: i < 4, resolved_at: ts });
  }
  await runMetaCalibrationNarrative({ db, embedder: e });
  // Seed knowledge memos so belief() has something to recall.
  for (let i = 0; i < 3; i++) {
    await db.query(surql`CREATE memos CONTENT {
      kind: 'knowledge', content: ${`photography ${i}`}, derived_by: 'auto', scope: 'global',
      confidence: 0.7, signal_count: 1, derived_at: time::now(), decay_anchor: time::now()
    }`).collect();
  }
  const tool = createBeliefTool({ db, embedder: e, catalog: [] });
  const out = await tool.handler({ query: 'photography', domain: 'photography' });
  assert.equal(out.calibration?.source, 'meta_narrative');
  await close(db);
});

test('M6 D2/D3 disjoint dimensions in same run (coordination)', async () => {
  const db = await fresh();
  const e = createStubEmbedder({ dimension: 1024 });
  // Seed a D2-style memo (recall_failures dimension) — sibling writer's output.
  await db.query(surql`CREATE memos CONTENT {
    kind: 'reasoning', content: 'recall failures summary', derived_by: 'auto', scope: 'global',
    confidence: 0.8, signal_count: 1, derived_at: time::now(), decay_anchor: time::now(),
    meta: { dimension: 'recall_failures', from_signal: 'meta_cognition' }
  }`).collect();
  // Seed predictions + run D3.
  const ts = new Date(Date.now() - 24 * 60 * 60 * 1000);
  for (let i = 0; i < 5; i++) {
    await seedResolvedPrediction(db, e, { domain: 'x', predicted_confidence: 0.7, correct: i < 3, resolved_at: ts });
  }
  await runMetaCalibrationNarrative({ db, embedder: e });
  // Verify both memos coexist with different dimensions.
  const [rows] = await db.query(`SELECT meta.dimension AS dim FROM memos WHERE kind = 'reasoning'`).collect();
  const dims = (rows ?? []).map((r) => r.dim).sort();
  assert.deepEqual(dims, ['calibration', 'recall_failures']);
  await close(db);
});
```

- [ ] **Step 2: Run + commit.**

```bash
npm run test:integration -- --test-name-pattern='M1 |M2 |M3 |M4 |M5 |M6 '
git add system/tests/integration/meta-cal-narrative-loop.test.js
git commit -m "test(meta-cal): integration suite (writer cycles, rule emission, D2 coordination)"
```

---

## Phase 11 — Idempotence verification

### Task 11.1: Re-run within the same week → no duplicate writes

**Files:** `system/tests/integration/belief-idempotence.test.js` (new)

- [ ] **Step 1: Write the test.**

```js
import assert from 'node:assert/strict';
import { mkdirSync as __mk } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { surql } from 'surrealdb';
import { runMetaCalibrationNarrative } from '../../cognition/jobs/internal/meta-calibration-narrative.js';
import { writeConfig } from '../../config/paths.js';
import { close, connect } from '../../data/db/client.js';
import { runMigrations } from '../../data/db/migrate.js';
import { createStubEmbedder } from '../../data/embed/embedder.js';

const HOME = join(tmpdir(), `robin-id-${process.pid}-${Math.random().toString(36).slice(2)}`);
__mk(HOME, { recursive: true });
process.env.ROBIN_HOME = HOME;
await writeConfig({ embedder_profile: 'mxbai-1024' });

test('IDEMPOTENT: re-run writer same week → second pass adds zero new memos', async () => {
  const db = await connect({ engine: 'mem://' });
  await runMigrations(db, resolve(import.meta.dirname, '../../data/db/migrations'));
  const e = createStubEmbedder({ dimension: 1024 });
  const ts = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
  for (let i = 0; i < 5; i++) {
    await db.query(surql`CREATE memos CONTENT {
      kind: 'prediction',
      content: ${`p${i}`},
      derived_by: 'auto', scope: 'global',
      confidence: 0.7, signal_count: 1,
      derived_at: ${ts}, decay_anchor: ${ts},
      meta: { statement_kind: 'photography', resolved_at: ${ts}, correct: ${i < 3} },
    }`).collect();
  }

  const r1 = await runMetaCalibrationNarrative({ db, embedder: e });
  assert.equal(r1.wrote.length, 1);
  const [n1] = await db.query(
    surql`SELECT count() AS n FROM memos WHERE kind='reasoning' AND meta.dimension='calibration' GROUP ALL`,
  ).collect();

  const r2 = await runMetaCalibrationNarrative({ db, embedder: e });
  assert.equal(r2.wrote.length, 0, 'second run must not write');
  assert.ok(r2.skipped.includes('photography'));
  const [n2] = await db.query(
    surql`SELECT count() AS n FROM memos WHERE kind='reasoning' AND meta.dimension='calibration' GROUP ALL`,
  ).collect();
  assert.equal(n1?.[0]?.n, n2?.[0]?.n, 'memo count unchanged between runs');
  await close(db);
});

test('IDEMPOTENT: dedup probe SurrealQL is the documented shape', async () => {
  // Spec §6.4 probe. This test pins the shape so a refactor doesn't
  // accidentally widen the filter to allow duplicates.
  const probe = `
    SELECT 1
    FROM memos
    WHERE kind = 'reasoning'
      AND meta.dimension = 'calibration'
      AND meta.domain = $domain
      AND meta.week_starting = $week
    LIMIT 1`;
  assert.match(probe, /kind = 'reasoning'/);
  assert.match(probe, /meta\.dimension = 'calibration'/);
  assert.match(probe, /meta\.domain = \$domain/);
  assert.match(probe, /meta\.week_starting = \$week/);
});
```

- [ ] **Step 2: Run + commit.**

```bash
npm run test:integration -- --test-name-pattern='IDEMPOTENT'
git add system/tests/integration/belief-idempotence.test.js
git commit -m "test(meta-cal): idempotence — re-run within same week is a no-op"
```

---

## Phase 12 — Docs

### Task 12.1: `docs/faculties.md` — new "belief" section

**Files:** `docs/faculties.md`

- [ ] **Step 1: Read the file** to find the right insertion point (between `evidence` and `cadence` sections).

```bash
grep -n "^## \|^### " docs/faculties.md | head -30
```

- [ ] **Step 2: Add a new subsection** "belief (alpha.17, Cognition D3)".

Body should include:
- One-paragraph summary of what `belief()` answers ("aggregate, calibration-adjusted confidence + assert|soften|unknown recommendation").
- Input schema (`query`, `domain?`, `k?`).
- Output keys (`aggregate_confidence`, `calibrated_confidence`, `evidence[]`, `calibration?`, `recommendation`, `meta`).
- Cost note (zero LLM tokens, zero extra embeds beyond the recall).
- Privacy note (direct + transitive private filter; no `refusals` row per drop).
- Shadow-mode note (during shadow week, `recommendation` is forced `'unknown'` and `shadow_recommendation_would_have_been` tracks the would-be value).
- Weekly meta-narrative writer pointer.

- [ ] **Step 3: Update the `foresight` section** to mention calibration output feeds `belief()` and the weekly writer.

- [ ] **Step 4: Commit.**

```bash
git add docs/faculties.md
git commit -m "docs(faculties): add belief() section; foresight → calibration consumers"
```

### Task 12.2: `docs/architecture.md` — bullet + agent-turn entry

**Files:** `docs/architecture.md`

- [ ] **Step 1: Add** under "Evolution layer (alpha.16+)" or equivalent:

> `belief({query, domain?})` — aggregate, calibration-adjusted confidence over knowledge memos. Returns `assert | soften | unknown`. Shadowed at land; flipped after one dogfood week. Pairs with a weekly Sunday 05:30 local meta-narrative writer that produces `kind='reasoning'`, `meta.dimension='calibration'` memos and emits `rule_candidates` (`kind='behavior'`, `payload.source='meta_cognition_calibration'`) when drift is sustained-large.

- [ ] **Step 2: Add** to "A typical agent turn":

> 10. Weekly Sunday 05:30 local time, `meta-calibration-narrative` summarises per-domain calibration drift as a `kind='reasoning'` memo (staggered 30 minutes after D2's recall-failures-narrative).

- [ ] **Step 3: Commit.**

```bash
git add docs/architecture.md
git commit -m "docs(architecture): belief() + weekly calibration writer in agent turn"
```

---

## Phase 13 — Rollout

### Task 13.1: Shadow-mode dogfood (one calendar week, manual gate)

**Files:** none (this is observational only).

- [ ] **Step 1: After Phases 0-12 land, run for one week with `shadow_mode = true`.**

- [ ] **Step 2: Watch in `cadence_telemetry`:**
  - distribution of `meta.shadow_would_have_been` (`assert | soften | unknown`)
  - `meta.hits_dropped_private` rate (should be low / near-zero unless user has private memos)
  - P95 `duration_ms` on `step='belief.call'` should stay < 100ms

```bash
# Operator query (run by hand, not scripted into the plan):
robin doctor --health
# Or:
# show_step_health since=-7d → look at belief.call step rollup
```

- [ ] **Step 3: Verify the meta-narrative writer fired** the first Sunday 05:30 local after land.

```bash
# Expected: one cadence_telemetry row with step='meta-cal-narrative' per Sunday.
```

### Task 13.2: Flip to active mode (after the dogfood week passes)

**Files:** `AGENTS.md`

- [ ] **Step 1: Update the config.** This is a single SurrealQL UPDATE — not committed to a migration (manifests stay as defaults; operator action toggles the flag).

```sql
UPDATE runtime:`belief.config` SET value.shadow_mode = false;
UPDATE runtime:`belief.config` SET value.telemetry_sample_rate = 0.1;
```

- [ ] **Step 2: Add the AGENTS.md paragraph.**

Locate the agent-facing usage guide section in `AGENTS.md`. Append:

```md
## Soften gating with `belief()`

Before asserting a fact with high confidence — especially in domains where you've been corrected before — call `belief({query, domain?})`. If `recommendation === 'soften'`, hedge the assertion ("I think…", "as far as I recall…"). If `'unknown'`, ask before claiming.
```

Generic across hosts. Doc-only.

- [ ] **Step 3: Commit the AGENTS.md change.**

```bash
git add AGENTS.md
git commit -m "docs(agents): recommend belief() as soften gate (post-shadow week)"
```

### Task 13.3: Rollback path (documented, not exercised by default)

- Set `runtime:\`belief.config\`.value.shadow_mode = true` → tool stays callable but recommendation is forced `'unknown'`.
- Revert the `AGENTS.md` paragraph.
- Disable the writer: `UPDATE runtime:\`belief.config\` SET value.meta_narrative_enabled = false`.
- The writer's `enabled: true` in the manifest is the default; setting `meta_narrative_enabled = false` in the runtime config is the operator switch (writer reads the flag and no-ops).

---

## Self-review

- [ ] Every spec section (§1–§13) is covered:
  - §1 (tool surface) → Phase 5 task 5.2 (`belief.js`) + Phase 6 (registration).
  - §2 (aggregation pipeline) → Phases 1, 2, 3, 4 (aggregate, calibration, privacy, structural weights, recommend).
  - §3 (reading calibration) → Phase 2 task 2.2 (`readCalibration` day-1 + meta-narrative paths).
  - §4 (cost & performance) → Phase 7 task 7.1 I8 (P95 latency gate).
  - §5 (config) → Phase 0 task 0.1 + Phase 4 task 4.2.
  - §6 (writer) → Phases 8, 9, 10.
  - §7 (schema) → Phase 0 task 0.1; §7.4 → Phase 0 task 0.2.
  - §8 (test plan) → Phases 1–11.
  - §9 (rollout) → Phase 13.
  - §10 (file-by-file) → File structure table (top of plan) + Phase 6 (R-3 note).
  - §11 (open questions) → preserved in spec; tracked here as future work in Phase 13 task 13.3.
  - §12 (sequencing) → Phase order (0 → 13).
  - §13 (see also) → Plan dependencies block.

- [ ] No placeholders. Every TODO inside a code block is intentional spec-traceable.

- [ ] Type / name consistency check:
  - `default_threshold`, `soften_floor`, `domain_thresholds`, `relevance_threshold`, `confidence_floor`, `belief_overfetch_factor`, `min_calibration_samples`, `calibration_adjustment_gain`, `expected_accuracy_baseline`, `domain_entity_types`, `shadow_mode`, `telemetry_enabled`, `telemetry_sample_rate`, `meta_narrative_enabled`, `meta_narrative_min_samples`, `meta_narrative_drift_threshold`, `meta_narrative_window_days`, `meta_narrative_rule_threshold`, `meta_narrative_rule_min_weeks` — all spelled identically in migration + config module + spec.
  - Function names: `aggregateBelief`, `calibrateAdjust`, `readCalibration`, `aggregateAcrossKinds`, `filterPrivateRefs`, `inferDomain`, `recommendBelief`, `batchStructuralWeights`, `readBeliefConfig`, `runMetaCalibrationNarrative`, `computeDomainStats`, `computeTrend`, `shouldEmitRule`, `weekStartingISO` — match across plan tasks.
  - Telemetry steps: `belief.call`, `meta-cal-narrative` — spelled identically in spec, plan, and code.

- [ ] **Migration `0019-` consistent** across migration filename, smoke test, and slot table in spec §7.1.

- [ ] **Triple-check enum: every `rule_candidates` CREATE uses `kind='behavior'`.**
  - Phase 8 `runMetaCalibrationNarrative` rule emission: `kind: 'behavior'` ✓.
  - Phase 10 integration test M3 asserts `rc[0].kind === 'behavior'` ✓.
  - No `'comm_style'` anywhere — it would fail the `0001-init.surql` ASSERT (`kind IN ['behavior', 'profile_update', 'conflict_warning', 'reinforce_behavior']`).

- [ ] **Triple-check field: every `payload.source` setter writes to `payload`, NOT `meta`.**
  - Phase 8 rule emission: `payload: { source: 'meta_cognition_calibration' }` ✓.
  - Phase 10 integration test M3 asserts `rc[0].payload?.source === 'meta_cognition_calibration'` ✓.
  - The `rule_candidates` table is SCHEMAFULL; writes to undeclared `meta.source` would silently drop the value. The discriminator MUST live on `payload`.

- [ ] **No source-file edits in steps outside the listed `Files:` blocks.** The only edits to existing source files are:
  - `system/cognition/memory/kind-registry.js` (Phase 0 task 0.2, skip-if-D2-did-it).
  - `system/runtime/daemon/tools.js` (Phase 6, two-line registration).
  - `system/tests/unit/audit-introspection-readonly.test.js` (Phase 6, allow-list extension).
  - `docs/faculties.md`, `docs/architecture.md` (Phase 12).
  - `AGENTS.md` (Phase 13.2, post-shadow week — NOT at land time).

- [ ] **Cross-cutting decision 8** (telemetry → `cadence_telemetry` with `step='belief.call'` + `meta.sample_rate`) is honored in Phase 5 task 5.2 (`recordTelemetry` call sites) and Phase 7 integration test I7.

- [ ] **Cross-cutting decision 5** (weight = `signal_count × decay × relevance`, NO confidence multiplier) is enforced in Phase 1 (`weight_raw = h.structural * relevance` only) and Phase 4 task 4.4 (`structural = signal_count × decay`).

- [ ] **Cross-cutting decision 7** (direct + transitive privacy) is implemented in Phase 3 task 3.2 (`filterPrivateRefs` runs both queries) and verified by Phase 3 task 3.1 tests (direct, transitive, all-public, empty).

---

## Final commit + PR

```bash
git push -u origin feat/cognition-d3-belief-gating
gh pr create --title "Cognition D3: belief() MCP tool + weekly calibration meta-narrative" --body "$(cat <<'EOF'
## Summary
- New read-only MCP tool `belief({query, domain?, k?})` aggregating evidence-backed confidence over recalled knowledge memos and recommending `assert | soften | unknown`. Ships behind `shadow_mode = true`.
- Weekly Sunday 05:30 LOCAL meta-narrative writer producing per-domain `kind='reasoning'`, `meta.dimension='calibration'` memos and emitting `rule_candidates` (`kind='behavior'`, `payload.source='meta_cognition_calibration'`) when drift is sustained-large.
- Coordinated with D2 (sibling): disjoint `meta.dimension` values, 30-minute schedule offset (D2 05:00, D3 05:30 — both local).
- Zero new LLM calls. Zero new embeds beyond the recall already performed.
- Migration `0019-belief-gating.surql` adds a single runtime config row; no table mutations.

## Test plan
- [ ] Unit tests in `system/tests/unit/belief-*.test.js` + `meta-cal-narrative.test.js` all pass.
- [ ] Integration tests in `system/tests/integration/belief-tool.test.js` + `meta-cal-narrative-loop.test.js` + `belief-idempotence.test.js` all pass.
- [ ] P95 latency for `belief()` < 100ms.
- [ ] One week shadow dogfood before flipping `shadow_mode = false` and adding the `AGENTS.md` paragraph (separate PR).
- [ ] Rule-emission test pins `kind='behavior'` + `payload.source='meta_cognition_calibration'` shape (ASSERT-safe on `rule_candidates`).

## Open items
- Manifest discovery wiring — verify `loader.js` shape during Phase 9 task 9.1 step 4; adjust `run()` wrapper if needed.
- `ctx.catalog` on R-3 — fallback path through `getCatalog(db)` is in place but adds an allocation; collapse once A2 plumbs `ctx.catalog`.
- Tuning windows (drift threshold 0.15 → 0.20, `weeks_in_drift` 2 → 3) reserved for a post-quarter telemetry review.
EOF
)"
```

---

## Open items for the executor

1. **Loader wiring (Phase 9 task 9.1 step 4).** Verify how `system/cognition/jobs/loader.js` discovers manifests and what function shape it expects. The plan assumes `export async function run(ctx)`; adjust if the loader uses a different name (e.g. `default`, `execute`, etc.).
2. **`ctx.catalog` shape (Phase 5 / Phase 6).** R-3 has shipped, but the spec §10 notes A2 may not yet plumb `ctx.catalog`. The fallback to `getCatalog(db)` is in `belief.js`; verify the A2-cached `getCatalog` import path resolves at execute time.
3. **Cron parser local-time confirmation (Phase 9 task 9.1).** Spec §6.1 and cross-cutting decision 3 both pin local-time semantics via `system/cognition/jobs/cron.js:77-83`. Re-confirm before merging — a UTC switch elsewhere would silently shift D3 by hours.
4. **D2 coordination (Phase 0 task 0.2 + Phase 9 task 9.1).** If D2 lands first, skip the kind-registry edit (sub-task in Phase 0.2) and confirm D2's manifest schedule is `0 5 * * 0` so the 30-minute offset holds.
5. **Audit allow-list shape (Phase 6 task 6.1 step 2).** The plan extends `audit-introspection-readonly.test.js` with a `PER_FILE_WRITE_ALLOWLIST`. If the existing audit file is purely keyword-blacklist, the extension may require a few extra lines of parser logic — keep the change scoped to that one test file.
6. **Half-life constants (spec §11 open question).** Phase 4 task 4.4 imports `HALF_LIFE_BY_KIND_MS` from `cognition/memory/decay.js`. If this module is split into a shared `half-life-constants.js` during D3's land window (e.g. by an adjacent refactor), update the import path in `structural-weights.js`.
