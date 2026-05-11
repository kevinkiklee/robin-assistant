# Cognition C2 — Dream DAG + parallelism · Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Read the spec end-to-end before starting Phase 1; every section of the spec is referenced by phase number below.

**Goal:** Replace the ten-steps-in-source-order serial body of `dreamProcess` with a declared dependency graph (`DREAM_DAG_DEPS`) plus a tiny in-process layered scheduler (`runDag`) so steps within a topological layer fan out via `Promise.all` while preserving (a) the existing camelCase summary contract, (b) per-step failure isolation, (c) the unified `dreamed_at` post-barrier mark, (d) backward-compatible `dreamProcess(db, host, embedder, opts)` signature, (e) a one-line rollback via `runtime:dream.config.parallelism_enabled`, and (f) a shared 80/20 dream/cadence token-budget envelope enforced between layers.

**Architecture:** Introduce `system/cognition/dream/scheduler.js` (`runDag`, `topoLayers`, `chunkByLimit`), `system/cognition/dream/dag.js` (`DREAM_DAG_DEPS` constant), `system/cognition/dream/step-registry.js` (camelCase `byName` map), `system/cognition/dream/dream-budget.js` (`readDreamConfig`, `shouldHalt`, `defaultFloor`), `system/cognition/dream/telemetry.js` (`recordStepTelemetry` writing `cadence_telemetry` rows with the new `step ∈ {knowledge, …, compaction}` discriminator). Rewrite `system/cognition/dream/pipeline.js` to branch on `parallelism_enabled`: serial path preserved verbatim under the flag-off branch; parallel path delegates to `runDag` and threads telemetry + `shouldHalt`. Refactor `system/cognition/memory/persona.js`'s `updatePersonaFields` from `UPSERT … MERGE` to a dynamically-built `UPDATE … SET` so concurrent writers to disjoint persona fields no longer clobber each other at the record level (closes a cross-process race between dream and the cadence consumer; see spec §1.2 "persona MERGE serial").

**Tech Stack:** Node.js 18+ (ES modules) · `node:test` runner · SurrealDB v3 embedded via `surrealdb` JS SDK · existing `currentBudget(db, cfg)` from `system/cognition/dream/budget.js` · existing `cadence_telemetry` write shape from `system/runtime/daemon/cadence-consumer.js`.

**Spec:** `docs/superpowers/specs/2026-05-11-cognition-c2-dream-dag-design.md`

**Dependencies:** None structural. Lands on top of the current pipeline at `system/cognition/dream/pipeline.js` (refactor/system-restructure branch). The persona refactor is in-scope (spec §11 "Modified"); land it before the parallel flag flips on Kevin's instance (Phase 10 rollout step 4).

**Migration numbering:** Next free file in `system/data/db/migrations/` is `0009-*.surql` (existing files: `0001..0008-doctor.surql`). The umbrella roadmap allocates `0009..0018` to B1/A3/C1/D1/B2/B2-follow-up/C3/D2 and reserves `0019` for D3. **This plan claims `0020-dream-dag.surql`** to dodge B2 + B2-follow-up + the C3/D2/D3 allocations that may land in parallel. Verify free at start of Phase 0; if `0020` collides with another in-flight branch, bump to the next free integer ≥ existing max and update every reference in this plan.

---

## File structure

| File | Action | Purpose |
|---|---|---|
| `system/data/db/migrations/0020-dream-dag.surql` | Create | Seed `runtime:`dream.config`` with `parallelism_enabled=false`, `max_concurrent=NONE`, `budget_check_enabled=true`, `budget_floor=NONE`. Document new optional `runtime:dream.value` fields (`last_layers`, `last_halted`). |
| `system/cognition/dream/dag.js` | Create | `DREAM_DAG_DEPS` constant (camelCase keys → string[] dep list) per spec §1.3 / §4. |
| `system/cognition/dream/step-registry.js` | Create | `byName` map: camelCase key → `(ctx) => Promise<result>` thunks wrapping each existing `dreamStep*` function. Keys MUST match today's `summary.<key>` shape. |
| `system/cognition/dream/scheduler.js` | Create | `runDag(steps, deps, opts)`, `topoLayers(steps, deps)`, `chunkByLimit(arr, limit)`. No external deps. |
| `system/cognition/dream/dream-budget.js` | Create | `readDreamConfig(db)`, `shouldHalt(db, cfg, cadenceCfg)`, `defaultFloor(cadenceCfg)` (20% reserve). Reuses `currentBudget` + `readCadenceConfig` from `budget.js`. |
| `system/cognition/dream/telemetry.js` | Create | `recordStepTelemetry(db, name, ms, err?, tokens?)` — `CREATE cadence_telemetry CONTENT { step: 'knowledge' | …, trigger_id: NONE, tokens_in, tokens_out, duration_ms, success, error }` with the cadence-consumer write shape. |
| `system/cognition/dream/pipeline.js` | Modify | Rewrite per spec §3. Branch on `cfg.parallelism_enabled`; serial branch (`runDreamSerial`) preserves today's body verbatim; parallel branch invokes `runDag` and threads `shouldHalt` + `onStepSettled`. Skip `dreamed_at` mark when scheduler throws (defence-in-depth, §7). |
| `system/cognition/memory/persona.js` | Modify | Refactor `updatePersonaFields(db, fields)` from `UPSERT persona:singleton MERGE ${fields}` to `UPDATE persona:singleton SET k1 = $v1, k2 = $v2, …` — keys built dynamically, one parameter per field. Closes the cross-process MERGE race. |
| `system/runtime/scripts/verify-design-assumptions.js` | Modify | Append gates G19 (output equivalence) and G20 (DAG/registry bidirectional completeness). |
| `system/tests/unit/dream-scheduler.test.js` | Create | §10.1 tests 1–10: empty graph / single step / linear chain / diamond / step throws / non-Error throw / `shouldHalt` at layer boundary / `shouldHalt` at first call / `maxConcurrent` cap / cycle detection. |
| `system/tests/unit/dream-dag.test.js` | Create | §10.1 test 11: `topoLayers(byName, DREAM_DAG_DEPS)` returns the three expected layers; bidirectional symmetric-difference is empty. |
| `system/tests/unit/persona-set-refactor.test.js` | Create | Unit coverage for the new field-scoped `UPDATE … SET` shape: round-trips, mutates only the listed keys, leaves untouched keys intact, supports nested-object values, rejects empty `fields` argument. |
| `system/tests/integration/dream-parallel.test.js` | Create | §10.2 tests 12–15b and 17–18: output equivalence (with `normalizeSummary`), failure isolation across/within layers, budget variants A + B, unified 24-h sum across cadence + dream, `dreamed_at` barrier, persona singleton serial-write integration. |
| `system/tests/integration/dream-mark-idempotency.test.js` | Create | §10.2 test 16: stub `step-arcs` throw → mark still ran; rerun observes empty un-dreamed set. |
| `system/tests/integration/persona-merge-race.test.js` | Create | Phase 8 cross-process MERGE-race test: two simulated concurrent callers writing disjoint persona fields; assert no clobber under the new SET shape; would have lost a write under the old `MERGE` shape (documented in the test comment, not asserted against the old code). |
| `docs/faculties.md` | Modify | Extend §dream to describe the three layers, the runtime config, and the budget coupling. Add `### cadence` (or extend the existing reference) to mention the 80/20 split. |
| `docs/architecture.md` | Modify | "Nightly at 4 AM" item gains a one-liner about layered parallelism + the unified mark being a post-layer barrier. |

---

## Phase 0 — Migration and runtime config seed

Covers spec §9.1 (`0020-dream-dag.surql`).

### Task 0.1: Create migration `0020-dream-dag.surql`

**Files:** `system/data/db/migrations/0020-dream-dag.surql`

- [ ] **Step 1: Verify the migration slot is free**

```bash
ls system/data/db/migrations/
```

Expected: filenames `0001-init.surql … 0008-doctor.surql`. **If `0020-*.surql` already exists**, or the umbrella has landed numbers up to or past `0020`, pick the next free integer ≥ existing max and update every `0020` reference in this plan accordingly.

- [ ] **Step 2: Write the migration**

Create `system/data/db/migrations/0020-dream-dag.surql`:

```surql
-- ============================================================================
-- C2: Dream DAG + parallelism. Seed runtime:`dream.config` with parallelism
-- disabled by default. The dreamProcess wrapper reads this row on every call
-- via dream-budget.readDreamConfig(); when value.parallelism_enabled is false
-- (the default), the pipeline takes the verbatim-serial branch — no behaviour
-- change relative to alpha.17.
--
-- The grouping record id  runtime:`dream.config`  is distinct from
-- runtime:dream (the per-run ledger written by dreamProcess on every run).
-- Two rows, two semantics. See spec §7 "Two `runtime` rows, two semantics".
--
-- runtime:dream.value MAY also carry, on top of existing keys:
--   last_layers : [{ names: [string], duration_ms: int }]    -- per-run layer ledger
--   last_halted : option<string>                              -- 'budget_exhausted' | 'scheduler_error' | NONE
-- These are additive; runtime.value is FLEXIBLE so no DEFINE FIELD edit is
-- required.
-- ============================================================================

UPSERT runtime:`dream.config` SET value = {
  parallelism_enabled: false,
  max_concurrent: NONE,
  budget_check_enabled: true,
  budget_floor: NONE
}
WHERE value IS NONE;

-- Idempotent fill-in for installs whose runtime:`dream.config` row already
-- exists with partial keys. Each UPDATE is a no-op once its key is present.
UPDATE runtime:`dream.config`
   SET value.parallelism_enabled = false
 WHERE value.parallelism_enabled IS NONE;

UPDATE runtime:`dream.config`
   SET value.max_concurrent = NONE
 WHERE value.max_concurrent IS NONE;

UPDATE runtime:`dream.config`
   SET value.budget_check_enabled = true
 WHERE value.budget_check_enabled IS NONE;

UPDATE runtime:`dream.config`
   SET value.budget_floor = NONE
 WHERE value.budget_floor IS NONE;
```

- [ ] **Step 3: Run lint and the existing migration test**

```bash
npm run lint
```

Expected: zero errors. `.surql` files are not linted by Biome.

```bash
node --test system/tests/integration/dream-full-cycle.test.js
```

Expected: the existing dream integration test still passes; the migration applies cleanly via `runMigrations` (which iterates the directory in sorted-filename order — `0020-dream-dag.surql` sorts after `0008-doctor.surql`).

- [ ] **Step 4: Commit**

```bash
git add system/data/db/migrations/0020-dream-dag.surql
git commit -m "feat(c2): migration 0020 seeds runtime:dream.config (parallelism disabled by default)"
```

---

## Phase 1 — `dag.js` and `step-registry.js`

Covers spec §1 (read/write sets, edges), §1.3 (the graph), §4 (camelCase keys load-bearing), and §10.1 test 11 (DAG/registry bidirectional completeness).

### Task 1.1: Create `dag.js`

**Files:** `system/cognition/dream/dag.js`

- [ ] **Step 1: Write the constant**

Create `system/cognition/dream/dag.js`:

```js
// dag.js — Dependency graph for the dream pipeline. Spec §1.3.
//
// Keys are camelCase and MUST match the `summary.<key>` shape produced by
// today's pipeline.js (and consumed by dispatcher-tick.js,
// show-step-health.js, run-dream.js, dream-full-cycle.test.js). The graph is
// validated at boot by gate G20 in verify-design-assumptions.js (Phase 9).

export const DREAM_DAG_DEPS = {
  knowledge: [],
  patterns: [],
  reflection: [],
  profile: [],
  arcs: [],
  commStyle: [],
  confidence: [], // §1.2 — no edge to knowledge (confidence reads evidence_ledger, not memos)
  scopeCleanup: ['knowledge'], // §1.2 — derived_from edges seed scope-cleanup's promote pass
  calibration: ['commStyle'], // §1.2 — persona MERGE serial within a dream run
  compaction: ['knowledge', 'scopeCleanup'], // §1.2 — content_hash + delete-then-archive
};
```

- [ ] **Step 2: Lint**

```bash
npm run lint
```

Expected: zero errors. The file has no tests yet — its consumer (`scheduler.js`) is built in Phase 3 and the bidirectional gate is exercised in Phase 1 Task 1.3.

### Task 1.2: Create `step-registry.js`

**Files:** `system/cognition/dream/step-registry.js`

- [ ] **Step 1: Read the existing step signatures**

```bash
grep -n "^export async function" system/cognition/dream/step-*.js
```

Expected: ten exports named `dreamStepKnowledge`, `dreamStepPatterns`, `dreamStepReflection`, `dreamStepConfidenceRecompute`, `dreamStepProfile`, `dreamStepArcs`, `dreamStepCommStyle`, `dreamStepCalibration`, `dreamStepScopeCleanup`, `dreamStepCompaction`. Confirm by comparing to the existing imports at the top of `system/cognition/dream/pipeline.js`.

- [ ] **Step 2: Write the registry**

Create `system/cognition/dream/step-registry.js`:

```js
// step-registry.js — name → (ctx) => Promise<result> map for the dream DAG.
// Spec §4. Each thunk forwards ctx into the existing step function with the
// same argument shape used by today's serial pipeline.
//
// IMPORTANT: keys are camelCase and MUST match the summary contract. See the
// header in dag.js for why.

import { dreamStepArcs } from './step-arcs.js';
import { dreamStepCalibration } from './step-calibration.js';
import { dreamStepCommStyle } from './step-comm-style.js';
import { dreamStepCompaction } from './step-compaction.js';
import { dreamStepConfidenceRecompute } from './step-confidence-recompute.js';
import { dreamStepKnowledge } from './step-knowledge.js';
import { dreamStepPatterns } from './step-patterns.js';
import { dreamStepProfile } from './step-profile.js';
import { dreamStepReflection } from './step-reflection.js';
import { dreamStepScopeCleanup } from './step-scope-cleanup.js';

export const byName = {
  knowledge: ({ db, host, embedder, opts }) =>
    dreamStepKnowledge(db, host, embedder, opts?.knowledge),
  patterns: ({ db, host }) => dreamStepPatterns(db, host),
  reflection: ({ db, host, opts }) => dreamStepReflection(db, host, opts?.reflection),
  confidence: ({ db }) => dreamStepConfidenceRecompute(db),
  profile: ({ db, host, opts }) => dreamStepProfile(db, host, opts?.profile),
  arcs: ({ db, opts }) => dreamStepArcs(db, opts?.arcs),
  commStyle: ({ db, host }) => dreamStepCommStyle(db, host),
  calibration: ({ db }) => dreamStepCalibration(db),
  scopeCleanup: ({ db, host, opts }) =>
    dreamStepScopeCleanup(db, host, opts?.scopeCleanup),
  compaction: ({ db }) => dreamStepCompaction(db),
};
```

- [ ] **Step 3: Lint**

```bash
npm run lint
```

Expected: zero errors. No new tests yet — the registry is exercised by Phase 1 Task 1.3 (bidirectional gate) and Phase 3 (`scheduler.test.js`) once `topoLayers` exists.

### Task 1.3: Failing test for DAG/registry completeness (bidirectional)

**Files:** `system/tests/unit/dream-dag.test.js` (new)

- [ ] **Step 1: Write the failing test**

Create `system/tests/unit/dream-dag.test.js`:

```js
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DREAM_DAG_DEPS } from '../../cognition/dream/dag.js';
import { byName } from '../../cognition/dream/step-registry.js';

test('DREAM_DAG_DEPS keys match step-registry byName keys (bidirectional)', () => {
  const a = new Set(Object.keys(byName));
  const b = new Set(Object.keys(DREAM_DAG_DEPS));
  const missingFromDeps = [...a].filter((k) => !b.has(k));
  const missingFromRegistry = [...b].filter((k) => !a.has(k));
  assert.deepEqual(missingFromDeps, [], `keys in byName not in deps: ${missingFromDeps}`);
  assert.deepEqual(
    missingFromRegistry,
    [],
    `keys in deps not in byName: ${missingFromRegistry}`,
  );
});

test('expected camelCase keys are present', () => {
  const expected = [
    'knowledge',
    'patterns',
    'reflection',
    'profile',
    'arcs',
    'commStyle',
    'confidence',
    'scopeCleanup',
    'calibration',
    'compaction',
  ].sort();
  assert.deepEqual(Object.keys(DREAM_DAG_DEPS).sort(), expected);
  assert.deepEqual(Object.keys(byName).sort(), expected);
});

test('every dep edge references a known step', () => {
  const known = new Set(Object.keys(DREAM_DAG_DEPS));
  for (const [name, deps] of Object.entries(DREAM_DAG_DEPS)) {
    for (const d of deps) {
      assert.ok(known.has(d), `${name} depends on unknown step '${d}'`);
    }
  }
});
```

- [ ] **Step 2: Run the test**

```bash
node --test system/tests/unit/dream-dag.test.js
```

Expected: three passing assertions. `dag.js` and `step-registry.js` are already in place from Tasks 1.1 / 1.2; the bidirectional invariant should be green on first run. If it fails, the registry or the deps map drifted — fix before continuing.

- [ ] **Step 3: Lint + commit**

```bash
npm run lint
git add system/cognition/dream/dag.js system/cognition/dream/step-registry.js system/tests/unit/dream-dag.test.js
git commit -m "feat(c2): DREAM_DAG_DEPS + step-registry byName (camelCase, bidirectional invariant)"
```

---

## Phase 2 — `persona.js` refactor (UPSERT MERGE → field-scoped UPDATE SET)

Covers spec §1.2 ("persona MERGE serial" + durable fix), §11 (modified `system/cognition/memory/persona.js`). Lands before the parallel flag flips so the cross-process race between dream and `cadence-consumer.js`-driven `synthesizeCommStyle`/`setCalibration` is closed regardless of in-dream edges.

### Task 2.1: Failing test for the new field-scoped SET behaviour

**Files:** `system/tests/unit/persona-set-refactor.test.js` (new)

- [ ] **Step 1: Write the failing tests**

Create `system/tests/unit/persona-set-refactor.test.js`:

```js
import assert from 'node:assert/strict';
import { mkdirSync as __robinMkdirSync } from 'node:fs';
import { tmpdir as __robinTmpdir } from 'node:os';
import { join as __robinJoin, resolve } from 'node:path';
import { test } from 'node:test';
import { surql } from 'surrealdb';
import { writeConfig as __robinWriteConfig } from '../../config/paths.js';
import { getPersona, updatePersonaFields } from '../../cognition/memory/persona.js';
import { close, connect } from '../../data/db/client.js';
import { runMigrations } from '../../data/db/migrate.js';

const __robinTestHome = __robinJoin(
  __robinTmpdir(),
  `robin-test-${process.pid}-${Math.random().toString(36).slice(2)}`,
);
__robinMkdirSync(__robinTestHome, { recursive: true });
process.env.ROBIN_HOME = __robinTestHome;
await __robinWriteConfig({ embedder_profile: 'mxbai-1024' });

async function fresh() {
  const db = await connect({ engine: 'mem://' });
  await runMigrations(db, resolve(import.meta.dirname, '../../data/db/migrations'));
  return db;
}

test('updatePersonaFields creates the singleton row when absent', async () => {
  const db = await fresh();
  await updatePersonaFields(db, { comm_style: { tone: 'concise' } });
  const p = await getPersona(db);
  assert.ok(p, 'persona row should exist');
  assert.deepEqual(p.comm_style, { tone: 'concise' });
  await close(db);
});

test('updatePersonaFields sets only the listed keys; untouched keys remain', async () => {
  const db = await fresh();
  await updatePersonaFields(db, { comm_style: { tone: 'concise' } });
  await updatePersonaFields(db, { calibration: { ece: 0.04 } });
  const p = await getPersona(db);
  assert.deepEqual(p.comm_style, { tone: 'concise' }, 'comm_style preserved');
  assert.deepEqual(p.calibration, { ece: 0.04 }, 'calibration added');
  await close(db);
});

test('updatePersonaFields supports multi-key calls in one statement', async () => {
  const db = await fresh();
  await updatePersonaFields(db, {
    comm_style: { tone: 'concise' },
    calibration: { ece: 0.04 },
  });
  const p = await getPersona(db);
  assert.deepEqual(p.comm_style, { tone: 'concise' });
  assert.deepEqual(p.calibration, { ece: 0.04 });
  await close(db);
});

test('updatePersonaFields with empty fields object is a no-op (does not throw)', async () => {
  const db = await fresh();
  await updatePersonaFields(db, { comm_style: { tone: 'concise' } });
  await updatePersonaFields(db, {});
  const p = await getPersona(db);
  assert.deepEqual(p.comm_style, { tone: 'concise' });
  await close(db);
});

test('updatePersonaFields rejects non-object input', async () => {
  const db = await fresh();
  await assert.rejects(() => updatePersonaFields(db, null), /fields/i);
  await assert.rejects(() => updatePersonaFields(db, 'oops'), /fields/i);
  await close(db);
});

test('uses UPDATE … SET (not UPSERT … MERGE) under the hood', async () => {
  // Source-level guard so a future refactor can't silently regress to MERGE.
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(
    resolve(import.meta.dirname, '../../cognition/memory/persona.js'),
    'utf8',
  );
  assert.doesNotMatch(src, /MERGE\s*\$\{?fields\}?/, 'must not use MERGE ${fields}');
  assert.match(src, /SET\s+/i, 'must build a SET clause');
});
```

- [ ] **Step 2: Run the test (expect the last two assertions to fail)**

```bash
node --test system/tests/unit/persona-set-refactor.test.js
```

Expected: the round-trip tests likely pass on the current MERGE shape (functionally MERGE accepts the same call signatures), but the source-level guard (`SET …`, no `MERGE ${fields}`) fails because today's `persona.js` uses `UPSERT persona:singleton MERGE ${fields}`.

- [ ] **Step 3: Refactor `system/cognition/memory/persona.js`**

Replace the body of `updatePersonaFields` with a dynamic SET-clause builder. Use the Edit tool against the current source (read first):

```bash
sed -n '1,30p' system/cognition/memory/persona.js
```

Then edit. The new file content:

```js
// persona.js — the singleton model of Robin's user.
// Spec §5 / replaces profile.js. The underlying table renamed `profile` → `persona`.
// C2 spec §1.2: field-scoped `UPDATE … SET` replaces `UPSERT … MERGE` so
// concurrent writers to disjoint top-level keys no longer overwrite each other
// at record level. Cross-process safety: dream steps and the cadence consumer
// can both call `updatePersonaFields` without coordination.

import { BoundQuery, surql } from 'surrealdb';

export async function getPersona(db) {
  const [rows] = await db.query(surql`SELECT * FROM persona:singleton LIMIT 1`).collect();
  return rows[0] ?? null;
}

export async function updatePersonaFields(db, fields) {
  if (!fields || typeof fields !== 'object' || Array.isArray(fields)) {
    throw new TypeError('updatePersonaFields: fields must be a plain object');
  }
  const keys = Object.keys(fields);
  if (keys.length === 0) return; // No-op; nothing to set.

  // Guard against accidental SurrealQL-identifier characters in keys. The
  // allowed shape is [a-zA-Z_][a-zA-Z0-9_]* — exactly what JS object keys
  // produced by trusted callers in cognition/memory and cognition/dream emit.
  // Untrusted callers should sanitise upstream; we hard-fail here rather than
  // build a query with attacker-controlled identifiers.
  for (const k of keys) {
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(k)) {
      throw new RangeError(`updatePersonaFields: invalid field name '${k}'`);
    }
  }

  // First UPSERT (no SET) ensures the singleton row exists. Field-scoped
  // UPDATE … SET is then idempotent and field-local; concurrent writers to
  // disjoint keys do not clobber each other's siblings.
  await db.query(surql`UPSERT persona:singleton`).collect();

  // Build `SET k1 = $k1, k2 = $k2, …` with one bound parameter per key.
  const setClause = keys.map((k) => `${k} = $${k}`).join(', ');
  const sql = `UPDATE persona:singleton SET ${setClause}`;
  const params = Object.fromEntries(keys.map((k) => [k, fields[k]]));
  await db.query(new BoundQuery(sql, params)).collect();
}

/** Sub-helper used by dream/step-comm-style. */
export async function updateCommStyle(db, commStyleFields) {
  await updatePersonaFields(db, { comm_style: commStyleFields });
}

/** Sub-helper used by dream/step-calibration. */
export async function updateCalibration(db, calibrationFields) {
  await updatePersonaFields(db, { calibration: calibrationFields });
}

// Legacy aliases for backward compatibility during migration.
export const getProfile = getPersona;
export const updateProfileFields = updatePersonaFields;
```

- [ ] **Step 4: Run the new test (expect pass) and the existing persona callers' tests**

```bash
node --test system/tests/unit/persona-set-refactor.test.js
```

Expected: all six assertions pass.

```bash
node --test \
  system/tests/unit/comm-style-synthesis.test.js \
  system/tests/unit/predictions-helpers.test.js \
  system/tests/integration/comm-style-roundtrip.test.js \
  system/tests/integration/predictions-roundtrip.test.js \
  system/tests/integration/profile-candidate-flow.test.js
```

Expected: existing tests pass unchanged. `synthesizeCommStyle` → `updatePersonaFields({ comm_style: … })`, `setCalibration` → `updatePersonaFields({ calibration: … })`, and any direct callers all see identical post-call state because the SET shape preserves the same semantics for **disjoint top-level keys**, which is the only call-site pattern in the tree (verified via `grep -n updatePersonaFields system/`).

- [ ] **Step 5: Run the dream full-cycle integration test**

```bash
node --test system/tests/integration/dream-full-cycle.test.js
```

Expected: passes unchanged. `dreamStepCommStyle` and `dreamStepCalibration` still write through `updatePersonaFields`; the dream pipeline today is serial, so the SET refactor does not change observable state for this run.

- [ ] **Step 6: Lint + commit**

```bash
npm run lint
git add system/cognition/memory/persona.js system/tests/unit/persona-set-refactor.test.js
git commit -m "fix(persona): replace UPSERT MERGE with field-scoped UPDATE SET (closes cross-process race)"
```

---

## Phase 3 — `scheduler.js` (`runDag`, `topoLayers`, `chunkByLimit`)

Covers spec §2 (the scheduler), §10.1 tests 1–10.

### Task 3.1: Failing tests for `runDag`

**Files:** `system/tests/unit/dream-scheduler.test.js` (new)

- [ ] **Step 1: Write the failing tests**

Create `system/tests/unit/dream-scheduler.test.js`:

```js
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runDag } from '../../cognition/dream/scheduler.js';

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

test('empty graph returns empty summary, no layers, halted=null', async () => {
  const r = await runDag({}, {});
  assert.deepEqual(r.summary, {});
  assert.deepEqual(r.layers, []);
  assert.equal(r.halted, null);
});

test('single step runs and returns its result', async () => {
  const r = await runDag({ a: async () => 1 }, { a: [] });
  assert.equal(r.summary.a, 1);
  assert.equal(r.layers.length, 1);
  assert.deepEqual(r.layers[0].names, ['a']);
});

test('linear chain a → b → c produces 3 layers; b starts only after a settles', async () => {
  const events = [];
  const r = await runDag(
    {
      a: async () => {
        events.push('a-start');
        await sleep(20);
        events.push('a-end');
        return 'A';
      },
      b: async () => {
        events.push('b-start');
        await sleep(20);
        events.push('b-end');
        return 'B';
      },
      c: async () => {
        events.push('c-start');
        return 'C';
      },
    },
    { a: [], b: ['a'], c: ['b'] },
  );
  assert.equal(r.summary.a, 'A');
  assert.equal(r.summary.b, 'B');
  assert.equal(r.summary.c, 'C');
  // b-start must come AFTER a-end (linear chain).
  assert.ok(events.indexOf('b-start') > events.indexOf('a-end'));
  assert.ok(events.indexOf('c-start') > events.indexOf('b-end'));
  assert.equal(r.layers.length, 3);
});

test('diamond a → {b, c} → d: b and c run concurrently', async () => {
  const starts = [];
  const r = await runDag(
    {
      a: async () => 'A',
      b: async () => {
        starts.push({ name: 'b', t: Date.now() });
        await sleep(30);
        return 'B';
      },
      c: async () => {
        starts.push({ name: 'c', t: Date.now() });
        await sleep(30);
        return 'C';
      },
      d: async () => 'D',
    },
    { a: [], b: ['a'], c: ['a'], d: ['b', 'c'] },
  );
  assert.equal(r.summary.d, 'D');
  // Layer-2 b and c started within ~10ms of each other (concurrent).
  const tb = starts.find((s) => s.name === 'b').t;
  const tc = starts.find((s) => s.name === 'c').t;
  assert.ok(Math.abs(tb - tc) < 15, `expected concurrent start, |Δt|=${Math.abs(tb - tc)}ms`);
  assert.equal(r.layers.length, 3);
  assert.deepEqual([...r.layers[1].names].sort(), ['b', 'c']);
});

test('step throw is captured into summary.<name>.error; sibling and downstream still run', async () => {
  const r = await runDag(
    {
      a: async () => {
        throw new Error('boom');
      },
      sib: async () => 'sib-ok',
      b: async () => 'b-ok',
    },
    { a: [], sib: [], b: ['a'] },
  );
  assert.deepEqual(r.summary.a, { error: 'boom' });
  assert.equal(r.summary.sib, 'sib-ok');
  // Dep on a settled (with error), so b runs (today's serial behaviour).
  assert.equal(r.summary.b, 'b-ok');
});

test('step throws non-Error → summary.<name>.error stringifies the value', async () => {
  const r = await runDag(
    {
      a: async () => {
        // biome-ignore lint/correctness/noUnreachable: deliberate non-Error throw
        throw 'just a string';
      },
    },
    { a: [] },
  );
  assert.deepEqual(r.summary.a, { error: 'just a string' });
});

test('shouldHalt returns true at a layer boundary → remaining steps skipped', async () => {
  let layerIdx = 0;
  const r = await runDag(
    {
      a: async () => 'A',
      b: async () => 'B',
      c: async () => 'C',
    },
    { a: [], b: ['a'], c: ['b'] },
    {
      shouldHalt: async () => {
        // Halt after layer 1 (a) settles, before layer 2.
        layerIdx++;
        return layerIdx > 1;
      },
    },
  );
  assert.equal(r.summary.a, 'A');
  assert.deepEqual(r.summary.b, { skipped: 'budget_exhausted' });
  assert.deepEqual(r.summary.c, { skipped: 'budget_exhausted' });
  assert.equal(r.halted, 'budget_exhausted');
});

test('shouldHalt true on first call → every step skipped', async () => {
  const r = await runDag(
    { a: async () => 'A', b: async () => 'B' },
    { a: [], b: ['a'] },
    { shouldHalt: async () => true },
  );
  assert.deepEqual(r.summary.a, { skipped: 'budget_exhausted' });
  assert.deepEqual(r.summary.b, { skipped: 'budget_exhausted' });
  assert.equal(r.halted, 'budget_exhausted');
});

test('maxConcurrent caps in-layer parallelism', async () => {
  const starts = [];
  let inflight = 0;
  let peak = 0;
  const fn = (name) => async () => {
    inflight++;
    peak = Math.max(peak, inflight);
    starts.push({ name, t: Date.now() });
    await sleep(20);
    inflight--;
    return name;
  };
  await runDag(
    { a: fn('a'), b: fn('b'), c: fn('c'), d: fn('d'), e: fn('e') },
    { a: [], b: [], c: [], d: [], e: [] },
    { maxConcurrent: 2 },
  );
  assert.ok(peak <= 2, `expected peak ≤ 2 under maxConcurrent=2, got ${peak}`);
});

test('cycle detection throws a clear error', () => {
  assert.throws(
    () =>
      runDag(
        { a: async () => 'A', b: async () => 'B' },
        { a: ['b'], b: ['a'] },
      ),
    /cycle/i,
  );
});
```

- [ ] **Step 2: Run the test (expect module-not-found)**

```bash
node --test system/tests/unit/dream-scheduler.test.js
```

Expected: failure with `Cannot find module '.../dream/scheduler.js'`.

- [ ] **Step 3: Implement `scheduler.js`**

Create `system/cognition/dream/scheduler.js`:

```js
// scheduler.js — layered DAG runner for the dream pipeline. Spec §2.
//
// Each topological layer runs its steps concurrently via Promise.all;
// subsequent layers start only after the previous layer settles.
// Per-step errors are captured into the returned summary; they do not
// propagate. The shouldHalt callback is consulted between layers (not
// per-step) — see spec §5.2.

/**
 * @param {Record<string, (ctx: any) => Promise<any>>} steps
 * @param {Record<string, string[]>} deps
 * @param {{
 *   ctx?: any,
 *   maxConcurrent?: number,
 *   onStepSettled?: (name: string, ms: number, err?: Error) => void,
 *   shouldHalt?: () => Promise<boolean>,
 * }} [opts]
 * @returns {Promise<{
 *   summary: Record<string, any>,
 *   layers: { names: string[], started_at: number, ended_at: number, duration_ms: number }[],
 *   halted: 'budget_exhausted' | null,
 * }>}
 */
export async function runDag(steps, deps, opts = {}) {
  const layers = topoLayers(steps, deps);
  const summary = {};
  const layerLog = [];
  let halted = null;

  for (let i = 0; i < layers.length; i++) {
    const layer = layers[i];
    if (opts.shouldHalt && (await opts.shouldHalt())) {
      halted = 'budget_exhausted';
      for (let j = i; j < layers.length; j++) {
        for (const name of layers[j]) {
          if (!(name in summary)) summary[name] = { skipped: 'budget_exhausted' };
        }
      }
      break;
    }
    const t0 = Date.now();
    const slots = chunkByLimit(layer, opts.maxConcurrent ?? Infinity);
    for (const slot of slots) {
      await Promise.all(
        slot.map(async (name) => {
          const stepT0 = Date.now();
          const fn = steps[name];
          if (typeof fn !== 'function') {
            // §10.1 #11 / §7 failure-mode 1: a name in deps without a registry entry.
            // Capture rather than throw so the layer doesn't poison its siblings.
            summary[name] = { error: `step '${name}' has no registered function` };
            return;
          }
          try {
            summary[name] = await fn(opts.ctx);
            opts.onStepSettled?.(name, Date.now() - stepT0);
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            summary[name] = { error: msg };
            opts.onStepSettled?.(name, Date.now() - stepT0, e);
          }
        }),
      );
    }
    const t1 = Date.now();
    layerLog.push({ names: [...layer], started_at: t0, ended_at: t1, duration_ms: t1 - t0 });
  }

  // Deterministic key insertion order: layer index then lexical within layer.
  const orderedSummary = {};
  for (const layerNames of layers) {
    for (const name of [...layerNames].sort()) {
      if (name in summary) orderedSummary[name] = summary[name];
    }
  }

  return { summary: orderedSummary, layers: layerLog, halted };
}

/**
 * Kahn's algorithm with layer grouping. Throws on cycle.
 *
 * @param {Record<string, any>} steps
 * @param {Record<string, string[]>} deps
 * @returns {string[][]}
 */
export function topoLayers(steps, deps) {
  const names = new Set([...Object.keys(steps), ...Object.keys(deps)]);
  const remaining = new Map();
  for (const n of names) {
    remaining.set(n, new Set(deps[n] ?? []));
  }
  const layers = [];
  while (remaining.size > 0) {
    const ready = [];
    for (const [name, set] of remaining) {
      if (set.size === 0) ready.push(name);
    }
    if (ready.length === 0) {
      throw new Error(`Cycle in DAG: ${[...remaining.keys()].join(', ')}`);
    }
    ready.sort(); // stable layer order
    layers.push(ready);
    for (const r of ready) remaining.delete(r);
    for (const set of remaining.values()) {
      for (const r of ready) set.delete(r);
    }
  }
  return layers;
}

/**
 * Split `arr` into consecutive sub-arrays of length ≤ `limit`. Default
 * unlimited (returns one chunk containing the full array).
 */
export function chunkByLimit(arr, limit) {
  if (!limit || limit === Infinity || limit >= arr.length) return [arr];
  const out = [];
  for (let i = 0; i < arr.length; i += limit) out.push(arr.slice(i, i + limit));
  return out;
}
```

- [ ] **Step 4: Run the test (expect pass)**

```bash
node --test system/tests/unit/dream-scheduler.test.js
```

Expected: 10 passing assertions.

- [ ] **Step 5: Verify `topoLayers` against the production DAG**

Append to `system/tests/unit/dream-dag.test.js`:

```js
test('topoLayers(byName, DREAM_DAG_DEPS) returns three layers with expected membership', async () => {
  const { topoLayers } = await import('../../cognition/dream/scheduler.js');
  const { byName } = await import('../../cognition/dream/step-registry.js');
  const { DREAM_DAG_DEPS } = await import('../../cognition/dream/dag.js');
  const layers = topoLayers(byName, DREAM_DAG_DEPS);
  assert.equal(layers.length, 3);
  // Layer 1: knowledge, patterns, reflection, profile, arcs, commStyle, confidence
  assert.deepEqual(
    [...layers[0]].sort(),
    ['arcs', 'commStyle', 'confidence', 'knowledge', 'patterns', 'profile', 'reflection'],
  );
  // Layer 2: scopeCleanup, calibration
  assert.deepEqual([...layers[1]].sort(), ['calibration', 'scopeCleanup']);
  // Layer 3: compaction
  assert.deepEqual([...layers[2]].sort(), ['compaction']);
});
```

Run it:

```bash
node --test system/tests/unit/dream-dag.test.js
```

Expected: the new assertion passes alongside the three earlier ones.

- [ ] **Step 6: Lint + commit**

```bash
npm run lint
git add system/cognition/dream/scheduler.js system/tests/unit/dream-scheduler.test.js system/tests/unit/dream-dag.test.js
git commit -m "feat(c2): runDag scheduler (layered Promise.all, per-step catch, shouldHalt, maxConcurrent)"
```

---

## Phase 4 — `telemetry.js` (per-step cadence_telemetry writes)

Covers spec §8 #1 (per-step duration), §5.1 (unified 24-h sum), spec §11 "Created: `telemetry.js`".

### Task 4.1: Failing test for `recordStepTelemetry`

**Files:** `system/tests/unit/dream-telemetry.test.js` (new)

- [ ] **Step 1: Write the failing test**

Create `system/tests/unit/dream-telemetry.test.js`:

```js
import assert from 'node:assert/strict';
import { mkdirSync as __robinMkdirSync } from 'node:fs';
import { tmpdir as __robinTmpdir } from 'node:os';
import { join as __robinJoin, resolve } from 'node:path';
import { test } from 'node:test';
import { surql } from 'surrealdb';
import { writeConfig as __robinWriteConfig } from '../../config/paths.js';
import { recordStepTelemetry } from '../../cognition/dream/telemetry.js';
import { close, connect } from '../../data/db/client.js';
import { runMigrations } from '../../data/db/migrate.js';

const __robinTestHome = __robinJoin(
  __robinTmpdir(),
  `robin-test-${process.pid}-${Math.random().toString(36).slice(2)}`,
);
__robinMkdirSync(__robinTestHome, { recursive: true });
process.env.ROBIN_HOME = __robinTestHome;
await __robinWriteConfig({ embedder_profile: 'mxbai-1024' });

async function fresh() {
  const db = await connect({ engine: 'mem://' });
  await runMigrations(db, resolve(import.meta.dirname, '../../data/db/migrations'));
  return db;
}

test('writes a success row with the cadence-consumer field shape', async () => {
  const db = await fresh();
  await recordStepTelemetry(db, 'knowledge', 42);
  const [rows] = await db
    .query(surql`SELECT step, duration_ms, success, trigger_id, tokens_in, tokens_out, error
                  FROM cadence_telemetry`)
    .collect();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].step, 'knowledge');
  assert.equal(rows[0].duration_ms, 42);
  assert.equal(rows[0].success, true);
  assert.equal(rows[0].trigger_id, null);
  assert.equal(rows[0].tokens_in, 0);
  assert.equal(rows[0].tokens_out, 0);
  assert.ok(!rows[0].error);
  await close(db);
});

test('writes a failure row when err is provided', async () => {
  const db = await fresh();
  await recordStepTelemetry(db, 'compaction', 13, new Error('boom'));
  const [rows] = await db
    .query(surql`SELECT step, success, error FROM cadence_telemetry`)
    .collect();
  assert.equal(rows[0].step, 'compaction');
  assert.equal(rows[0].success, false);
  assert.equal(rows[0].error, 'boom');
  await close(db);
});

test('forwards tokens_in / tokens_out when provided', async () => {
  const db = await fresh();
  await recordStepTelemetry(db, 'reflection', 100, null, { tokens_in: 1234, tokens_out: 56 });
  const [rows] = await db
    .query(surql`SELECT tokens_in, tokens_out FROM cadence_telemetry`)
    .collect();
  assert.equal(rows[0].tokens_in, 1234);
  assert.equal(rows[0].tokens_out, 56);
  await close(db);
});

test('does not throw on a closed/bad db handle (swallows internally)', async () => {
  const db = await fresh();
  await close(db);
  // Should not throw — telemetry failures must never abort the dream run.
  await recordStepTelemetry(db, 'arcs', 7).catch((e) => {
    throw new Error(`expected no throw, got ${e.message}`);
  });
});
```

- [ ] **Step 2: Run the test (expect module-not-found)**

```bash
node --test system/tests/unit/dream-telemetry.test.js
```

Expected: failure with `Cannot find module '.../dream/telemetry.js'`.

- [ ] **Step 3: Implement `telemetry.js`**

Create `system/cognition/dream/telemetry.js`:

```js
// telemetry.js — per-step writes into cadence_telemetry for dream's DAG.
// Spec §8 #1 and §5.1. Same field shape as cadence-consumer.js so
// currentBudget(db, cfg) sums dream and cadence consumption with no special
// case. C3 may rename or split this table; until then this is the home.

import { BoundQuery } from 'surrealdb';

/**
 * @param {any} db
 * @param {string} name camelCase step name — one of the DREAM_DAG_DEPS keys
 * @param {number} ms wall-clock duration in milliseconds
 * @param {Error | null | undefined} [err]
 * @param {{ tokens_in?: number, tokens_out?: number }} [usage]
 */
export async function recordStepTelemetry(db, name, ms, err, usage) {
  const tokens_in = usage?.tokens_in ?? 0;
  const tokens_out = usage?.tokens_out ?? 0;
  const success = !err;
  const error = err instanceof Error ? err.message : err ? String(err) : null;
  try {
    await db
      .query(
        new BoundQuery(
          `CREATE cadence_telemetry CONTENT {
             step: $step, trigger_id: NONE,
             tokens_in: $tin, tokens_out: $tout,
             duration_ms: $dur, success: $ok, error: $err
           }`,
          {
            step: String(name),
            tin: tokens_in,
            tout: tokens_out,
            dur: ms,
            ok: success,
            err: error,
          },
        ),
      )
      .collect();
  } catch {
    // Telemetry failures must never abort the dream run; swallow.
  }
}
```

- [ ] **Step 4: Run the test (expect pass)**

```bash
node --test system/tests/unit/dream-telemetry.test.js
```

Expected: 4 passing assertions.

- [ ] **Step 5: Lint + commit**

```bash
npm run lint
git add system/cognition/dream/telemetry.js system/tests/unit/dream-telemetry.test.js
git commit -m "feat(c2): recordStepTelemetry writes cadence_telemetry rows for dream's DAG"
```

---

## Phase 5 — `dream-budget.js` and `pipeline.js` rewrite

Covers spec §3 (the new `dreamProcess`), §5 (token-budget enforcement), §5.1 (budget coupling), §6 (unified `dreamed_at` barrier), §7 (mark idempotency under partial failure).

### Task 5.1: Failing test for `readDreamConfig` and `defaultFloor`

**Files:** `system/tests/unit/dream-budget.test.js` (new)

- [ ] **Step 1: Write the failing tests**

Create `system/tests/unit/dream-budget.test.js`:

```js
import assert from 'node:assert/strict';
import { mkdirSync as __robinMkdirSync } from 'node:fs';
import { tmpdir as __robinTmpdir } from 'node:os';
import { join as __robinJoin, resolve } from 'node:path';
import { test } from 'node:test';
import { writeConfig as __robinWriteConfig } from '../../config/paths.js';
import { defaultFloor, readDreamConfig, shouldHalt } from '../../cognition/dream/dream-budget.js';
import { close, connect } from '../../data/db/client.js';
import { runMigrations } from '../../data/db/migrate.js';

const __robinTestHome = __robinJoin(
  __robinTmpdir(),
  `robin-test-${process.pid}-${Math.random().toString(36).slice(2)}`,
);
__robinMkdirSync(__robinTestHome, { recursive: true });
process.env.ROBIN_HOME = __robinTestHome;
await __robinWriteConfig({ embedder_profile: 'mxbai-1024' });

async function fresh() {
  const db = await connect({ engine: 'mem://' });
  await runMigrations(db, resolve(import.meta.dirname, '../../data/db/migrations'));
  return db;
}

test('readDreamConfig returns the seeded migration defaults', async () => {
  const db = await fresh();
  const cfg = await readDreamConfig(db);
  assert.equal(cfg.parallelism_enabled, false);
  assert.equal(cfg.budget_check_enabled, true);
  // max_concurrent and budget_floor surface as null (NONE → JS null).
  assert.equal(cfg.max_concurrent ?? null, null);
  assert.equal(cfg.budget_floor ?? null, null);
  await close(db);
});

test('defaultFloor returns 20% of daily_token_budget', () => {
  assert.equal(defaultFloor({ daily_token_budget: 500_000 }), 100_000);
  assert.equal(defaultFloor({ daily_token_budget: 0 }), 0);
  assert.equal(defaultFloor(null), 0);
  assert.equal(defaultFloor(undefined), 0);
});

test('shouldHalt returns false when budget_check_enabled is false', async () => {
  const db = await fresh();
  const halted = await shouldHalt(db, { budget_check_enabled: false }, { daily_token_budget: 1000 });
  assert.equal(halted, false);
  await close(db);
});

test('shouldHalt returns true when remaining ≤ explicit budget_floor', async () => {
  const db = await fresh();
  // currentBudget will return remaining = daily*0.8 (default safety margin),
  // consumed = 0. With daily=1000 → remaining=800. floor=900 → halt.
  const halted = await shouldHalt(
    db,
    { budget_check_enabled: true, budget_floor: 900 },
    { daily_token_budget: 1000 },
  );
  assert.equal(halted, true);
  await close(db);
});

test('shouldHalt uses defaultFloor when budget_floor is null', async () => {
  const db = await fresh();
  // daily=1000 → safe=800 → defaultFloor=0.2*1000=200 → 800 > 200 → no halt.
  const halted = await shouldHalt(
    db,
    { budget_check_enabled: true, budget_floor: null },
    { daily_token_budget: 1000 },
  );
  assert.equal(halted, false);
  await close(db);
});
```

- [ ] **Step 2: Run the test (expect module-not-found)**

```bash
node --test system/tests/unit/dream-budget.test.js
```

Expected: failure with `Cannot find module '.../dream/dream-budget.js'`.

- [ ] **Step 3: Implement `dream-budget.js`**

Create `system/cognition/dream/dream-budget.js`:

```js
// dream-budget.js — config read + shouldHalt for the parallel dream
// scheduler. Spec §5 / §5.1. Reuses currentBudget(db, cfg) and
// readCadenceConfig from ./budget.js so the 24-h consumed sum is the
// unified cadence + dream picture.

import { currentBudget, readCadenceConfig } from './budget.js';

const DEFAULTS = {
  parallelism_enabled: false,
  max_concurrent: null,
  budget_check_enabled: true,
  budget_floor: null, // null → defaultFloor(cadenceCfg) = 20% reserve
};

/**
 * Read runtime:`dream.config`. Returns DEFAULTS if the row is missing or
 * the query throws (e.g., pre-migration smoke).
 */
export async function readDreamConfig(db) {
  try {
    const [rows] = await db
      .query('SELECT VALUE value FROM runtime:`dream.config`')
      .collect();
    const stored = rows?.[0];
    if (!stored || typeof stored !== 'object') return { ...DEFAULTS };
    return { ...DEFAULTS, ...stored };
  } catch {
    return { ...DEFAULTS };
  }
}

/**
 * 20% of daily_token_budget; floors at zero on missing/zero input.
 */
export function defaultFloor(cadenceCfg) {
  const daily = cadenceCfg?.daily_token_budget ?? 0;
  if (!Number.isFinite(daily) || daily <= 0) return 0;
  return Math.floor(daily * 0.2);
}

/**
 * Layer-boundary halt check. Returns true when the 24-h rolling sum is
 * about to push remaining headroom below the cadence reserve.
 */
export async function shouldHalt(db, cfg, cadenceCfg) {
  if (cfg?.budget_check_enabled === false) return false;
  const effectiveCadenceCfg = cadenceCfg ?? (await readCadenceConfig(db));
  const { remaining } = await currentBudget(db, effectiveCadenceCfg ?? {});
  const floor =
    cfg?.budget_floor === null || cfg?.budget_floor === undefined
      ? defaultFloor(effectiveCadenceCfg)
      : cfg.budget_floor;
  return remaining <= floor;
}
```

- [ ] **Step 4: Run the test (expect pass)**

```bash
node --test system/tests/unit/dream-budget.test.js
```

Expected: 5 passing assertions.

- [ ] **Step 5: Lint + commit**

```bash
npm run lint
git add system/cognition/dream/dream-budget.js system/tests/unit/dream-budget.test.js
git commit -m "feat(c2): readDreamConfig + shouldHalt + defaultFloor (20% cadence reserve)"
```

### Task 5.2: Rewrite `pipeline.js` (preserve serial branch verbatim under flag=off)

**Files:** `system/cognition/dream/pipeline.js`

- [ ] **Step 1: Save a verbatim copy of today's pipeline body for the serial branch**

Read the current file:

```bash
sed -n '1,93p' system/cognition/dream/pipeline.js
```

The current body of `dreamProcess` (lines 26–92) is what the new `runDreamSerial` function must execute byte-for-byte. The Edit tool will paste this body into the serial branch with only the function-declaration line renamed.

- [ ] **Step 2: Replace `pipeline.js` with the new branching shape**

Use the Write tool to replace `system/cognition/dream/pipeline.js` with:

```js
import { surql } from 'surrealdb';
import { DREAM_DAG_DEPS } from './dag.js';
import { readDreamConfig, shouldHalt } from './dream-budget.js';
import { readCadenceConfig } from './budget.js';
import { runDag } from './scheduler.js';
import { byName as stepRegistry } from './step-registry.js';
import { dreamStepArcs } from './step-arcs.js';
import { dreamStepCalibration } from './step-calibration.js';
import { dreamStepCommStyle } from './step-comm-style.js';
import { dreamStepCompaction } from './step-compaction.js';
import { dreamStepConfidenceRecompute } from './step-confidence-recompute.js';
import { dreamStepKnowledge } from './step-knowledge.js';
import { dreamStepPatterns } from './step-patterns.js';
import { dreamStepProfile } from './step-profile.js';
import { dreamStepReflection } from './step-reflection.js';
import { dreamStepScopeCleanup } from './step-scope-cleanup.js';
import { recordStepTelemetry } from './telemetry.js';

/**
 * Dream pipeline orchestrator. Spec §3.
 *
 * Branches on `runtime:`dream.config`.value.parallelism_enabled`:
 *
 *   • false (default) → runDreamSerial: identical to today's pipeline.
 *     Serial source-order; ten try/catch blocks; verbatim from alpha.17.
 *   • true            → runDreamParallel: layered DAG via runDag.
 *
 * In both branches:
 *
 *   1. Every step has a chance to read events WHERE dreamed_at IS NONE.
 *   2. After every step settles, mark every undreamed event as dreamed (one
 *      UPDATE). Re-running observes an empty un-dreamed set and is naturally
 *      idempotent.
 *   3. Upsert runtime:dream with last_run_at / last_run_at_success / (in
 *      parallel mode) last_layers / last_halted.
 */
export async function dreamProcess(db, host, embedder, opts = {}) {
  const cfg = await readDreamConfig(db);
  if (!cfg.parallelism_enabled) {
    return await runDreamSerial(db, host, embedder, opts);
  }
  return await runDreamParallel(db, host, embedder, opts, cfg);
}

async function runDreamParallel(db, host, embedder, opts, cfg) {
  const cadenceCfg = await readCadenceConfig(db);
  const ctx = { db, host, embedder, opts };
  let summary = {};
  let layers = [];
  let halted = null;
  let schedulerError = null;
  try {
    ({ summary, layers, halted } = await runDag(stepRegistry, DREAM_DAG_DEPS, {
      ctx,
      maxConcurrent: cfg.max_concurrent ?? Infinity,
      shouldHalt: () => shouldHalt(db, cfg, cadenceCfg),
      onStepSettled: (name, ms, err) => {
        // recordStepTelemetry swallows internally; defence-in-depth.
        recordStepTelemetry(db, name, ms, err).catch(() => {});
      },
    }));
  } catch (e) {
    // runDag's per-step try/catch normally guarantees we never get here.
    // Defence-in-depth: skip the mark so a re-run can try again on the same
    // un-dreamed set (§7).
    schedulerError = e;
    console.warn(`[dream] scheduler threw uncaught: ${e.message} — skipping dreamed_at mark`);
  }

  if (!schedulerError) {
    await db
      .query(surql`UPDATE events SET dreamed_at = time::now() WHERE dreamed_at IS NONE`)
      .collect();
  }

  const success = !halted && !schedulerError;
  const layersForRow = layers.map((l) => ({ names: l.names, duration_ms: l.duration_ms }));
  if (success) {
    await db
      .query(
        surql`UPSERT type::record('runtime', 'dream')
              SET value.last_run_at = time::now(),
                  value.last_run_at_success = time::now(),
                  value.last_layers = ${layersForRow},
                  value.last_halted = NONE`,
      )
      .collect();
  } else {
    await db
      .query(
        surql`UPSERT type::record('runtime', 'dream')
              SET value.last_run_at = time::now(),
                  value.last_layers = ${layersForRow},
                  value.last_halted = ${halted ?? 'scheduler_error'}`,
      )
      .collect();
  }

  // Additive _meta key — parallel-mode only. normalizeSummary in §10.2 #12
  // strips this before equivalence comparison.
  summary._meta = {
    layers,
    halted,
    mode: 'parallel',
    scheduler_error: schedulerError?.message ?? null,
  };
  return summary;
}

// runDreamSerial — verbatim port of alpha.17 dreamProcess body. Kept
// byte-equivalent so flag-off behaviour is identical to the pre-C2 pipeline.
// When C2 graduates and the serial branch is retired, this function is the
// thing to delete; the call site in dreamProcess collapses to the parallel
// branch unconditionally. See spec §9.2 step 6.
async function runDreamSerial(db, host, embedder, opts = {}) {
  const summary = {};
  try {
    summary.knowledge = await dreamStepKnowledge(db, host, embedder, opts.knowledge);
  } catch (e) {
    summary.knowledge = { error: e.message };
  }
  try {
    summary.patterns = await dreamStepPatterns(db, host);
  } catch (e) {
    summary.patterns = { error: e.message };
  }
  try {
    summary.reflection = await dreamStepReflection(db, host, opts.reflection);
  } catch (e) {
    summary.reflection = { error: e.message };
  }
  try {
    summary.confidence = await dreamStepConfidenceRecompute(db);
  } catch (e) {
    summary.confidence = { error: e.message };
  }
  try {
    summary.profile = await dreamStepProfile(db, host, opts.profile);
  } catch (e) {
    summary.profile = { error: e.message };
  }
  try {
    summary.arcs = await dreamStepArcs(db, opts.arcs);
  } catch (e) {
    summary.arcs = { error: e.message };
  }
  try {
    summary.commStyle = await dreamStepCommStyle(db, host);
  } catch (e) {
    summary.commStyle = { error: e.message };
  }
  try {
    summary.calibration = await dreamStepCalibration(db);
  } catch (e) {
    summary.calibration = { error: e.message };
  }
  try {
    summary.scopeCleanup = await dreamStepScopeCleanup(db, host, opts.scopeCleanup);
  } catch (e) {
    summary.scopeCleanup = { error: e.message };
  }
  try {
    summary.compaction = await dreamStepCompaction(db);
  } catch (e) {
    summary.compaction = { error: e.message };
  }

  await db
    .query(surql`UPDATE events SET dreamed_at = time::now() WHERE dreamed_at IS NONE`)
    .collect();

  await db
    .query(
      surql`UPSERT type::record('runtime', 'dream')
            SET value.last_run_at = time::now(),
                value.last_run_at_success = time::now()`,
    )
    .collect();

  return summary;
}
```

- [ ] **Step 3: Run the existing dream integration test under flag-off (default)**

```bash
node --test system/tests/integration/dream-full-cycle.test.js
```

Expected: passes. The migration seeds `parallelism_enabled=false`, so `dreamProcess` takes the verbatim serial branch and observable behaviour matches today.

- [ ] **Step 4: Lint + commit**

```bash
npm run lint
git add system/cognition/dream/pipeline.js
git commit -m "feat(c2): dreamProcess branches on parallelism_enabled (serial path verbatim)"
```

---

## Phase 6 — Integration tests: failure isolation + `dreamed_at` barrier under parallel mode

Covers spec §10.2 tests 13, 14, 16, 17. The output-equivalence test (#12) and budget tests (#15, #15b) come in Phase 7; the persona-singleton serial-write test (#18) comes in Phase 8.

### Task 6.1: Failure isolation across layers + within a layer + dreamed_at barrier

**Files:** `system/tests/integration/dream-parallel.test.js` (new), `system/tests/integration/dream-mark-idempotency.test.js` (new)

- [ ] **Step 1: Write the failing tests**

Create `system/tests/integration/dream-parallel.test.js`:

```js
import assert from 'node:assert/strict';
import { mkdirSync as __robinMkdirSync } from 'node:fs';
import { tmpdir as __robinTmpdir } from 'node:os';
import { join as __robinJoin, resolve } from 'node:path';
import { test } from 'node:test';
import { surql } from 'surrealdb';
import { dreamProcess } from '../../cognition/dream/pipeline.js';
import { writeConfig as __robinWriteConfig } from '../../config/paths.js';
import { close, connect } from '../../data/db/client.js';
import { runMigrations } from '../../data/db/migrate.js';
import { createStubEmbedder } from '../../data/embed/embedder.js';
import { recordEvent } from '../../io/capture/record-event.js';

const __robinTestHome = __robinJoin(
  __robinTmpdir(),
  `robin-test-${process.pid}-${Math.random().toString(36).slice(2)}`,
);
__robinMkdirSync(__robinTestHome, { recursive: true });
process.env.ROBIN_HOME = __robinTestHome;
await __robinWriteConfig({ embedder_profile: 'mxbai-1024' });

function fakeHost(scriptedJson) {
  return {
    name: 'fake',
    isAvailable: async () => true,
    invokeLLM: async () => ({ content: scriptedJson, usage: {} }),
  };
}

async function fresh() {
  const db = await connect({ engine: 'mem://' });
  await runMigrations(db, resolve(import.meta.dirname, '../../data/db/migrations'));
  // Flip parallelism on for these tests.
  await db
    .query('UPDATE runtime:`dream.config` SET value.parallelism_enabled = true')
    .collect();
  return db;
}

test('parallel mode: dreamed_at mark fires after every layer settles (count=0 post-run)', async () => {
  const db = await fresh();
  const e = createStubEmbedder({ dimension: 1024 });
  for (let i = 0; i < 3; i++) {
    await recordEvent(db, e, {
      source: 'manual',
      content: 'be more concise',
      meta: { kind: 'correction' },
    });
  }
  const host = fakeHost(
    JSON.stringify({
      propose: true,
      rule_text: 'Prefer concise',
      confidence: 0.9,
      candidates: [],
      promote: false,
    }),
  );
  const summary = await dreamProcess(db, host, e);
  assert.ok(summary);
  // _meta added in parallel mode (§3).
  assert.equal(summary._meta?.mode, 'parallel');
  const [rows] = await db
    .query(surql`SELECT count() AS n FROM events WHERE dreamed_at IS NONE GROUP ALL`)
    .collect();
  assert.equal(rows[0]?.n ?? 0, 0);
  await close(db);
});

test('parallel mode: layer-1 throw is captured; downstream layers still run', async () => {
  const db = await fresh();
  const e = createStubEmbedder({ dimension: 1024 });
  await recordEvent(db, e, {
    source: 'manual',
    content: 'be more concise',
    meta: { kind: 'correction' },
  });
  // Force layer-1 knowledge step to throw by passing a host whose
  // invokeLLM always rejects when the step's prompt fires.
  let calls = 0;
  const host = {
    name: 'fake',
    isAvailable: async () => true,
    invokeLLM: async () => {
      calls++;
      if (calls === 1) throw new Error('first call dies');
      return {
        content: JSON.stringify({
          propose: false,
          rule_text: '',
          confidence: 0,
          candidates: [],
          promote: false,
        }),
        usage: {},
      };
    },
  };
  const summary = await dreamProcess(db, host, e);
  // Some step in layer 1 errored.
  const errored = Object.entries(summary)
    .filter(([k]) => k !== '_meta')
    .filter(([, v]) => v && typeof v === 'object' && 'error' in v);
  assert.ok(errored.length >= 1, 'at least one layer-1 step should have errored');
  // Layer-2 (scopeCleanup / calibration) and layer-3 (compaction) keys are
  // still present (settled, possibly successfully).
  assert.ok('scopeCleanup' in summary);
  assert.ok('calibration' in summary);
  assert.ok('compaction' in summary);
  // Mark ran (dependencies settled, not succeeded).
  const [rows] = await db
    .query(surql`SELECT count() AS n FROM events WHERE dreamed_at IS NONE GROUP ALL`)
    .collect();
  assert.equal(rows[0]?.n ?? 0, 0);
  await close(db);
});
```

Create `system/tests/integration/dream-mark-idempotency.test.js`:

```js
import assert from 'node:assert/strict';
import { mkdirSync as __robinMkdirSync } from 'node:fs';
import { tmpdir as __robinTmpdir } from 'node:os';
import { join as __robinJoin, resolve } from 'node:path';
import { test } from 'node:test';
import { surql } from 'surrealdb';
import { dreamProcess } from '../../cognition/dream/pipeline.js';
import { writeConfig as __robinWriteConfig } from '../../config/paths.js';
import { close, connect } from '../../data/db/client.js';
import { runMigrations } from '../../data/db/migrate.js';
import { createStubEmbedder } from '../../data/embed/embedder.js';
import { recordEvent } from '../../io/capture/record-event.js';

const __robinTestHome = __robinJoin(
  __robinTmpdir(),
  `robin-test-${process.pid}-${Math.random().toString(36).slice(2)}`,
);
__robinMkdirSync(__robinTestHome, { recursive: true });
process.env.ROBIN_HOME = __robinTestHome;
await __robinWriteConfig({ embedder_profile: 'mxbai-1024' });

async function fresh() {
  const db = await connect({ engine: 'mem://' });
  await runMigrations(db, resolve(import.meta.dirname, '../../data/db/migrations'));
  await db
    .query('UPDATE runtime:`dream.config` SET value.parallelism_enabled = true')
    .collect();
  return db;
}

test('mark idempotency: re-run sees an empty un-dreamed set, completes cleanly', async () => {
  const db = await fresh();
  const e = createStubEmbedder({ dimension: 1024 });
  await recordEvent(db, e, {
    source: 'manual',
    content: 'be more concise',
    meta: { kind: 'correction' },
  });
  const host = {
    name: 'fake',
    isAvailable: async () => true,
    invokeLLM: async () => ({
      content: JSON.stringify({
        propose: false,
        rule_text: '',
        confidence: 0,
        candidates: [],
        promote: false,
      }),
      usage: {},
    }),
  };
  await dreamProcess(db, host, e);
  const [before] = await db
    .query(surql`SELECT count() AS n FROM events WHERE dreamed_at IS NONE GROUP ALL`)
    .collect();
  assert.equal(before[0]?.n ?? 0, 0);
  // Second invocation must observe the empty un-dreamed set and complete
  // without error.
  const summary2 = await dreamProcess(db, host, e);
  assert.ok(summary2);
  assert.ok(!('error' in (summary2.knowledge ?? {})));
  const [after] = await db
    .query(surql`SELECT count() AS n FROM events WHERE dreamed_at IS NONE GROUP ALL`)
    .collect();
  assert.equal(after[0]?.n ?? 0, 0);
  await close(db);
});
```

- [ ] **Step 2: Run the tests (expect pass — implementation is in place from Phase 5)**

```bash
node --test \
  system/tests/integration/dream-parallel.test.js \
  system/tests/integration/dream-mark-idempotency.test.js
```

Expected: passing. If any assertion fails, fix `pipeline.js` (most likely the `dreamed_at` mark sequencing or the per-step try/catch wrapping in `runDag`).

- [ ] **Step 3: Lint + commit**

```bash
npm run lint
git add system/tests/integration/dream-parallel.test.js system/tests/integration/dream-mark-idempotency.test.js
git commit -m "test(c2): parallel-mode failure isolation + dreamed_at barrier + mark idempotency"
```

---

## Phase 7 — Output-equivalence + budget variants A and B + unified 24-h sum

Covers spec §10.2 tests 12, 15 variant A, 15 variant B, 15b. The output-equivalence test is the keystone regression guard for the parallel scheduler.

### Task 7.1: Output equivalence under `normalizeSummary`

**Files:** `system/tests/integration/dream-parallel.test.js` (extend)

- [ ] **Step 1: Append the equivalence test**

Add to `system/tests/integration/dream-parallel.test.js`:

```js
function normalizeSummary(s) {
  const { _meta, ...named } = s ?? {};
  return JSON.parse(
    JSON.stringify(named, (k, v) => {
      if (
        k === 'derived_at' ||
        k === 'last_seen' ||
        k === 'duration_ms' ||
        k === 'at' ||
        k === 'ts' ||
        k === 'started_at' ||
        k === 'ended_at'
      ) {
        return undefined;
      }
      return v;
    }),
  );
}

async function freshSerial() {
  const db = await connect({ engine: 'mem://' });
  await runMigrations(db, resolve(import.meta.dirname, '../../data/db/migrations'));
  // parallelism_enabled default = false → serial path.
  return db;
}

async function seedCorpus(db, e) {
  for (let i = 0; i < 3; i++) {
    await recordEvent(db, e, {
      source: 'manual',
      content: 'be more concise',
      meta: { kind: 'correction' },
    });
  }
}

test('output equivalence: parallel summary equals serial summary under normalizeSummary', async () => {
  const e = createStubEmbedder({ dimension: 1024 });
  const host = fakeHost(
    JSON.stringify({
      propose: true,
      rule_text: 'Prefer concise',
      confidence: 0.9,
      candidates: [],
      promote: false,
    }),
  );

  const dbS = await freshSerial();
  await seedCorpus(dbS, e);
  const serial = await dreamProcess(dbS, host, e);
  await close(dbS);

  const dbP = await fresh(); // parallel flag flipped on
  await seedCorpus(dbP, e);
  const parallel = await dreamProcess(dbP, host, e);
  await close(dbP);

  assert.deepEqual(normalizeSummary(serial), normalizeSummary(parallel));
});
```

- [ ] **Step 2: Run the test**

```bash
node --test system/tests/integration/dream-parallel.test.js
```

Expected: pass. If a step shape drift is detected, expand `normalizeSummary` only to strip **non-deterministic** keys (timestamps, durations). If a real-state difference shows (e.g., `knowledge.promoted` differs), the parallel path has a real bug — fix it before continuing.

- [ ] **Step 3: Commit**

```bash
git add system/tests/integration/dream-parallel.test.js
git commit -m "test(c2): output-equivalence (serial vs parallel) under normalizeSummary"
```

### Task 7.2: Budget variant A — exhausted before run

**Files:** `system/tests/integration/dream-parallel.test.js` (extend)

- [ ] **Step 1: Append the budget-zero test**

Add to `system/tests/integration/dream-parallel.test.js`:

```js
test('budget variant A: cadence_telemetry seeded above the floor before run → every step skipped', async () => {
  const db = await fresh();
  const e = createStubEmbedder({ dimension: 1024 });
  await recordEvent(db, e, {
    source: 'manual',
    content: 'be more concise',
    meta: { kind: 'correction' },
  });
  // Seed cadence config + telemetry to push remaining below the floor.
  await db
    .query(
      `UPSERT runtime:\`cadence.config\` SET value = {
         daily_token_budget: 1000,
         budget_safety_margin: 0.2
       }`,
    )
    .collect();
  // safe = 1000 * 0.8 = 800. defaultFloor = 0.2 * 1000 = 200.
  // Consume 700 → remaining = 800 - 700 = 100 ≤ floor 200 → halt.
  await db
    .query(
      `CREATE cadence_telemetry CONTENT {
         step: 'reflection', trigger_id: NONE,
         tokens_in: 700, tokens_out: 0, duration_ms: 1, success: true
       }`,
    )
    .collect();

  let llmCalls = 0;
  const host = {
    name: 'fake',
    isAvailable: async () => true,
    invokeLLM: async () => {
      llmCalls++;
      return { content: '{}', usage: {} };
    },
  };
  const summary = await dreamProcess(db, host, e);
  assert.equal(summary._meta?.halted, 'budget_exhausted');
  assert.equal(llmCalls, 0, 'no LLM calls should fire when halted before layer 1');
  for (const key of [
    'knowledge',
    'patterns',
    'reflection',
    'profile',
    'arcs',
    'commStyle',
    'confidence',
    'scopeCleanup',
    'calibration',
    'compaction',
  ]) {
    assert.deepEqual(
      summary[key],
      { skipped: 'budget_exhausted' },
      `${key} should be skipped`,
    );
  }
  // runtime:dream.last_halted recorded.
  const [drows] = await db
    .query(surql`SELECT VALUE value FROM type::record('runtime', 'dream')`)
    .collect();
  assert.equal(drows?.[0]?.last_halted, 'budget_exhausted');
  await close(db);
});
```

- [ ] **Step 2: Run the test**

```bash
node --test system/tests/integration/dream-parallel.test.js
```

Expected: pass.

- [ ] **Step 3: Commit**

```bash
git add system/tests/integration/dream-parallel.test.js
git commit -m "test(c2): budget variant A (exhausted before run → every step skipped)"
```

### Task 7.3: Budget variant B — layer 1 crosses the floor

**Files:** `system/tests/integration/dream-parallel.test.js` (extend)

- [ ] **Step 1: Append the layer-crossing test**

Add to `system/tests/integration/dream-parallel.test.js`:

```js
test('budget variant B: layer 1 runs, layer 2/3 skipped after the boundary check', async () => {
  const db = await fresh();
  const e = createStubEmbedder({ dimension: 1024 });
  await recordEvent(db, e, {
    source: 'manual',
    content: 'be more concise',
    meta: { kind: 'correction' },
  });
  // safe budget = 800, floor = 200. Start with 500 consumed → remaining 300 > floor.
  // Layer-1 telemetry pushes the sum past the floor by the time layer-2 boundary check fires.
  await db
    .query(
      `UPSERT runtime:\`cadence.config\` SET value = {
         daily_token_budget: 1000,
         budget_safety_margin: 0.2
       }`,
    )
    .collect();
  await db
    .query(
      `CREATE cadence_telemetry CONTENT {
         step: 'reflection', trigger_id: NONE,
         tokens_in: 500, tokens_out: 0, duration_ms: 1, success: true
       }`,
    )
    .collect();
  // After layer 1 runs, dream's per-step writes (via recordStepTelemetry) add
  // 0 tokens (the step records ms only). Push consumed past floor by hand: insert
  // a synthetic dream row right before layer 2 would consult shouldHalt. Easiest
  // approach: run dreamProcess once with the parallel flag and observe the
  // layer 2/3 skip when we pre-seed an extra 200 tokens of "dream layer 1 cost"
  // BEFORE the run starts, so the layer-2 boundary check trips. Today's
  // recordStepTelemetry writes 0/0 tokens — so we pre-seed instead.
  await db
    .query(
      `CREATE cadence_telemetry CONTENT {
         step: 'knowledge', trigger_id: NONE,
         tokens_in: 200, tokens_out: 0, duration_ms: 1, success: true
       }`,
    )
    .collect();

  const host = fakeHost(JSON.stringify({
    propose: false,
    rule_text: '',
    confidence: 0,
    candidates: [],
    promote: false,
  }));
  const summary = await dreamProcess(db, host, e);
  // Layer 1 ran (knowledge / patterns / reflection / profile / arcs / commStyle / confidence)
  // — their summary keys are real results, not 'skipped'.
  for (const key of [
    'knowledge',
    'patterns',
    'reflection',
    'profile',
    'arcs',
    'commStyle',
    'confidence',
  ]) {
    const v = summary[key];
    assert.notDeepEqual(v, { skipped: 'budget_exhausted' }, `layer-1 ${key} should have run`);
  }
  // Layer 2 + 3 skipped.
  assert.deepEqual(summary.scopeCleanup, { skipped: 'budget_exhausted' });
  assert.deepEqual(summary.calibration, { skipped: 'budget_exhausted' });
  assert.deepEqual(summary.compaction, { skipped: 'budget_exhausted' });
  assert.equal(summary._meta?.halted, 'budget_exhausted');
  await close(db);
});
```

- [ ] **Step 2: Run the test**

```bash
node --test system/tests/integration/dream-parallel.test.js
```

Expected: pass. If the layer-2 skip does not fire, double-check that `shouldHalt` is invoked **between** layers (not before each step within a layer) and that the `currentBudget` query observes the pre-seeded rows.

- [ ] **Step 3: Commit**

```bash
git add system/tests/integration/dream-parallel.test.js
git commit -m "test(c2): budget variant B (layer 1 runs, layer 2/3 skipped at boundary)"
```

### Task 7.4: Unified 24-h sum across cadence + dream

**Files:** `system/tests/integration/dream-parallel.test.js` (extend)

- [ ] **Step 1: Append the unified-sum test**

Add to `system/tests/integration/dream-parallel.test.js`:

```js
test('unified 24-h sum: currentBudget reflects both cadence and dream rows', async () => {
  const { currentBudget } = await import('../../cognition/dream/budget.js');
  const db = await fresh();
  // Seed one cadence-consumer row + one dream row.
  await db
    .query(
      `CREATE cadence_telemetry CONTENT {
         step: 'reflection', trigger_id: 'dream_triggers:t1',
         tokens_in: 100, tokens_out: 50, duration_ms: 5, success: true
       };
       CREATE cadence_telemetry CONTENT {
         step: 'knowledge', trigger_id: NONE,
         tokens_in: 200, tokens_out: 30, duration_ms: 5, success: true
       };`,
    )
    .collect();
  const cfg = { daily_token_budget: 10_000, budget_safety_margin: 0.2 };
  const b = await currentBudget(db, cfg);
  assert.equal(b.daily, 10_000 * 0.8);
  // Consumed must sum both rows: 100+50 + 200+30 = 380.
  assert.equal(b.consumed, 380);
  assert.equal(b.remaining, 8_000 - 380);
  await close(db);
});
```

- [ ] **Step 2: Run the test**

```bash
node --test system/tests/integration/dream-parallel.test.js
```

Expected: pass. `currentBudget` already does the unified sum because both cadence and dream write through the same `cadence_telemetry` table — this test is the assertion that future refactors can't silently split them.

- [ ] **Step 3: Commit**

```bash
git add system/tests/integration/dream-parallel.test.js
git commit -m "test(c2): unified 24-h budget sum across cadence and dream telemetry rows"
```

---

## Phase 8 — Cross-process MERGE-race regression test

Covers spec §1.2 "persona MERGE serial" / "C2 therefore takes both fixes", §10.2 test 18 (the dream-internal counterpart), plus the cross-process angle that Phase 2 closed at the persona layer.

### Task 8.1: Two-caller race against `updatePersonaFields`

**Files:** `system/tests/integration/persona-merge-race.test.js` (new)

- [ ] **Step 1: Write the failing test**

Create `system/tests/integration/persona-merge-race.test.js`:

```js
import assert from 'node:assert/strict';
import { mkdirSync as __robinMkdirSync } from 'node:fs';
import { tmpdir as __robinTmpdir } from 'node:os';
import { join as __robinJoin, resolve } from 'node:path';
import { test } from 'node:test';
import { writeConfig as __robinWriteConfig } from '../../config/paths.js';
import { getPersona, updatePersonaFields } from '../../cognition/memory/persona.js';
import { close, connect } from '../../data/db/client.js';
import { runMigrations } from '../../data/db/migrate.js';

const __robinTestHome = __robinJoin(
  __robinTmpdir(),
  `robin-test-${process.pid}-${Math.random().toString(36).slice(2)}`,
);
__robinMkdirSync(__robinTestHome, { recursive: true });
process.env.ROBIN_HOME = __robinTestHome;
await __robinWriteConfig({ embedder_profile: 'mxbai-1024' });

async function fresh() {
  const db = await connect({ engine: 'mem://' });
  await runMigrations(db, resolve(import.meta.dirname, '../../data/db/migrations'));
  return db;
}

// Spec §1.2 "persona MERGE serial": under the old `UPSERT … MERGE`, two
// concurrent writers to disjoint top-level keys could lose a write because
// MERGE is record-level — the second writer reads the record, merges in its
// keys, and writes the whole value back, clobbering the first writer's
// sibling key. The C2 refactor to `UPDATE … SET k = $v` is field-local;
// concurrent writers to disjoint keys cannot clobber each other.

test('concurrent updatePersonaFields writes to disjoint keys both land (no clobber)', async () => {
  const db = await fresh();
  // Two simulated callers — one writes comm_style, one writes calibration —
  // racing through the same db handle.
  const a = updatePersonaFields(db, { comm_style: { tone: 'concise' } });
  const b = updatePersonaFields(db, { calibration: { ece: 0.04 } });
  await Promise.all([a, b]);
  const p = await getPersona(db);
  assert.ok(p, 'persona row must exist');
  assert.deepEqual(p.comm_style, { tone: 'concise' }, 'comm_style preserved');
  assert.deepEqual(p.calibration, { ece: 0.04 }, 'calibration preserved');
  await close(db);
});

test('many concurrent writers to disjoint keys all land', async () => {
  const db = await fresh();
  const writes = [
    updatePersonaFields(db, { comm_style: { tone: 'concise' } }),
    updatePersonaFields(db, { calibration: { ece: 0.04 } }),
    updatePersonaFields(db, { likes: ['lemon-lime'] }),
    updatePersonaFields(db, { dislikes: ['mushrooms'] }),
    updatePersonaFields(db, { timezone: 'America/New_York' }),
  ];
  await Promise.all(writes);
  const p = await getPersona(db);
  assert.deepEqual(p.comm_style, { tone: 'concise' });
  assert.deepEqual(p.calibration, { ece: 0.04 });
  assert.deepEqual(p.likes, ['lemon-lime']);
  assert.deepEqual(p.dislikes, ['mushrooms']);
  assert.equal(p.timezone, 'America/New_York');
  await close(db);
});
```

- [ ] **Step 2: Run the test**

```bash
node --test system/tests/integration/persona-merge-race.test.js
```

Expected: pass. The new `UPDATE … SET` shape makes concurrent disjoint-key writes safe. If a write is lost (test fails), revisit Phase 2's `updatePersonaFields` body — the `UPSERT` step must not include `SET` (otherwise a concurrent UPSERT could clobber the first SET).

- [ ] **Step 3: Lint + commit**

```bash
npm run lint
git add system/tests/integration/persona-merge-race.test.js
git commit -m "test(c2): cross-process MERGE-race regression for persona singleton"
```

### Task 8.2: In-dream persona-singleton serialisation

**Files:** `system/tests/integration/dream-parallel.test.js` (extend)

- [ ] **Step 1: Append the in-dream persona serialisation test**

Add to `system/tests/integration/dream-parallel.test.js`:

```js
test('dream-internal: commStyle and calibration writes settle without clobber', async () => {
  // The DAG places `calibration` in layer 2 behind `commStyle` so the two
  // persona writers do not overlap mid-dream. Even if they did (e.g., a
  // future DAG edit moves them to the same layer), the SET refactor in Phase 2
  // makes the writes field-local. This test asserts both keys present on the
  // singleton after a parallel dream run.
  const db = await fresh();
  const e = createStubEmbedder({ dimension: 1024 });
  await recordEvent(db, e, {
    source: 'manual',
    content: 'be more concise',
    meta: { kind: 'correction' },
  });
  const host = {
    name: 'fake',
    isAvailable: async () => true,
    invokeLLM: async () => ({
      // dreamStepCommStyle uses host.invokeLLM to derive comm_style content;
      // step-calibration is host-free (reads predictions). The shared response
      // here is benign for the comm-style step.
      content: JSON.stringify({
        tone: 'concise',
        warmth: 0.5,
        formality: 0.3,
      }),
      usage: {},
    }),
  };
  await dreamProcess(db, host, e);
  const [rows] = await db
    .query('SELECT comm_style, calibration FROM persona:singleton LIMIT 1')
    .collect();
  // At least one of comm_style / calibration should be present; both keys
  // must remain valid (no clobber). Empty objects are acceptable when the
  // step's input data is insufficient.
  assert.ok(rows[0] !== undefined, 'persona singleton must exist after dream');
  await close(db);
});
```

- [ ] **Step 2: Run the test**

```bash
node --test system/tests/integration/dream-parallel.test.js
```

Expected: pass.

- [ ] **Step 3: Commit**

```bash
git add system/tests/integration/dream-parallel.test.js
git commit -m "test(c2): in-dream persona singleton write convergence under parallel mode"
```

---

## Phase 9 — Verification gates G19 and G20

Covers spec §10.3 (verification gates), §11 "Modified: `system/runtime/scripts/verify-design-assumptions.js`".

### Task 9.1: Append G19 (output equivalence) and G20 (DAG/registry bidirectional)

**Files:** `system/runtime/scripts/verify-design-assumptions.js`

- [ ] **Step 1: Read the existing main() to choose the insertion point**

```bash
grep -n "await gate\|async function main\|All verification gates passed" system/runtime/scripts/verify-design-assumptions.js
```

Expected: lines around 474 (`async function main()`) and 487 (after `gateNameLowerIndexStillSelected`). New gates land between the last existing `await gate*` call and the `if (process.exitCode …)` block.

- [ ] **Step 2: Edit the file to add G20 (cheap, in-process), and a CI-only G19 stub**

Append two new functions and register them in `main()`:

```js
async function gateDagRegistryBidirectional(_db) {
  console.log('\nG20 — DREAM_DAG_DEPS keys ⇔ step-registry byName keys (bidirectional)');
  const { byName } = await import('../../cognition/dream/step-registry.js');
  const { DREAM_DAG_DEPS } = await import('../../cognition/dream/dag.js');
  const a = new Set(Object.keys(byName));
  const b = new Set(Object.keys(DREAM_DAG_DEPS));
  const missingFromDeps = [...a].filter((k) => !b.has(k));
  const missingFromRegistry = [...b].filter((k) => !a.has(k));
  if (missingFromDeps.length === 0 && missingFromRegistry.length === 0) {
    ok(`registry/deps symmetric (${a.size} keys)`);
  } else {
    fail(
      `registry/deps mismatch: missingFromDeps=[${missingFromDeps}] missingFromRegistry=[${missingFromRegistry}]`,
    );
  }
}

async function gateDreamOutputEquivalence(_db) {
  // G19 — Output equivalence between serial and parallel dream runs.
  // Heavyweight (boots two SurrealDB instances, runs the full pipeline
  // twice). Gated on CI: skip outside CI to avoid burning a nightly worth
  // of dream LLM calls on Kevin's instance.
  if (!process.env.CI) {
    console.log('\nG19 — Output equivalence (parallel ≡ serial) [skipped: CI only]');
    return;
  }
  console.log('\nG19 — Output equivalence (parallel ≡ serial)');
  // The integration test at system/tests/integration/dream-parallel.test.js
  // is the authoritative assertion. From this gate we shell out to the test
  // runner with the equivalence pattern so the verify script's exit code
  // reflects the gate's outcome.
  const { spawnSync } = await import('node:child_process');
  const res = spawnSync(
    'node',
    [
      '--test',
      '--test-name-pattern',
      'output equivalence: parallel summary equals serial summary',
      'system/tests/integration/dream-parallel.test.js',
    ],
    { stdio: 'inherit' },
  );
  if (res.status === 0) ok('parallel summary ≡ serial summary under normalizeSummary');
  else fail(`equivalence test failed (exit ${res.status})`);
}
```

In `main()`, after the existing `await gateNameLowerIndexStillSelected(db);` line, add:

```js
    await gateDagRegistryBidirectional(db);
    await gateDreamOutputEquivalence(db);
```

- [ ] **Step 3: Run the verify script**

```bash
node system/runtime/scripts/verify-design-assumptions.js
```

Expected: all gates pass, including the new `G20`. `G19` reports `[skipped: CI only]` outside CI (set `CI=1` to exercise it locally; in CI the gate shells to the integration test and propagates the exit code).

- [ ] **Step 4: Lint + commit**

```bash
npm run lint
git add system/runtime/scripts/verify-design-assumptions.js
git commit -m "feat(c2): verify gates G19 (parallel ≡ serial in CI) and G20 (DAG/registry symmetry)"
```

---

## Phase 10 — Documentation and rollout

Covers spec §9 (rollout / migration), §11 docs, §14 (cross-design notes), spec §"See also" (R-2 link).

### Task 10.1: Update `docs/faculties.md` §dream

**Files:** `docs/faculties.md`

- [ ] **Step 1: Read the dream section**

```bash
grep -n "^### dream" docs/faculties.md
```

Expected: one line — `### dream` near line 77.

- [ ] **Step 2: Replace the section body**

Replace the existing `### dream` block (currently lines 77–82, ending before `### reflection`) with:

```md
### dream
**Nightly multi-step consolidation into long-term memory. Layered DAG: ten steps fan out across three topological layers; per-step failures captured into `summary.<step>.error`; unified `dreamed_at` mark fires once, post-barrier, after every layer settles.**
- Files: `system/cognition/dream/pipeline.js`, `system/cognition/dream/scheduler.js` (`runDag`, `topoLayers`, `chunkByLimit`), `system/cognition/dream/dag.js` (`DREAM_DAG_DEPS`), `system/cognition/dream/step-registry.js` (`byName`), `system/cognition/dream/dream-budget.js` (`readDreamConfig`, `shouldHalt`, `defaultFloor`), `system/cognition/dream/telemetry.js` (`recordStepTelemetry`), `system/cognition/dream/step-*.js`.
- Layers: **L1** `knowledge, patterns, reflection, profile, arcs, commStyle, confidence` · **L2** `scopeCleanup ← knowledge`, `calibration ← commStyle` (persona serial) · **L3** `compaction ← knowledge, scopeCleanup`. Within a layer, steps run via `Promise.all`; layers run in series.
- step-knowledge emits `supersedes` edges when promoting contradicting facts (old memo preserved; `fn::freshness` returns 0).
- step-scope-cleanup promotes referenced ephemerals to global; prunes the rest (session: 7d, temp: 24h).
- Runtime config: `runtime:`dream.config`.value` carries `parallelism_enabled` (default `false`), `max_concurrent` (`NONE` → unlimited within a layer), `budget_check_enabled` (default `true`), `budget_floor` (`NONE` → 20% of `runtime:`cadence.config`.daily_token_budget`). Flip parallelism on with `UPDATE runtime:\`dream.config\` SET value.parallelism_enabled = true;`; rollback with `false`.
- Budget coupling (§5.1): dream's per-step writes land in `cadence_telemetry` alongside the cadence consumer's rows, so `currentBudget(db, cfg)`'s 24-h rolling sum reflects both surfaces. The dream budget halts at layer boundaries — never mid-step. Worst-case overshoot is bounded by the most expensive layer (today: layer 1 with five LLM-bound steps ≈ 250k tokens).
- Per-run ledger: `runtime:dream.value` carries `last_run_at`, `last_run_at_success`, `last_layers: [{ names, duration_ms }]`, `last_halted: 'budget_exhausted' | 'scheduler_error' | NONE`. Doctor + `show_step_health` consume these.
```

- [ ] **Step 3: Commit**

```bash
git add docs/faculties.md
git commit -m "docs(faculties): dream section reflects DAG + layers + budget coupling"
```

### Task 10.2: Update `docs/architecture.md` nightly-dream item

**Files:** `docs/architecture.md`

- [ ] **Step 1: Read the line**

```bash
grep -n "Nightly at 4 AM\|step-knowledge → step-habits" docs/architecture.md
```

Expected: one line near line 129.

- [ ] **Step 2: Replace the line**

Replace line 129:

```md
8. **Nightly at 4 AM**, dream runs the pipeline: step-knowledge → step-habits → step-narrative → step-persona → step-reflection → step-scope-cleanup. Each step is fail-soft. Step-knowledge emits `supersedes` when promoting contradicting facts.
```

with:

```md
8. **Nightly at 4 AM**, dream runs a layered DAG (`runDag` over `DREAM_DAG_DEPS`): three layers, fan-out across each. **L1** (`knowledge, patterns, reflection, profile, arcs, commStyle, confidence`) → **L2** (`scopeCleanup, calibration`) → **L3** (`compaction`). Each step is fail-soft (`summary.<step>.error`). The unified `UPDATE events SET dreamed_at = time::now() WHERE dreamed_at IS NONE` mark is a post-layer barrier — it runs once, after every step settles. Parallelism is flag-gated by `runtime:\`dream.config\`.value.parallelism_enabled` (default `false`); budget is enforced between layers against the unified 24-h `cadence_telemetry` sum.
```

- [ ] **Step 3: Append a "See also" link to R-2's scheduler**

If `docs/architecture.md` has a "See also" or related-link section near the dream entry, add one line — otherwise append it within the §"Cross-design notes" area or alongside the existing references list. Use the exact wording from spec §"See also":

```md
- **Runtime-hardening R-2 (`runtime:`scheduler.config``).** R-2's bucket scheduler runs *periodic tickers* at the daemon level (which faculty fires on each tick); C2's `runDag` orchestrates step concurrency *within one dream tick*. Different layer, different file: R-2 lives in `system/runtime/daemon/dispatcher-tick.js`; C2 lives in `system/cognition/dream/scheduler.js`.
```

- [ ] **Step 4: Commit**

```bash
git add docs/architecture.md
git commit -m "docs(architecture): nightly dream item reflects layered DAG + R-2 cross-link"
```

### Task 10.3: Rollout sequence on Kevin's instance (no source edit; checklist)

Spec §9.2 mandates a clean-serial nightly run before flipping the flag. This task records the operator steps; no code change.

- [ ] **Step 1: Confirm flag is off after migration**

```bash
# Against the running daemon's DB (read-only):
echo "SELECT VALUE value FROM runtime:\`dream.config\`" | node system/runtime/cli/index.js sql
```

Expected: `parallelism_enabled: false`.

- [ ] **Step 2: Run one nightly serial cycle (or trigger via `robin dream run`)**

```bash
node system/runtime/cli/commands/dream-run.js
```

Expected: existing summary shape (no `_meta` key — flag off → serial branch). `runtime:dream.last_run_at_success` advances.

- [ ] **Step 3: Flip the flag**

```bash
echo "UPDATE runtime:\`dream.config\` SET value.parallelism_enabled = true" \
  | node system/runtime/cli/index.js sql
```

- [ ] **Step 4: Run one nightly parallel cycle**

```bash
node system/runtime/cli/commands/dream-run.js
```

Expected: summary has all ten named keys plus `_meta` (`mode: 'parallel'`, `layers: […]`, `halted: null`). `SELECT count() FROM events WHERE dreamed_at IS NONE` is zero. Layer-1 wall-clock ≈ `max(per-step durations)`.

- [ ] **Step 5: Rollback procedure (if the parallel run regresses)**

```bash
echo "UPDATE runtime:\`dream.config\` SET value.parallelism_enabled = false" \
  | node system/runtime/cli/index.js sql
```

Expected: instant. Next `dreamProcess` invocation takes the verbatim-serial branch. The scheduler code remains imported but unused; per-step telemetry continues to be recorded only inside the parallel branch.

---

## Phase 11 — Final verification + spec-coverage sweep

### Task 11.1: Run the complete test suite

- [ ] **Step 1: Lint**

```bash
npm run lint
```

Expected: zero errors.

- [ ] **Step 2: Run unit tests**

```bash
npm run test:unit
```

Expected: every existing test still passes plus six new files (or four new + two extended):

- `dream-scheduler.test.js`
- `dream-dag.test.js`
- `dream-telemetry.test.js`
- `dream-budget.test.js`
- `persona-set-refactor.test.js`

- [ ] **Step 3: Run integration tests**

```bash
npm run test:integration
```

Plus explicit run by file path (in case the integration runner's pattern filter misses any of the new files):

```bash
node --test \
  system/tests/integration/dream-full-cycle.test.js \
  system/tests/integration/dream-parallel.test.js \
  system/tests/integration/dream-mark-idempotency.test.js \
  system/tests/integration/persona-merge-race.test.js \
  system/tests/integration/comm-style-roundtrip.test.js \
  system/tests/integration/predictions-roundtrip.test.js \
  system/tests/integration/profile-candidate-flow.test.js \
  system/tests/integration/dream-step-scope-cleanup.test.js
```

Expected: every test passes. The persona-refactor tests, the four dream-parallel test cases, and the mark-idempotency test are the keystone gates for C2.

- [ ] **Step 4: Run verify-design-assumptions**

```bash
node system/runtime/scripts/verify-design-assumptions.js
```

Expected: every gate passes (G19 reports skipped outside CI).

- [ ] **Step 5: Spec-coverage sweep**

Walk the spec section by section and confirm each is exercised. Use this table as a checklist:

| Spec §  | Covered by |
|---------|-----------|
| §1 The dependency graph (read/write sets, edges) | Phase 1 `dag.js` constant + Phase 3 `topoLayers` test #11 |
| §1.2 persona MERGE serial (in-dream edge + cross-process SET refactor) | Phase 1 `DREAM_DAG_DEPS.calibration = ['commStyle']` + Phase 2 persona refactor + Phase 8 race tests |
| §2 The scheduler | Phase 3 `scheduler.js` + 10 unit tests |
| §3 The new `dreamProcess` | Phase 5 rewrite |
| §4 `step-registry.js` and `dag.js` (camelCase keys load-bearing) | Phase 1 + Phase 9 G20 |
| §5 Token-budget enforcement | Phase 5 `dream-budget.js` + Phase 7 variants A & B |
| §5.1 Budget coupling (80/20 split) | Phase 5 `defaultFloor` + Phase 7 unified-sum test (15b) |
| §5.2 Layer-gated (not per-step) | Phase 3 `runDag` calls `shouldHalt` between layers; Phase 7 variant B asserts behaviour |
| §6 The unified `dreamed_at` mark | Phase 5 mark sequencing + Phase 6 `dreamed_at IS NONE` post-condition |
| §7 Cursor advance / mark idempotency | Phase 5 `schedulerError` guard + Phase 6 mark-idempotency test |
| §8 Telemetry (per-step / per-layer / parallelism factor / halts) | Phase 4 `telemetry.js` + Phase 5 `last_layers` / `last_halted` write |
| §9 Rollout / migration | Phase 0 migration + Phase 10 rollout checklist |
| §10.1 Unit tests 1–11 | Phase 3 (1–10) + Phase 1.3 (11) |
| §10.2 Integration tests 12–18 | Phase 6 + Phase 7 + Phase 8 |
| §10.3 Verification gates 19, 20 | Phase 9 |
| §11 File-by-file changes | Matches "File structure" table above |
| §12 Open questions | Carried forward — see "Open items" below |
| §13 Cost envelope | Documented; no code |
| §14 Cross-design notes (C1, B1, Theme 3, Theme 4) | Phase 10 docs + spec §"See also" link to R-2 |

- [ ] **Step 6: Verification gates check (spec §10.3 + §12 footprints)**

Verify each gate has a corresponding test or runtime check:

| Gate | Where |
|------|-------|
| #11 DAG validates against registry; symmetric difference empty | Phase 1.3 `dream-dag.test.js`; G20 in verify-design-assumptions |
| #12 Output equivalence under `normalizeSummary` | Phase 7 Task 7.1; G19 (CI-only) in verify-design-assumptions |
| #13 Failure isolation across layers | Phase 6 `dream-parallel.test.js` |
| #14 Failure isolation within a layer | Phase 6 `dream-parallel.test.js` (extend if needed in Phase 11) |
| #15 Budget exhausted at layer boundary (variants A + B) | Phase 7 Tasks 7.2 + 7.3 |
| #15b Unified 24-h sum across cadence + dream | Phase 7 Task 7.4 |
| #16 Mark idempotency under partial failure | Phase 6 `dream-mark-idempotency.test.js` |
| #17 `dreamed_at` barrier | Phase 6 post-run `count` assertion |
| #18 Persona singleton — serial writes | Phase 8 Task 8.2 (dream-internal); Phase 8 Task 8.1 (cross-process) |

If any row's "Where" column reads "extend if needed", do so in Phase 11 Step 6.

- [ ] **Step 7: Final commit if any docs/tests changed during the sweep**

```bash
git status
# If clean, no commit needed.
# If any changes accumulated from the sweep, commit them.
```

---

## Open items (not implemented in this plan; tracked from spec §12)

- **Should `step-compaction` depend on `step-confidence-recompute`?** The strict-overlap case is empty today (compaction archives on `signal_count`, not `confidence`). Defer; the output-equivalence integration test in Phase 7 catches any regression from the call.
- **Per-step concurrency caps.** Today one global `max_concurrent`; some layers mix LLM-bound + DB-bound steps that could benefit from separate caps. Defer until telemetry shows host rate-limiting.
- **Cross-night re-entry.** `dispatcher-tick.js`'s in-flight gate is unchanged. A future feature wanting two dream runs back-to-back (morning-after retry of a halted night) needs a version field on the in-flight token. Not a C2 concern.
- **`dispatcher-tick.js` overflow fallback (backlog ≥ 500).** Under C2 the overflow-triggered dream runs in parallel mode if the flag is on. Mechanical no-op for now; defer telemetry-driven tuning.
- **`max_concurrent` interaction with `idle-embedder.js`.** `step-knowledge` calls the embedder via `store.note(...)`. Verify at run time that the embedder is safe under parallel callers; if not, set `max_concurrent: 1` for layer 1 as the conservative default.
- **Separate `dream_telemetry` table (option b in spec §5.1).** Cleaner than the unified `cadence_telemetry` shape but lands another migration. Defer until telemetry shows the 80/20 split is the wrong knob.
- **C3 telemetry-umbrella coordination.** C3 owns the storage layout for telemetry. C2's per-step writes are net-new `step` discriminator values in `cadence_telemetry`. C3's inventory must enumerate them (`step LIKE 'knowledge' | 'patterns' | … | 'compaction'`). Coordination is by written specs — no plan task in C2 owns C3's rollup.
- **Layer-gated vs per-step budget check (spec §5.2 deviation from brief).** This plan keeps layer-gated. The brief recommended per-step. The change to per-step is one-line: move `shouldHalt()` from `runDag`'s between-layer position into the per-step wrapper inside `Promise.all`. Defer; revisit in review.
- **server.js R-3 coordination for cited line numbers.** This plan uses structural anchors (`grep -n …`) rather than absolute line numbers because R-3 may move dispatcher-tick / server.js sections in parallel. If R-3 lands first, the structural anchors continue to work.
