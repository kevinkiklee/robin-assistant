# Cognition D1 — state_inference activation · Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up `state_inference` as a first-class memo kind with a heartbeat-paced faculty (one inference per active source), a 6-hour half-life, a privileged `<!-- current focus -->` recall block above the existing `<!-- relevant memory -->` block, a calibration ledger loop, and one Theme-4 introspection MCP tool (`explain_state_inference`). Ship behind a three-valued runtime flag (`false` | `'shadow'` | `true`).

**Architecture:** A new internal job in `system/cognition/jobs/internal/state-inference.js` ticks every 5 min per active episode source, gates LLM calls behind a SHA-256 signal-hash change detector over `(entity refs, arc_id, last_event_id)`, calls `host.invokeLLM` (fast tier) to produce a one-sentence focus statement, writes a `kind='state_inference'` memo through `store.note` via a thin lens in `system/cognition/memory/state_inference.js`, supersedes the prior inference, and emits one corroborate/refute row to `evidence_ledger` per pivot or hold. The intuition path (`system/cognition/intuition/inject.js`) prepends the focus block under a 200-token cap when the latest inference is fresh, confident, and not pivoted. Privacy propagates upward from entities and lineage events through scope inheritance.

**Tech Stack:** Node.js 22+ (ESM), SurrealDB 3.0.5 + `@surrealdb/node` 3.0.3 + `surrealdb` 2.0.3, `host.invokeLLM` (existing fast-tier wrapper), Node `node:crypto` `sha256` (already wrapped at `system/data/embed/hash.js`).

**Spec:** `docs/superpowers/specs/2026-05-11-cognition-d1-state-inference-design.md`

**Dependencies:** Themes 1b (`arcs` + `episodes.last_event_at`), 2a (`evidence_ledger`, `addEvidence`), 3 (cadence telemetry conventions), 4 (introspection tool template), and the `refactor/system-restructure` package layout (already merged).

---

## File structure

| File | Status | Responsibility |
|---|---|---|
| `system/data/db/migrations/0012-state-inference.surql` | new | D1-initial-off: `state_inference_telemetry` table + indexes, `memos_state_inference_source` index on `memos`, `runtime:state_inference.config` seed (`enabled: false`) |
| `system/data/db/migrations/0013-state-inference-shadow.surql` | new (Phase 12) | D1-shadow-flip: `UPSERT runtime:\`state_inference.config\` SET value.enabled = 'shadow'` |
| `system/data/db/migrations/0014-state-inference-enable.surql` | new (Phase 12) | D1-default-on: `UPSERT runtime:\`state_inference.config\` SET value.enabled = true` |
| `system/cognition/memory/decay.js` | modify | Add `state_inference: 6h` to `HALF_LIFE_BY_KIND_MS` |
| `system/cognition/memory/state_inference.js` | new | Lens: `noteStateInference`, `latestForSource`, `listRecent` |
| `system/cognition/jobs/internal/state-inference.js` | new | Heartbeat-paced job: `evaluateStateInference(db, host, embedder)` and `composeForSource(...)` (active-source loop, change-detect gate, calibration sub-step, LLM call, write, supersede, telemetry) |
| `system/cognition/jobs/builtin/state-inference.md` | new | Operator-facing manifest (mirrors `reinforce-recall.md`) |
| `system/cognition/intuition/inject.js` | modify | Accept `source`; fetch latest non-stale inference; prepend `<!-- current focus -->` block; apply 7 suppression rules; widen response wire format |
| `system/cognition/intuition/handler.js` | modify | Resolve `source` via `ROBIN_SOURCE` → CLAUDE_PROJECT_DIR / GEMINI_CLI_SESSION heuristic → null; include in POST body; concatenate `focus_block + block` to stdout |
| `system/runtime/daemon/server.js` | modify | Register 5-min `state-inference` ticker (mirrors `closeStaleEpisodes` block); register `createExplainStateInferenceTool`; forward `body.source` (with `host?.name` + episode-source fallback) into `intuitionEndpoint` |
| `system/io/mcp/tools/explain-state-inference.js` | new | Read-only Theme-4 tool: `{ current, history, evidence_replay }` with private-scope redaction |
| `system/runtime/cli/health.js` | modify | New `rollupStateInference(db)` rollup + wired into `runHealth` |
| `system/tests/unit/state-inference-compose.test.js` | new | U1–U6 (change-detect, no-op, supersede, drop, clamp, privacy inheritance) |
| `system/tests/unit/state-inference-privacy.test.js` | new | A1–A2 (private redaction in tool; entity-scope inheritance) |
| `system/tests/unit/audit-introspection-readonly.test.js` | modify | Add `explain-state-inference.js` to allowlist |
| `system/tests/integration/state-inference-cycle.test.js` | new | I1–I9 + E1–E2 (full cycle, suppression, supersedes, privacy, calibration, disabled, shadow, end-to-end, concurrency) |
| `docs/faculties.md` | modify | New "state inference" subsection under Process faculties; new tool in introspection list |
| `docs/architecture.md` | modify | Mention `state_inference` faculty + new heartbeat ticker + focus block in the agent turn |

---

## Phase 1 — Schema, half-life, config seed

### Task 1.1: Add the half-life entry to `decay.js`

**Files:** `system/cognition/memory/decay.js`

- [ ] **Step 1: Write a failing test asserting `freshness({ kind: 'state_inference' })` decays on a 6h half-life.**

Create `system/tests/unit/state-inference-decay.test.js`:

```js
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { freshness, HALF_LIFE_BY_KIND_MS } from '../../cognition/memory/decay.js';

test('state_inference has 6h half-life', () => {
  assert.equal(HALF_LIFE_BY_KIND_MS.state_inference, 6 * 60 * 60 * 1000);
});

test('state_inference freshness halves at 6h', () => {
  const now = new Date('2026-05-11T18:00:00Z');
  const anchor = new Date(now.getTime() - 6 * 60 * 60 * 1000);
  const memo = { kind: 'state_inference', confidence: 1, signal_count: 1, decay_anchor: anchor };
  const v = freshness(memo, { now });
  // 0.5 (decay) × 1.0 (confidence) × log2(2) = 0.5
  assert.ok(Math.abs(v - 0.5) < 1e-6, `expected ~0.5, got ${v}`);
});

test('supersededCount>0 zeroes state_inference freshness', () => {
  const now = new Date();
  const memo = { kind: 'state_inference', confidence: 1, decay_anchor: now };
  assert.equal(freshness(memo, { supersededCount: 1, now }), 0);
});
```

- [ ] **Step 2: Run the test — expect failure.**

```bash
npm run test:unit -- --test-name-pattern='state_inference has 6h half-life'
```

Expected: `not ok` because the entry is missing.

- [ ] **Step 3: Add the entry.**

Edit `system/cognition/memory/decay.js`. Inside the `HALF_LIFE_BY_KIND_MS` object literal (currently four entries through `prediction`), append:

```js
  state_inference: 6 * 60 * 60 * 1000, // 6h — focus shifts over hours, not days (D1 spec §2.2)
```

- [ ] **Step 4: Re-run the test — expect pass.**

```bash
npm run test:unit -- --test-name-pattern='state_inference'
```

Expected: all three assertions pass.

- [ ] **Step 5: Run lint.**

```bash
npm run lint
```

Expected: no errors.

- [ ] **Step 6: Commit.**

```bash
git add system/cognition/memory/decay.js system/tests/unit/state-inference-decay.test.js
git commit -m "feat(decay): add state_inference half-life (6h)"
```

### Task 1.2: Migration `0012-state-inference.surql` (D1-initial-off)

**Files:** `system/data/db/migrations/0012-state-inference.surql` (new)

- [ ] **Step 1: Verify `0012` is free.**

```bash
ls system/data/db/migrations/
```

Expected: no `0012-*` file. If a higher-numbered migration has shipped between plan-write and plan-execute, bump the D1 trio (initial-off, shadow-flip, default-on) to the next three sequential numbers and update every reference in this plan + spec §3.4 + spec §9.1 + spec §11 in the same commit. The cross-cutting decisions section at the top of the review log names the trio as D1-initial-off / D1-shadow-flip / D1-default-on — those labels are stable; the digits are not.

- [ ] **Step 2: Write the migration file.**

Create `system/data/db/migrations/0012-state-inference.surql`:

```surql
-- ============================================================================
-- Cognition D1-initial-off: state_inference activation (schema + dark-launch)
--
-- Adds:
--   1. memos_state_inference_source — composite index for `latestForSource` lookups
--      filtered by (kind, meta.source, derived_at).
--   2. state_inference_telemetry — per-tick outcome table consumed by
--      show_step_health and the rollout decision (spec §3.3).
--   3. runtime:state_inference.config — config row seeded with enabled=false
--      (three-valued: false | 'shadow' | true).
--
-- No DDL changes to memos: `state_inference` is already a valid kind
-- (kind-registry.js lines 31–37).
--
-- NOTE: fn::freshness mirror is intentionally deferred (spec §3.4) — the
-- recall pipeline never sorts state_inference by server-side freshness; the
-- client-side decay.js mirror is authoritative. A TODO comment near the
-- HALF_LIFE_BY_KIND_MS function in 0001-init.surql tracks the pairing.
-- ============================================================================

DEFINE INDEX memos_state_inference_source ON memos FIELDS kind, meta.source, derived_at;

DEFINE TABLE state_inference_telemetry SCHEMAFULL TYPE NORMAL;
DEFINE FIELD ts          ON state_inference_telemetry TYPE datetime DEFAULT time::now() READONLY;
DEFINE FIELD source      ON state_inference_telemetry TYPE string;
DEFINE FIELD outcome     ON state_inference_telemetry TYPE string;
  -- 'wrote' | 'skipped_unchanged' | 'skipped_disabled' | 'dropped_thin' | 'error'
DEFINE FIELD signal_hash ON state_inference_telemetry TYPE option<string>;
DEFINE FIELD tokens_in   ON state_inference_telemetry TYPE option<int>;
DEFINE FIELD tokens_out  ON state_inference_telemetry TYPE option<int>;
DEFINE FIELD latency_ms  ON state_inference_telemetry TYPE option<int>;
DEFINE FIELD reason      ON state_inference_telemetry TYPE option<string>;
DEFINE INDEX si_tel_ts        ON state_inference_telemetry FIELDS ts;
DEFINE INDEX si_tel_source_ts ON state_inference_telemetry FIELDS source, ts;

UPSERT runtime:`state_inference.config` SET value = {
  enabled: false,
  tick_ms: 300000,
  attention_window_min: 90,
  refresh_after_minutes: 30,
  min_events_for_inference: 2,
  max_sources_per_tick: 4,
  min_confidence_to_surface: 0.5,
  stale_after_minutes: 120,
  pivot_weight: 1.0,
  corroborate_weight: 1.0
};
```

- [ ] **Step 3: Write a migration smoke test.**

Create `system/tests/unit/state-inference-migration.test.js`:

```js
import assert from 'node:assert/strict';
import { mkdirSync as __mk } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { writeConfig } from '../../config/paths.js';
import { close, connect } from '../../data/db/client.js';
import { runMigrations } from '../../data/db/migrate.js';

const HOME = join(tmpdir(), `robin-mig-${process.pid}-${Math.random().toString(36).slice(2)}`);
__mk(HOME, { recursive: true });
process.env.ROBIN_HOME = HOME;
await writeConfig({ embedder_profile: 'mxbai-1024' });

test('0012 migration applies cleanly and seeds runtime:state_inference.config', async () => {
  const db = await connect({ engine: 'mem://' });
  try {
    await runMigrations(db, resolve(import.meta.dirname, '../../data/db/migrations'));
    const [rows] = await db
      .query('SELECT VALUE value FROM runtime:`state_inference.config`')
      .collect();
    const cfg = rows?.[0];
    assert.ok(cfg, 'expected runtime:state_inference.config row');
    assert.equal(cfg.enabled, false);
    assert.equal(cfg.tick_ms, 300000);
    assert.equal(cfg.attention_window_min, 90);
    assert.equal(cfg.refresh_after_minutes, 30);
    assert.equal(cfg.max_sources_per_tick, 4);
    assert.equal(cfg.min_confidence_to_surface, 0.5);
    assert.equal(cfg.stale_after_minutes, 120);
  } finally {
    await close(db);
  }
});

test('state_inference_telemetry table is defined', async () => {
  const db = await connect({ engine: 'mem://' });
  try {
    await runMigrations(db, resolve(import.meta.dirname, '../../data/db/migrations'));
    // SurrealDB 3.x: `INFO FOR DB` returns tables under the `tb` key.
    // Rather than dig into the engine-specific shape (which can shift
    // between releases), assert the table is queryable: a SELECT against a
    // missing table throws. LIMIT 0 keeps it free.
    await db.query('SELECT 1 FROM state_inference_telemetry LIMIT 0').collect();
  } finally {
    await close(db);
  }
});
```

- [ ] **Step 4: Run the migration test — expect pass.**

```bash
npm run test:unit -- --test-name-pattern='0012 migration|state_inference_telemetry'
```

Expected: both tests pass.

- [ ] **Step 5: Commit.**

```bash
git add system/data/db/migrations/0012-state-inference.surql system/tests/unit/state-inference-migration.test.js
git commit -m "feat(schema): 0012 state_inference index + telemetry table + config seed"
```

---

## Phase 2 — `state_inference` lens

### Task 2.1: Lens module with `noteStateInference` / `latestForSource` / `listRecent`

**Files:** `system/cognition/memory/state_inference.js` (new)

- [ ] **Step 1: Write failing unit tests for the lens.**

Create `system/tests/unit/state-inference-lens.test.js`:

```js
import assert from 'node:assert/strict';
import { mkdirSync as __mk } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import {
  latestForSource,
  listRecent,
  noteStateInference,
} from '../../cognition/memory/state_inference.js';
import { writeConfig } from '../../config/paths.js';
import { close, connect } from '../../data/db/client.js';
import { runMigrations } from '../../data/db/migrate.js';
import { createStubEmbedder } from '../../data/embed/embedder.js';

const HOME = join(tmpdir(), `robin-lens-${process.pid}-${Math.random().toString(36).slice(2)}`);
__mk(HOME, { recursive: true });
process.env.ROBIN_HOME = HOME;
await writeConfig({ embedder_profile: 'mxbai-1024' });

async function fresh() {
  const db = await connect({ engine: 'mem://' });
  await runMigrations(db, resolve(import.meta.dirname, '../../data/db/migrations'));
  return db;
}

test('noteStateInference writes a kind=state_inference memo with derived_by=state-inference', async () => {
  const db = await fresh();
  const e = createStubEmbedder({ dimension: 1024 });
  const { id } = await noteStateInference(db, e, {
    source: 'agent:claude-code',
    content: 'Kevin is reviewing the cognition refactor.',
    confidence: 0.8,
    entities: [],
    arc_id: null,
    last_event_id: null,
    evidence_snippet: 'reviewing inject.js',
    last_active_at: new Date(),
    from_signal: ['attention'],
    signal_hash: 'abc',
    scope: 'global',
  });
  const [rows] = await db.query(`SELECT * FROM ONLY $id`, { id }).collect();
  const memo = rows?.[0] ?? rows;
  assert.equal(memo.kind, 'state_inference');
  assert.equal(memo.derived_by, 'state-inference');
  assert.equal(memo.scope, 'global');
  assert.equal(memo.meta.dimension, 'current_focus');
  assert.equal(memo.meta.source, 'agent:claude-code');
  assert.equal(memo.meta.signal_hash, 'abc');
  assert.deepEqual(memo.meta.from_signal, ['attention']);
  await close(db);
});

test('latestForSource returns most-recent non-superseded memo', async () => {
  const db = await fresh();
  const e = createStubEmbedder({ dimension: 1024 });
  const a = await noteStateInference(db, e, {
    source: 'agent:claude-code',
    content: 'A',
    confidence: 0.5,
    entities: [],
    last_active_at: new Date(Date.now() - 60_000),
    signal_hash: 'h1',
  });
  const b = await noteStateInference(db, e, {
    source: 'agent:claude-code',
    content: 'B',
    confidence: 0.6,
    entities: [],
    last_active_at: new Date(),
    signal_hash: 'h2',
  });
  // Mark a as superseded by b.
  await db
    .query(
      `RELATE $from->supersedes->$to CONTENT { kind: 'supersedes' }`,
      { from: b.id, to: a.id },
    )
    .collect();
  const latest = await latestForSource(db, 'agent:claude-code');
  assert.ok(latest);
  assert.equal(String(latest.id), String(b.id));
  await close(db);
});

test('latestForSource returns null when source has no memo', async () => {
  const db = await fresh();
  const latest = await latestForSource(db, 'agent:nope');
  assert.equal(latest, null);
  await close(db);
});

test('listRecent returns all state_inference rows ordered by derived_at desc, limited', async () => {
  const db = await fresh();
  const e = createStubEmbedder({ dimension: 1024 });
  for (let i = 0; i < 4; i++) {
    await noteStateInference(db, e, {
      source: 'agent:claude-code',
      content: `c${i}`,
      confidence: 0.5,
      entities: [],
      last_active_at: new Date(Date.now() - (4 - i) * 1000),
      signal_hash: `h${i}`,
    });
  }
  const rows = await listRecent(db, { limit: 2 });
  assert.equal(rows.length, 2);
  assert.equal(rows[0].content, 'c3');
  await close(db);
});
```

- [ ] **Step 2: Run the tests — expect failure (module missing).**

```bash
npm run test:unit -- --test-name-pattern='state_inference-lens|noteStateInference|latestForSource|listRecent'
```

Expected: module-not-found error.

- [ ] **Step 3: Write the lens module.**

Create `system/cognition/memory/state_inference.js`:

```js
// state_inference.js — lens for kind='state_inference' memos.
// Cognition D1 spec §1.1, §2. Thin wrapper around store.note that bakes
// kind='state_inference', derived_by='state-inference', and meta.dimension
// (default 'current_focus') into the write path. Read APIs filter by
// meta.source and (implicitly) exclude superseded rows.

import { BoundQuery, surql } from 'surrealdb';
import * as store from './store.js';

const DEFAULT_DIMENSION = 'current_focus';
const DEFAULT_DERIVED_BY = 'state-inference';

/**
 * Write a state_inference memo.
 *
 * @param {import('surrealdb').Surreal} db
 * @param {{embed:(t:string)=>Promise<Float32Array>}} embedder
 * @param {{
 *   source: string,                         // 'agent:claude-code' etc.
 *   content: string,                        // ≤ 240 chars; caller clamps
 *   confidence: number,                     // already clamped to [0.05, 0.95]
 *   entities?: import('surrealdb').RecordId[],  // → meta.entities + about edges
 *   arc_id?: import('surrealdb').RecordId|null,
 *   last_event_id?: import('surrealdb').RecordId|null,
 *   lineage?: import('surrealdb').RecordId[],   // up to 5 contributing event refs
 *   evidence_snippet?: string,              // ≤ 120 chars
 *   last_active_at: Date,
 *   from_signal: string[],                  // e.g. ['attention','arcs','biographer']
 *   signal_hash: string,
 *   dimension?: string,                     // defaults to 'current_focus'
 *   scope?: string,                         // 'global' (default) or 'private'
 *   tags?: string[],
 * }} input
 * @returns {Promise<{ id: import('surrealdb').RecordId, deduped: boolean }>}
 */
export async function noteStateInference(db, embedder, input) {
  if (!input?.source) throw new Error('noteStateInference: source required');
  if (!input?.content) throw new Error('noteStateInference: content required');
  if (!input?.signal_hash) throw new Error('noteStateInference: signal_hash required');
  if (!(input.last_active_at instanceof Date)) {
    throw new Error('noteStateInference: last_active_at must be a Date');
  }

  const entities = Array.isArray(input.entities) ? input.entities : [];
  const lineage = Array.isArray(input.lineage) ? input.lineage : [];

  const meta = {
    dimension: input.dimension ?? DEFAULT_DIMENSION,
    source: input.source,
    entities: entities.map((id) => String(id)),
    arc_id: input.arc_id != null ? String(input.arc_id) : null,
    last_event_id: input.last_event_id != null ? String(input.last_event_id) : null,
    evidence_snippet: input.evidence_snippet ?? null,
    last_active_at: input.last_active_at.toISOString(),
    from_signal: Array.isArray(input.from_signal) ? input.from_signal : [],
    signal_hash: input.signal_hash,
  };

  return await store.note(db, embedder, 'state_inference', {
    content: input.content,
    confidence: input.confidence,
    derived_by: DEFAULT_DERIVED_BY,
    scope: input.scope ?? 'global',
    tags: Array.isArray(input.tags) ? input.tags : [],
    subjects: entities,
    lineage,
    meta,
  });
}

/**
 * Most-recent non-superseded state_inference memo for a source. Returns null
 * when the source has no memo or all memos are superseded.
 *
 * Filter chain (mirrors the spec §1.3 step 1):
 *   - kind = 'state_inference'
 *   - meta.source = <source>
 *   - no inbound supersedes edge (`<-supersedes` count = 0)
 *   - ORDER BY derived_at DESC LIMIT 1
 */
export async function latestForSource(db, source) {
  if (!source) return null;
  const [rows] = await db
    .query(
      surql`SELECT * FROM memos
            WHERE kind = 'state_inference'
              AND meta.source = ${source}
              AND count(<-supersedes) = 0
            ORDER BY derived_at DESC
            LIMIT 1`,
    )
    .collect();
  const row = rows?.[0];
  return row ?? null;
}

/**
 * Recent state_inference memos across all sources (superseded included or
 * excluded per `includeSuperseded`). Used by `explain_state_inference` and
 * by `robin doctor --health` rollups.
 */
export async function listRecent(db, { limit = 20, source, includeSuperseded = false } = {}) {
  const clauses = [`kind = 'state_inference'`];
  const binds = { limit };
  if (source) {
    clauses.push(`meta.source = $source`);
    binds.source = source;
  }
  if (!includeSuperseded) {
    clauses.push(`count(<-supersedes) = 0`);
  }
  const sql = `SELECT * FROM memos WHERE ${clauses.join(' AND ')} ORDER BY derived_at DESC LIMIT $limit`;
  const [rows] = await db.query(new BoundQuery(sql, binds)).collect();
  return rows ?? [];
}
```

- [ ] **Step 4: Run the tests — expect pass.**

```bash
npm run test:unit -- --test-name-pattern='noteStateInference|latestForSource|listRecent'
```

Expected: all four tests pass.

- [ ] **Step 5: Lint + commit.**

```bash
npm run lint
git add system/cognition/memory/state_inference.js system/tests/unit/state-inference-lens.test.js
git commit -m "feat(memory): state_inference lens (noteStateInference, latestForSource, listRecent)"
```

---

## Phase 3 — Change detection

### Task 3.1: Pure change-detection helper

**Files:** `system/cognition/jobs/internal/state-inference.js` (new, partial — exports `computeSignalHash` + `detectChange` first)

- [ ] **Step 1: Write failing unit tests for the helpers.**

Create `system/tests/unit/state-inference-change-detect.test.js`:

```js
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  computeSignalHash,
  detectChange,
} from '../../cognition/jobs/internal/state-inference.js';

test('computeSignalHash is stable across entity ordering', () => {
  const h1 = computeSignalHash({
    entities: ['entities:a', 'entities:b', 'entities:c'],
    arc_id: 'arcs:x',
    last_event_id: 'events:1',
  });
  const h2 = computeSignalHash({
    entities: ['entities:c', 'entities:a', 'entities:b'],
    arc_id: 'arcs:x',
    last_event_id: 'events:1',
  });
  assert.equal(h1, h2);
});

test('computeSignalHash differs when arc_id changes', () => {
  const h1 = computeSignalHash({ entities: ['entities:a'], arc_id: 'arcs:x', last_event_id: null });
  const h2 = computeSignalHash({ entities: ['entities:a'], arc_id: 'arcs:y', last_event_id: null });
  assert.notEqual(h1, h2);
});

test('detectChange: no prior → materially_changed=true, reason=no_prior', () => {
  const r = detectChange({
    prior: null,
    current: { entities: [], arc_id: null, last_event_id: null },
    now: new Date(),
    refreshAfterMinutes: 30,
  });
  assert.equal(r.materially_changed, true);
  assert.equal(r.reason, 'no_prior');
  assert.equal(typeof r.signal_hash, 'string');
});

test('detectChange: same hash + fresh → materially_changed=false', () => {
  const sig = computeSignalHash({ entities: ['entities:a'], arc_id: null, last_event_id: null });
  const prior = {
    meta: {
      signal_hash: sig,
      last_active_at: new Date(Date.now() - 5 * 60_000).toISOString(),
    },
  };
  const r = detectChange({
    prior,
    current: { entities: ['entities:a'], arc_id: null, last_event_id: null },
    now: new Date(),
    refreshAfterMinutes: 30,
  });
  assert.equal(r.materially_changed, false);
  assert.equal(r.reason, 'unchanged');
  assert.equal(r.signal_hash, sig);
});

test('detectChange: hash differs → materially_changed=true, reason=hash_differs', () => {
  const oldSig = computeSignalHash({ entities: ['entities:a'], arc_id: null, last_event_id: null });
  const prior = {
    meta: { signal_hash: oldSig, last_active_at: new Date().toISOString() },
  };
  const r = detectChange({
    prior,
    current: { entities: ['entities:b'], arc_id: null, last_event_id: null },
    now: new Date(),
    refreshAfterMinutes: 30,
  });
  assert.equal(r.materially_changed, true);
  assert.equal(r.reason, 'hash_differs');
});

test('detectChange: prior older than refresh window → materially_changed=true, reason=refresh_window', () => {
  const sig = computeSignalHash({ entities: ['entities:a'], arc_id: null, last_event_id: null });
  const stale = new Date(Date.now() - 45 * 60_000);
  const prior = { meta: { signal_hash: sig, last_active_at: stale.toISOString() } };
  const r = detectChange({
    prior,
    current: { entities: ['entities:a'], arc_id: null, last_event_id: null },
    now: new Date(),
    refreshAfterMinutes: 30,
  });
  assert.equal(r.materially_changed, true);
  assert.equal(r.reason, 'refresh_window');
});

// Spec §1.3 step 5 enumerates three "change detected" inputs: hash differs
// (entities or arc or last_event_id flipped) OR the refresh window crossed.
// The hash already mixes entities + arc + last_event_id; these three cases
// pin each component independently so that no future hash change accidentally
// collapses one axis into another.

test('detectChange: entities unchanged + arc changed only → materially_changed=true', () => {
  const priorHash = computeSignalHash({ entities: ['entities:a'], arc_id: 'arcs:x', last_event_id: null });
  const prior = {
    meta: { signal_hash: priorHash, last_active_at: new Date().toISOString() },
  };
  const r = detectChange({
    prior,
    current: { entities: ['entities:a'], arc_id: 'arcs:y', last_event_id: null },
    now: new Date(),
    refreshAfterMinutes: 30,
  });
  assert.equal(r.materially_changed, true);
  assert.equal(r.reason, 'hash_differs');
});

test('detectChange: entities unchanged + last_event_id changed only → materially_changed=true', () => {
  const priorHash = computeSignalHash({
    entities: ['entities:a'],
    arc_id: null,
    last_event_id: 'events:1',
  });
  const prior = {
    meta: { signal_hash: priorHash, last_active_at: new Date().toISOString() },
  };
  const r = detectChange({
    prior,
    current: { entities: ['entities:a'], arc_id: null, last_event_id: 'events:2' },
    now: new Date(),
    refreshAfterMinutes: 30,
  });
  assert.equal(r.materially_changed, true);
  assert.equal(r.reason, 'hash_differs');
});

test('detectChange: entities + arc + last_event_id all unchanged + time threshold crossed → materially_changed=true', () => {
  const sig = computeSignalHash({
    entities: ['entities:a'],
    arc_id: 'arcs:x',
    last_event_id: 'events:1',
  });
  // 31 min ago, with refreshAfterMinutes=30 — only the time threshold has
  // crossed; every other input is identical.
  const prior = {
    meta: {
      signal_hash: sig,
      last_active_at: new Date(Date.now() - 31 * 60_000).toISOString(),
    },
  };
  const r = detectChange({
    prior,
    current: { entities: ['entities:a'], arc_id: 'arcs:x', last_event_id: 'events:1' },
    now: new Date(),
    refreshAfterMinutes: 30,
  });
  assert.equal(r.materially_changed, true);
  assert.equal(r.reason, 'refresh_window');
});
```

- [ ] **Step 2: Run the tests — expect failure.**

```bash
npm run test:unit -- --test-name-pattern='computeSignalHash|detectChange'
```

Expected: module-not-found.

- [ ] **Step 3: Implement the helpers (initial skeleton).**

Create `system/cognition/jobs/internal/state-inference.js` with the two exports (we'll grow the file in Phase 4/5):

```js
// state-inference.js — heartbeat-paced internal job that produces
// kind='state_inference' memos per active source.
//
// Cognition D1 spec §1, §5. This file contains the per-source pipeline
// (composeForSource), the active-source loop entry point
// (evaluateStateInference), and two pure helpers (computeSignalHash,
// detectChange) that are unit-tested in isolation.

import { sha256 } from '../../../data/embed/hash.js';

/**
 * Stable hash over the inputs that define "what is the user working on?":
 *   - sorted entity record-ref strings
 *   - String(arc_id ?? null)
 *   - String(last_event_id ?? null)
 *
 * Sorting makes the hash insensitive to attention-lens ordering jitter.
 *
 * @param {{ entities: (string|object)[], arc_id?: string|null, last_event_id?: string|null }} inputs
 * @returns {string} hex SHA-256
 */
export function computeSignalHash({ entities = [], arc_id = null, last_event_id = null } = {}) {
  const ents = entities
    .map((e) => (e == null ? '' : String(e)))
    .filter((s) => s.length > 0)
    .sort();
  const payload = JSON.stringify({
    entities: ents,
    arc_id: arc_id == null ? null : String(arc_id),
    last_event_id: last_event_id == null ? null : String(last_event_id),
  });
  return sha256(payload);
}

/**
 * Decide whether the current snapshot differs materially from the prior
 * inference. Returns { materially_changed, signal_hash, reason } where
 * reason ∈ { 'no_prior', 'hash_differs', 'refresh_window', 'unchanged' }.
 *
 * Spec §1.3 step 5.
 *
 * @param {{
 *   prior: { meta?: { signal_hash?: string, last_active_at?: string|Date } } | null,
 *   current: { entities: (string|object)[], arc_id?: string|null, last_event_id?: string|null },
 *   now?: Date,
 *   refreshAfterMinutes?: number,
 * }} args
 */
export function detectChange({ prior, current, now = new Date(), refreshAfterMinutes = 30 }) {
  const signal_hash = computeSignalHash(current);
  if (!prior) {
    return { materially_changed: true, signal_hash, reason: 'no_prior' };
  }
  const priorHash = prior?.meta?.signal_hash ?? '';
  if (priorHash && priorHash !== signal_hash) {
    return { materially_changed: true, signal_hash, reason: 'hash_differs' };
  }
  const priorActive = prior?.meta?.last_active_at;
  if (priorActive) {
    const t = priorActive instanceof Date ? priorActive : new Date(priorActive);
    if (Number.isFinite(t.getTime())) {
      const ageMs = now.getTime() - t.getTime();
      if (ageMs > refreshAfterMinutes * 60_000) {
        return { materially_changed: true, signal_hash, reason: 'refresh_window' };
      }
    }
  }
  return { materially_changed: false, signal_hash, reason: 'unchanged' };
}
```

- [ ] **Step 4: Run the tests — expect pass.**

```bash
npm run test:unit -- --test-name-pattern='computeSignalHash|detectChange'
```

Expected: all five tests pass.

- [ ] **Step 5: Lint + commit.**

```bash
npm run lint
git add system/cognition/jobs/internal/state-inference.js system/tests/unit/state-inference-change-detect.test.js
git commit -m "feat(state-inference): computeSignalHash + detectChange helpers"
```

---

## Phase 4 — LLM-call composer (per-source pipeline)

### Task 4.1: Write the prompt/output validation helpers

**Files:** `system/cognition/jobs/internal/state-inference.js` (extend)

- [ ] **Step 1: Add tests for prompt assembly and output validation.**

Append to `system/tests/unit/state-inference-change-detect.test.js`:

```js
import {
  buildPrompt,
  clampConfidence,
  validateLLMOutput,
} from '../../cognition/jobs/internal/state-inference.js';

test('buildPrompt includes arc summary, entities, events, prior content', () => {
  const out = buildPrompt({
    arc: { summary: 'Refactor cognition layer' },
    entities: [{ name: 'state_inference', type: 'topic' }],
    events: [{ ts: '2026-05-11T18:00:00Z', content: 'wrote design spec' }],
    prior: { content: 'iterating on cognition refactor' },
  });
  assert.match(out, /Refactor cognition layer/);
  assert.match(out, /state_inference/);
  assert.match(out, /wrote design spec/);
  assert.match(out, /iterating on cognition refactor/);
  assert.match(out, /Respond JSON only:/);
});

test('buildPrompt handles null arc + empty prior gracefully', () => {
  const out = buildPrompt({
    arc: null,
    entities: [],
    events: [{ ts: '2026-05-11T18:00:00Z', content: 'noop' }],
    prior: null,
  });
  assert.match(out, /Active arc: none/);
  assert.match(out, /Prior inference \(for context, may be stale\): none/);
});

test('clampConfidence respects [0.05, 0.95] bounds and ambiguous shrink', () => {
  assert.equal(clampConfidence(1.5, false), 0.95);
  assert.equal(clampConfidence(-0.3, false), 0.05);
  assert.equal(clampConfidence(0.8, true), 0.4);
  assert.equal(clampConfidence(0.5, false), 0.5);
});

test('validateLLMOutput rejects non-JSON or missing fields', () => {
  assert.equal(validateLLMOutput(null).ok, false);
  assert.equal(validateLLMOutput({ focus_statement: 'x' }).ok, false); // missing confidence
  const v = validateLLMOutput({
    focus_statement: 'x',
    confidence: 0.7,
    evidence_snippet: 's',
    ambiguous: false,
    drop: false,
  });
  assert.equal(v.ok, true);
});
```

- [ ] **Step 2: Run — expect failure.**

```bash
npm run test:unit -- --test-name-pattern='buildPrompt|clampConfidence|validateLLMOutput'
```

Expected: missing-export errors.

- [ ] **Step 3: Extend `state-inference.js` with the helpers and the system prompt constant.**

Append to `system/cognition/jobs/internal/state-inference.js`:

```js
export const STATE_INFERENCE_SYSTEM = `You produce a one-sentence statement of what the user is currently working on, based on recent activity. Stay grounded in the evidence; do not speculate beyond what the inputs support. Output strict JSON.`;

export function buildPrompt({ arc, entities, events, prior }) {
  const entityLines = (entities ?? [])
    .slice(0, 10)
    .map((e) => `${e.type ?? 'unknown'}/${e.name ?? '?'}`)
    .join(', ');
  const eventLines = (events ?? [])
    .slice(0, 5)
    .map((e) => `- [${e.ts}] ${String(e.content ?? '').slice(0, 120)}`)
    .join('\n');
  return [
    `Active arc: ${arc?.summary ?? 'none'}`,
    `Recent entities: ${entityLines || 'none'}`,
    `Recent events (latest first):`,
    eventLines || '- (none)',
    `Prior inference (for context, may be stale): ${prior?.content ?? 'none'}`,
    ``,
    `Respond JSON only:`,
    `{ "focus_statement": string,`,
    `  "confidence": number,`,
    `  "evidence_snippet": string,`,
    `  "ambiguous": boolean,`,
    `  "drop": boolean }`,
  ].join('\n');
}

export function clampConfidence(c, ambiguous) {
  let v = typeof c === 'number' && Number.isFinite(c) ? c : 0.5;
  if (ambiguous) v = v * 0.5;
  if (v < 0.05) v = 0.05;
  if (v > 0.95) v = 0.95;
  return v;
}

export function validateLLMOutput(o) {
  if (!o || typeof o !== 'object') return { ok: false, error: 'not_object' };
  if (typeof o.focus_statement !== 'string') return { ok: false, error: 'missing_focus_statement' };
  if (typeof o.confidence !== 'number') return { ok: false, error: 'missing_confidence' };
  if (typeof o.ambiguous !== 'boolean') return { ok: false, error: 'missing_ambiguous' };
  if (typeof o.drop !== 'boolean') return { ok: false, error: 'missing_drop' };
  return { ok: true };
}
```

- [ ] **Step 4: Run the new tests — expect pass.**

```bash
npm run test:unit -- --test-name-pattern='buildPrompt|clampConfidence|validateLLMOutput'
```

Expected: all four pass.

- [ ] **Step 5: Lint + commit.**

```bash
npm run lint
git add system/cognition/jobs/internal/state-inference.js system/tests/unit/state-inference-change-detect.test.js
git commit -m "feat(state-inference): prompt builder + output validation + confidence clamp"
```

### Task 4.2: Read inputs (`readInputsForSource`) + privacy scope inheritance

**Files:** `system/cognition/jobs/internal/state-inference.js` (extend)

- [ ] **Step 1: Write a test for `readInputsForSource` (attention lens + top arc + recent biographed events).**

Create `system/tests/unit/state-inference-read-inputs.test.js`:

```js
import assert from 'node:assert/strict';
import { mkdirSync as __mk } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { readInputsForSource } from '../../cognition/jobs/internal/state-inference.js';
import { writeConfig } from '../../config/paths.js';
import { close, connect } from '../../data/db/client.js';
import { runMigrations } from '../../data/db/migrate.js';
import { createStubEmbedder } from '../../data/embed/embedder.js';

const HOME = join(tmpdir(), `robin-ri-${process.pid}-${Math.random().toString(36).slice(2)}`);
__mk(HOME, { recursive: true });
process.env.ROBIN_HOME = HOME;
await writeConfig({ embedder_profile: 'mxbai-1024' });

async function fresh() {
  const db = await connect({ engine: 'mem://' });
  await runMigrations(db, resolve(import.meta.dirname, '../../data/db/migrations'));
  return db;
}

test('readInputsForSource returns empty shape when no episodes exist', async () => {
  const db = await fresh();
  const e = createStubEmbedder({ dimension: 1024 });
  const r = await readInputsForSource(db, e, { source: 'conversation', windowMinutes: 90 });
  assert.deepEqual(r.attention.episodes, []);
  assert.equal(r.arc, null);
  assert.deepEqual(r.events, []);
  assert.equal(r.privateScopeDetected, false);
  await close(db);
});
```

- [ ] **Step 2: Run — expect failure (missing export).**

```bash
npm run test:unit -- --test-name-pattern='readInputsForSource'
```

- [ ] **Step 3: Add `readInputsForSource` to `state-inference.js`.**

Append:

```js
import { BoundQuery, surql } from 'surrealdb';
import { getAttention } from '../../memory/attention.js';
import { isOutboundBlocked } from '../../memory/scope-registry.js';

/**
 * Read all inputs needed for one source's inference: attention lens + top
 * active arc that overlaps the attention entity set + up to 5 most-recent
 * biographed events whose mentions intersect that entity set.
 *
 * Spec §1.3 steps 2–4.
 *
 * Also computes a `privateScopeDetected` flag (§6.1): true if any candidate
 * entity, arc, or event has `scope` in the outbound-blocked set.
 */
export async function readInputsForSource(db, embedder, { source, windowMinutes }) {
  const attention = await getAttention(db, { source, windowMinutes });
  const entityIds = (attention.entities ?? []).map((e) => e.id);
  const entityIdStrs = entityIds.map((id) => String(id));

  let arc = null;
  if (entityIds.length > 0) {
    const [arcRows] = await db
      .query(
        new BoundQuery(
          `SELECT id, name, summary, entity_ids, scope, last_activity_at FROM arcs
           WHERE status = 'active'
             AND last_activity_at >= time::now() - 24h
             AND entity_ids ANYINSIDE $eids
           ORDER BY last_activity_at DESC
           LIMIT 10`,
          { eids: entityIds },
        ),
      )
      .collect();
    let best = null;
    let bestOverlap = -1;
    for (const a of arcRows ?? []) {
      const arcEntities = new Set((a.entity_ids ?? []).map((x) => String(x)));
      let overlap = 0;
      for (const s of entityIdStrs) if (arcEntities.has(s)) overlap++;
      if (overlap > bestOverlap) {
        bestOverlap = overlap;
        best = a;
      }
    }
    arc = best;
  }

  const recentEventIds = (attention.recent_events ?? []).map((e) => e.id);
  let events = [];
  if (recentEventIds.length > 0 && entityIds.length > 0) {
    const [rows] = await db
      .query(
        new BoundQuery(
          `SELECT id, content, ts, scope FROM events
           WHERE id IN $eids
             AND biographed_at IS NOT NONE
             AND count(->mentions WHERE out IN $entIds) > 0
           ORDER BY ts DESC
           LIMIT 5`,
          { eids: recentEventIds, entIds: entityIds },
        ),
      )
      .collect();
    events = rows ?? [];
  }

  // Scope inheritance check (spec §6.1). Hydrate scope for candidate
  // entities + chosen events + arc. We do not (v1) walk transitive
  // derived_from chains — see spec §6.3.
  let privateScopeDetected = false;
  try {
    if (entityIds.length > 0) {
      const [entRows] = await db
        .query(
          new BoundQuery('SELECT id, scope FROM entities WHERE id IN $ids', { ids: entityIds }),
        )
        .collect();
      for (const r of entRows ?? []) {
        if (r?.scope && isOutboundBlocked(r.scope)) {
          privateScopeDetected = true;
          break;
        }
      }
    }
    if (!privateScopeDetected) {
      for (const ev of events) {
        if (ev?.scope && isOutboundBlocked(ev.scope)) {
          privateScopeDetected = true;
          break;
        }
      }
    }
    if (!privateScopeDetected && arc?.scope && isOutboundBlocked(arc.scope)) {
      privateScopeDetected = true;
    }
  } catch {
    // Scope lookup failures fail-open to private to avoid leaking; tests
    // assert against the "no rows" path, so this branch only fires on
    // engine error which is rare and conservative.
    privateScopeDetected = true;
  }

  return { attention, arc, events, privateScopeDetected };
}
```

- [ ] **Step 4: Run the test — expect pass.**

```bash
npm run test:unit -- --test-name-pattern='readInputsForSource'
```

- [ ] **Step 5: Lint + commit.**

```bash
npm run lint
git add system/cognition/jobs/internal/state-inference.js system/tests/unit/state-inference-read-inputs.test.js
git commit -m "feat(state-inference): readInputsForSource (attention + arc + events + scope check)"
```

### Task 4.3: `composeForSource` — full per-source pipeline (LLM call + write + supersede + telemetry)

**Files:** `system/cognition/jobs/internal/state-inference.js` (extend)

- [ ] **Step 1: Write the unit tests U1–U6 (spec §8.1).**

Create `system/tests/unit/state-inference-compose.test.js`:

```js
import assert from 'node:assert/strict';
import { mkdirSync as __mk } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { surql } from 'surrealdb';
import { composeForSource } from '../../cognition/jobs/internal/state-inference.js';
import { noteStateInference } from '../../cognition/memory/state_inference.js';
import * as store from '../../cognition/memory/store.js';
import { writeConfig } from '../../config/paths.js';
import { close, connect } from '../../data/db/client.js';
import { runMigrations } from '../../data/db/migrate.js';
import { createStubEmbedder } from '../../data/embed/embedder.js';

const HOME = join(tmpdir(), `robin-cmp-${process.pid}-${Math.random().toString(36).slice(2)}`);
__mk(HOME, { recursive: true });
process.env.ROBIN_HOME = HOME;
await writeConfig({ embedder_profile: 'mxbai-1024' });

async function fresh() {
  const db = await connect({ engine: 'mem://' });
  await runMigrations(db, resolve(import.meta.dirname, '../../data/db/migrations'));
  return db;
}

/**
 * Shared fixture helper — seeds a biographed event with mentions edges and an
 * optional episode link. `record-event.js`'s VALID_SOURCES set only accepts
 * a small enum (`'conversation'` is the closest match for an agent-transcript
 * event); it also drops `episode_id`, `entity_refs`, and `biographed_at` from
 * the input, so this helper bypasses it with raw SurrealQL.
 *
 * Reuse this helper across U2/U3/U4/U6, I7, A2, E2 — every test that needs
 * the production code path (attention lens → mentions edges → biographed_at)
 * to exercise the change-detect gate end-to-end.
 *
 * @param {object} args
 * @param {string} args.source          — episode + event source (use 'conversation' in tests)
 * @param {string} args.content
 * @param {RecordId[]} [args.entities]  — entity refs to wire via RELATE mentions
 * @param {RecordId|null} [args.episodeId]  — link the event to an episode
 * @returns {Promise<{ id: RecordId }>}
 */
async function seedBiographedEvent(db, embedder, {
  source = 'conversation',
  content,
  entities = [],
  episodeId = null,
}) {
  const [created] = await db
    .query(
      surql`CREATE events CONTENT ${{
        source,
        content,
        biographed_at: new Date(),
      }}`,
    )
    .collect();
  const row = Array.isArray(created) ? created[0] : created;
  const eventId = row.id;
  if (episodeId) {
    await db
      .query(surql`UPDATE ${eventId} SET episode_id = ${episodeId}`)
      .collect();
  }
  for (const entId of entities) {
    await db
      .query(surql`RELATE ${eventId}->mentions->${entId} CONTENT { kind: 'mentions' }`)
      .collect();
  }
  return { id: eventId };
}

async function seedEpisode(db, source = 'conversation') {
  await db
    .query(
      surql`CREATE episodes CONTENT ${{
        source,
        started_at: new Date(Date.now() - 5 * 60_000),
        last_event_at: new Date(),
      }}`,
    )
    .collect();
  const [epRows] = await db
    .query(surql`SELECT id FROM episodes WHERE source = ${source} LIMIT 1`)
    .collect();
  return epRows[0].id;
}

function makeLLMMock(response) {
  let calls = 0;
  return {
    invokeLLM: async () => {
      calls++;
      return {
        content: JSON.stringify(response),
        usage: { input_tokens: 200, output_tokens: 60 },
      };
    },
    get calls() {
      return calls;
    },
  };
}

const TEST_SOURCE = 'conversation';

const CFG = {
  enabled: 'shadow', // 'shadow' runs the pipeline but suppresses the memo write
  tick_ms: 300000,
  attention_window_min: 90,
  refresh_after_minutes: 30,
  min_events_for_inference: 2,
  max_sources_per_tick: 4,
  min_confidence_to_surface: 0.5,
  stale_after_minutes: 120,
  pivot_weight: 1.0,
  corroborate_weight: 1.0,
};

test('U1 — empty attention → no write', async () => {
  const db = await fresh();
  const e = createStubEmbedder({ dimension: 1024 });
  const llm = makeLLMMock({ focus_statement: 'x', confidence: 0.7, evidence_snippet: '', ambiguous: false, drop: false });
  const r = await composeForSource({
    db,
    embedder: e,
    host: llm,
    source: TEST_SOURCE,
    cfg: { ...CFG, enabled: true },
    now: new Date(),
  });
  assert.equal(r.outcome, 'dropped_thin');
  assert.equal(llm.calls, 0);
  await close(db);
});

test('U2 — no change → no LLM call, no write', async () => {
  const db = await fresh();
  const e = createStubEmbedder({ dimension: 1024 });
  // Seed: one episode, one entity, one biographed event linking the two via
  // the production mentions edge, then a prior inference whose signal_hash
  // matches the upcoming computation (entities=[ent.id], arc_id=null,
  // last_event_id=<the event we just created>).
  const epId = await seedEpisode(db);
  const ent = await store.upsertEntity(db, e, { type: 'topic', name: 'cognition' });
  const { id: evId } = await seedBiographedEvent(db, e, {
    source: TEST_SOURCE,
    content: 'iterating',
    entities: [ent.id],
    episodeId: epId,
  });
  const { computeSignalHash } = await import('../../cognition/jobs/internal/state-inference.js');
  const priorSig = computeSignalHash({
    entities: [ent.id],
    arc_id: null,
    last_event_id: evId,
  });
  await noteStateInference(db, e, {
    source: TEST_SOURCE,
    content: 'prior',
    confidence: 0.7,
    entities: [ent.id],
    last_event_id: evId,
    last_active_at: new Date(),
    signal_hash: priorSig,
  });
  const llm = makeLLMMock({ focus_statement: 'x', confidence: 0.7, evidence_snippet: '', ambiguous: false, drop: false });
  const r = await composeForSource({
    db,
    embedder: e,
    host: llm,
    source: TEST_SOURCE,
    cfg: { ...CFG, enabled: true },
    now: new Date(),
  });
  assert.equal(r.outcome, 'skipped_unchanged');
  assert.equal(llm.calls, 0, 'steady state: zero LLM invocations');
  await close(db);
});

test('U3 — entity-set change → LLM call, new memo, supersedes edge', async () => {
  const db = await fresh();
  const e = createStubEmbedder({ dimension: 1024 });
  const epId = await seedEpisode(db);
  const entA = await store.upsertEntity(db, e, { type: 'topic', name: 'A' });
  const entB = await store.upsertEntity(db, e, { type: 'topic', name: 'B' });
  // Prior inference with entities=[A], stale signal_hash.
  await noteStateInference(db, e, {
    source: TEST_SOURCE,
    content: 'about A',
    confidence: 0.7,
    entities: [entA.id],
    last_active_at: new Date(),
    signal_hash: 'stale-hash',
  });
  // Current event tied to entB → entity set changes.
  await seedBiographedEvent(db, e, {
    source: TEST_SOURCE,
    content: 'now B',
    entities: [entB.id],
    episodeId: epId,
  });
  const llm = makeLLMMock({
    focus_statement: 'Working on B',
    confidence: 0.8,
    evidence_snippet: 'now B',
    ambiguous: false,
    drop: false,
  });
  const r = await composeForSource({
    db,
    embedder: e,
    host: llm,
    source: TEST_SOURCE,
    cfg: { ...CFG, enabled: true },
    now: new Date(),
  });
  assert.equal(r.outcome, 'wrote');
  assert.equal(llm.calls, 1);
  // supersedes edge from new → prior.
  const [edges] = await db
    .query(`SELECT count() AS n FROM supersedes GROUP ALL`)
    .collect();
  assert.equal(edges?.[0]?.n ?? 0, 1);
  await close(db);
});

test('U4 — LLM drop=true → no write, telemetry dropped_thin', async () => {
  const db = await fresh();
  const e = createStubEmbedder({ dimension: 1024 });
  const epId = await seedEpisode(db);
  const ent = await store.upsertEntity(db, e, { type: 'topic', name: 'x' });
  await seedBiographedEvent(db, e, {
    source: TEST_SOURCE,
    content: 'something',
    entities: [ent.id],
    episodeId: epId,
  });
  const llm = makeLLMMock({
    focus_statement: '',
    confidence: 0.1,
    evidence_snippet: '',
    ambiguous: true,
    drop: true,
  });
  const r = await composeForSource({
    db,
    embedder: e,
    host: llm,
    source: TEST_SOURCE,
    cfg: { ...CFG, enabled: true },
    now: new Date(),
  });
  assert.equal(r.outcome, 'dropped_thin');
  const [memos] = await db
    .query(`SELECT count() AS n FROM memos WHERE kind = 'state_inference' GROUP ALL`)
    .collect();
  assert.equal(memos?.[0]?.n ?? 0, 0);
  await close(db);
});

test('U5 — confidence clamping (1.5 → 0.95; -0.3 → 0.05; ambiguous 0.8 → 0.4)', async () => {
  const { clampConfidence } = await import('../../cognition/jobs/internal/state-inference.js');
  assert.equal(clampConfidence(1.5, false), 0.95);
  assert.equal(clampConfidence(-0.3, false), 0.05);
  assert.equal(clampConfidence(0.8, true), 0.4);
});

test('U6 — entity scope=private → new memo inherits scope=private', async () => {
  const db = await fresh();
  const e = createStubEmbedder({ dimension: 1024 });
  const epId = await seedEpisode(db);
  const ent = await store.upsertEntity(db, e, { type: 'topic', name: 'secret', scope: 'private' });
  await seedBiographedEvent(db, e, {
    source: TEST_SOURCE,
    content: 'hush',
    entities: [ent.id],
    episodeId: epId,
  });
  const llm = makeLLMMock({
    focus_statement: 'Working on secret',
    confidence: 0.8,
    evidence_snippet: 'hush',
    ambiguous: false,
    drop: false,
  });
  await composeForSource({
    db,
    embedder: e,
    host: llm,
    source: TEST_SOURCE,
    cfg: { ...CFG, enabled: true },
    now: new Date(),
  });
  const [memos] = await db
    .query(`SELECT scope FROM memos WHERE kind = 'state_inference' LIMIT 1`)
    .collect();
  assert.equal(memos?.[0]?.scope, 'private');
  await close(db);
});
```

- [ ] **Step 2: Run — expect failure (`composeForSource` missing).**

```bash
npm run test:unit -- --test-name-pattern='U1 —|U2 —|U3 —|U4 —|U5 —|U6 —'
```

- [ ] **Step 3: Implement `composeForSource` in `state-inference.js`.**

Append to `system/cognition/jobs/internal/state-inference.js`:

```js
import { addEvidence } from '../../memory/evidence.js';
import { latestForSource, noteStateInference } from '../../memory/state_inference.js';
import * as store from '../../memory/store.js';

const MIN_EVENTS = 2;
const CONTENT_MAX = 240;
const EVIDENCE_SNIPPET_MAX = 120;

async function recordTelemetry(db, row) {
  try {
    await db.query(surql`CREATE state_inference_telemetry CONTENT ${row}`).collect();
  } catch {
    /* telemetry is advisory */
  }
}

async function priorHasCalibrationRow(db, prior) {
  // Per spec §5.1 — skip calibration emission only when an evidence_ledger
  // row exists for this prior with `ts > prior.derived_at` (i.e., a
  // post-derived calibration). Rows older than the prior would belong to a
  // prior generation and must not block the new emission.
  try {
    const [rows] = await db
      .query(
        new BoundQuery(
          `SELECT count() AS n FROM evidence_ledger
           WHERE memo_id = $id
             AND reason IN ['state_inference_held','state_inference_pivoted']
             AND ts > $prior_derived_at
           GROUP ALL`,
          { id: prior?.id, prior_derived_at: prior?.derived_at },
        ),
      )
      .collect();
    return (rows?.[0]?.n ?? 0) > 0;
  } catch {
    return false;
  }
}

function classifyPriorVsCurrent(prior, current) {
  const priorEnts = new Set((prior?.meta?.entities ?? []).map((s) => String(s)));
  const curEnts = new Set((current.entities ?? []).map((s) => String(s)));
  let inter = 0;
  for (const s of priorEnts) if (curEnts.has(s)) inter++;
  const denom = Math.max(priorEnts.size, curEnts.size) || 1;
  const overlap = inter / denom;
  const priorArc = prior?.meta?.arc_id ?? null;
  const curArc = current.arc_id ?? null;
  const arcMatches = String(priorArc ?? '') === String(curArc ?? '');
  if (overlap >= 0.5 && arcMatches) return 'corroborated';
  if (!arcMatches && overlap < 0.25) return 'refuted';
  return 'ambiguous';
}

/**
 * Run the per-source pipeline (spec §1.3 steps 1–10).
 *
 * Returns one of:
 *   { outcome: 'wrote', id, signal_hash, latency_ms, tokens_in, tokens_out }
 *   { outcome: 'skipped_unchanged', signal_hash }
 *   { outcome: 'skipped_disabled' }
 *   { outcome: 'dropped_thin', reason }
 *   { outcome: 'error', reason }
 */
export async function composeForSource({ db, embedder, host, source, cfg, now = new Date() }) {
  if (cfg.enabled === false) {
    await recordTelemetry(db, { source, outcome: 'skipped_disabled' });
    return { outcome: 'skipped_disabled' };
  }

  const shadow = cfg.enabled === 'shadow';

  let prior;
  try {
    prior = await latestForSource(db, source);
  } catch (e) {
    await recordTelemetry(db, { source, outcome: 'error', reason: `latestForSource: ${e.message}` });
    return { outcome: 'error', reason: e.message };
  }

  let inputs;
  try {
    inputs = await readInputsForSource(db, embedder, {
      source,
      windowMinutes: cfg.attention_window_min,
    });
  } catch (e) {
    await recordTelemetry(db, { source, outcome: 'error', reason: `readInputs: ${e.message}` });
    return { outcome: 'error', reason: e.message };
  }

  const { attention, arc, events, privateScopeDetected } = inputs;
  const entityIds = (attention.entities ?? []).map((e) => e.id);

  // Thin-evidence guard. Empty attention OR too few events → dropped_thin.
  const minEv = Number.isInteger(cfg.min_events_for_inference)
    ? cfg.min_events_for_inference
    : MIN_EVENTS;
  if (entityIds.length === 0 || events.length < Math.max(1, minEv - 1)) {
    await recordTelemetry(db, { source, outcome: 'dropped_thin', reason: 'empty_attention' });
    return { outcome: 'dropped_thin', reason: 'empty_attention' };
  }

  const current = {
    entities: entityIds.map((id) => String(id)),
    arc_id: arc?.id != null ? String(arc.id) : null,
    last_event_id: events[0]?.id != null ? String(events[0].id) : null,
  };

  const change = detectChange({
    prior,
    current,
    now,
    refreshAfterMinutes: cfg.refresh_after_minutes ?? 30,
  });
  if (!change.materially_changed) {
    await recordTelemetry(db, {
      source,
      outcome: 'skipped_unchanged',
      signal_hash: change.signal_hash,
    });
    return { outcome: 'skipped_unchanged', signal_hash: change.signal_hash };
  }

  // Calibration sub-step (spec §5.1) — runs before the LLM call; classified
  // against the current snapshot regardless of whether the LLM later drops.
  if (prior && !shadow) {
    const cls = classifyPriorVsCurrent(prior, current);
    if (cls !== 'ambiguous') {
      const dedup = await priorHasCalibrationRow(db, prior);
      if (!dedup) {
        try {
          await addEvidence(db, {
            memo_id: prior.id,
            polarity: cls === 'corroborated' ? 'corroborates' : 'refutes',
            reason: cls === 'corroborated' ? 'state_inference_held' : 'state_inference_pivoted',
            weight:
              cls === 'corroborated'
                ? (cfg.corroborate_weight ?? 1.0)
                : (cfg.pivot_weight ?? 1.0),
          });
        } catch {
          /* fail-soft */
        }
      }
    }
  }

  // LLM call (spec §1.3 step 7).
  const userPrompt = buildPrompt({
    arc,
    entities: attention.entities ?? [],
    events,
    prior,
  });
  const startedAt = Date.now();
  let llmResult;
  try {
    const r = await host.invokeLLM([{ role: 'user', content: userPrompt }], {
      tier: 'fast',
      json: true,
      system: [
        {
          role: 'system',
          content: STATE_INFERENCE_SYSTEM,
          cache_control: { type: 'ephemeral' },
        },
      ],
    });
    llmResult = JSON.parse(r.content);
    // `host.invokeLLM` returns `{ content, usage: { input_tokens,
    // output_tokens, cache_read_tokens } }` per
    // `system/runtime/hosts/claude-code.js:77-94`. There is no top-level
    // `r.tokens_in` / `r.tokens_out` — those keys are always undefined.
    llmResult._tokens_in = r.usage?.input_tokens ?? null;
    llmResult._tokens_out = r.usage?.output_tokens ?? null;
  } catch (e) {
    await recordTelemetry(db, {
      source,
      outcome: 'error',
      reason: `llm: ${e.message}`,
      signal_hash: change.signal_hash,
      latency_ms: Date.now() - startedAt,
    });
    return { outcome: 'error', reason: e.message };
  }

  const validation = validateLLMOutput(llmResult);
  if (!validation.ok) {
    await recordTelemetry(db, {
      source,
      outcome: 'error',
      reason: `validate: ${validation.error}`,
      signal_hash: change.signal_hash,
      latency_ms: Date.now() - startedAt,
    });
    return { outcome: 'error', reason: validation.error };
  }

  if (llmResult.drop === true) {
    await recordTelemetry(db, {
      source,
      outcome: 'dropped_thin',
      signal_hash: change.signal_hash,
      tokens_in: llmResult._tokens_in,
      tokens_out: llmResult._tokens_out,
      latency_ms: Date.now() - startedAt,
      reason: 'llm_drop',
    });
    return { outcome: 'dropped_thin', reason: 'llm_drop' };
  }

  if (shadow) {
    await recordTelemetry(db, {
      source,
      outcome: 'wrote',
      signal_hash: change.signal_hash,
      tokens_in: llmResult._tokens_in,
      tokens_out: llmResult._tokens_out,
      latency_ms: Date.now() - startedAt,
      reason: 'shadow',
    });
    return {
      outcome: 'wrote',
      shadow: true,
      signal_hash: change.signal_hash,
    };
  }

  // Write the memo (spec §1.3 step 8).
  const content = String(llmResult.focus_statement ?? '').slice(0, CONTENT_MAX);
  const confidence = clampConfidence(llmResult.confidence, llmResult.ambiguous === true);
  const evidenceSnippet = String(llmResult.evidence_snippet ?? '').slice(0, EVIDENCE_SNIPPET_MAX);

  const fromSignal = [];
  if (attention.entities?.length) fromSignal.push('attention');
  if (arc) fromSignal.push('arcs');
  if (events.length > 0) fromSignal.push('biographer');

  const scope = privateScopeDetected ? 'private' : 'global';

  let created;
  try {
    created = await noteStateInference(db, embedder, {
      source,
      content,
      confidence,
      entities: entityIds,
      arc_id: arc?.id ?? null,
      last_event_id: events[0]?.id ?? null,
      lineage: events.slice(0, 5).map((e) => e.id),
      evidence_snippet: evidenceSnippet,
      last_active_at: new Date(),
      from_signal: fromSignal,
      signal_hash: change.signal_hash,
      scope,
    });
  } catch (e) {
    await recordTelemetry(db, {
      source,
      outcome: 'error',
      reason: `write: ${e.message}`,
      signal_hash: change.signal_hash,
      latency_ms: Date.now() - startedAt,
    });
    return { outcome: 'error', reason: e.message };
  }

  // Supersede the prior (spec §1.3 step 9).
  if (prior) {
    try {
      await store.supersede(db, prior.id, created.id);
    } catch (e) {
      // Memo was written; supersede failure is non-fatal for this tick. Log.
      console.warn(`[state-inference] supersede failed: ${e.message}`);
    }
  }

  await recordTelemetry(db, {
    source,
    outcome: 'wrote',
    signal_hash: change.signal_hash,
    tokens_in: llmResult._tokens_in,
    tokens_out: llmResult._tokens_out,
    latency_ms: Date.now() - startedAt,
  });

  return {
    outcome: 'wrote',
    id: created.id,
    signal_hash: change.signal_hash,
    tokens_in: llmResult._tokens_in,
    tokens_out: llmResult._tokens_out,
    latency_ms: Date.now() - startedAt,
  };
}
```

- [ ] **Step 4: Run the U1–U6 tests — expect pass.**

```bash
npm run test:unit -- --test-name-pattern='U1 —|U2 —|U3 —|U4 —|U5 —|U6 —'
```

Expected: all six pass.

- [ ] **Step 5: Lint + commit.**

```bash
npm run lint
git add system/cognition/jobs/internal/state-inference.js system/tests/unit/state-inference-compose.test.js
git commit -m "feat(state-inference): composeForSource pipeline (change-detect, calibration, LLM, write, supersede)"
```

---

## Phase 5 — Internal-job wiring + manifest

### Task 5.1: `evaluateStateInference` entry point + active-source loop + config read

**Files:** `system/cognition/jobs/internal/state-inference.js` (extend)

- [ ] **Step 1: Write a test for the loop boundary (fan-out cap + cfg gate).**

Create `system/tests/unit/state-inference-evaluate.test.js`:

```js
import assert from 'node:assert/strict';
import { mkdirSync as __mk } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { evaluateStateInference } from '../../cognition/jobs/internal/state-inference.js';
import { writeConfig } from '../../config/paths.js';
import { close, connect } from '../../data/db/client.js';
import { runMigrations } from '../../data/db/migrate.js';
import { createStubEmbedder } from '../../data/embed/embedder.js';

const HOME = join(tmpdir(), `robin-ev-${process.pid}-${Math.random().toString(36).slice(2)}`);
__mk(HOME, { recursive: true });
process.env.ROBIN_HOME = HOME;
await writeConfig({ embedder_profile: 'mxbai-1024' });

async function fresh() {
  const db = await connect({ engine: 'mem://' });
  await runMigrations(db, resolve(import.meta.dirname, '../../data/db/migrations'));
  return db;
}

test('evaluateStateInference returns skipped_disabled when cfg.enabled=false (default seed)', async () => {
  const db = await fresh();
  const e = createStubEmbedder({ dimension: 1024 });
  const host = { invokeLLM: async () => ({ content: '{}', tokens_in: 0, tokens_out: 0 }) };
  const r = await evaluateStateInference({ db, host, embedder: e });
  assert.equal(r.outcome, 'skipped_disabled');
  await close(db);
});

test('evaluateStateInference no active sources → outcome=no_active_sources', async () => {
  const db = await fresh();
  await db
    .query(
      `UPDATE runtime:\`state_inference.config\` SET value.enabled = 'shadow'`,
    )
    .collect();
  const e = createStubEmbedder({ dimension: 1024 });
  const host = { invokeLLM: async () => ({ content: '{}' }) };
  const r = await evaluateStateInference({ db, host, embedder: e });
  assert.equal(r.outcome, 'no_active_sources');
  await close(db);
});

test('evaluateStateInference caps fan-out to cfg.max_sources_per_tick', async () => {
  const db = await fresh();
  await db
    .query(
      `UPDATE runtime:\`state_inference.config\` SET value.enabled = 'shadow', value.max_sources_per_tick = 2`,
    )
    .collect();
  for (const s of ['a', 'b', 'c', 'd', 'e']) {
    await db
      .query(
        `CREATE episodes CONTENT { source: $s, started_at: time::now() - 1m, last_event_at: time::now() }`,
        { s },
      )
      .collect();
  }
  const emb = createStubEmbedder({ dimension: 1024 });
  const host = { invokeLLM: async () => ({ content: '{}' }) };
  const r = await evaluateStateInference({ db, host, embedder: emb });
  assert.equal(r.sources_evaluated, 2);
  await close(db);
});
```

- [ ] **Step 2: Run — expect failure.**

```bash
npm run test:unit -- --test-name-pattern='evaluateStateInference'
```

- [ ] **Step 3: Append `evaluateStateInference` + config reader.**

Append to `system/cognition/jobs/internal/state-inference.js`:

```js
const DEFAULTS = {
  enabled: false,
  tick_ms: 300000,
  attention_window_min: 90,
  refresh_after_minutes: 30,
  min_events_for_inference: 2,
  max_sources_per_tick: 4,
  min_confidence_to_surface: 0.5,
  stale_after_minutes: 120,
  pivot_weight: 1.0,
  corroborate_weight: 1.0,
};

let _cfgCache = { value: null, expiresAt: 0 };
const CFG_TTL_MS = 5_000;

export async function readStateInferenceConfig(db, { now = Date.now() } = {}) {
  if (_cfgCache.value && _cfgCache.expiresAt > now) return _cfgCache.value;
  let cfg = DEFAULTS;
  try {
    const [rows] = await db
      .query('SELECT VALUE value FROM runtime:`state_inference.config`')
      .collect();
    if (rows?.[0]) cfg = { ...DEFAULTS, ...rows[0] };
  } catch {
    /* defaults */
  }
  _cfgCache = { value: cfg, expiresAt: now + CFG_TTL_MS };
  return cfg;
}

// Exposed for tests.
export function _clearStateInferenceConfigCache() {
  _cfgCache = { value: null, expiresAt: 0 };
}

async function listActiveSources(db) {
  // Active source = any episode with ended_at IS NONE AND started_at >= now-24h.
  const [rows] = await db
    .query(
      surql`SELECT VALUE source FROM episodes
            WHERE ended_at IS NONE
              AND started_at >= time::now() - 24h
            GROUP BY source`,
    )
    .collect();
  const seen = new Set();
  const out = [];
  for (const s of rows ?? []) {
    if (s && !seen.has(s)) {
      seen.add(s);
      out.push(s);
    }
  }
  return out;
}

/**
 * Heartbeat-paced entry point (spec §1.1). Reads config, lists active
 * sources, runs composeForSource for up to cfg.max_sources_per_tick.
 *
 * @returns {Promise<{
 *   outcome: 'skipped_disabled' | 'no_active_sources' | 'ran',
 *   sources_evaluated?: number,
 *   per_source?: Array<{ source: string, outcome: string }>
 * }>}
 */
export async function evaluateStateInference({ db, host, embedder, now = new Date() } = {}) {
  // Cache invalidation is per-tick to pick up flag flips without restart.
  _clearStateInferenceConfigCache();
  const cfg = await readStateInferenceConfig(db);
  if (cfg.enabled === false) {
    return { outcome: 'skipped_disabled' };
  }
  const sources = await listActiveSources(db);
  if (sources.length === 0) {
    return { outcome: 'no_active_sources' };
  }
  const cap = Math.max(1, cfg.max_sources_per_tick ?? DEFAULTS.max_sources_per_tick);
  const selected = sources.slice(0, cap);
  const per_source = [];
  for (const source of selected) {
    try {
      const r = await composeForSource({ db, embedder, host, source, cfg, now });
      per_source.push({ source, outcome: r.outcome });
    } catch (e) {
      per_source.push({ source, outcome: 'error' });
      console.warn(`[state-inference ${source}] ${e.message}`);
    }
  }
  return { outcome: 'ran', sources_evaluated: per_source.length, per_source };
}
```

- [ ] **Step 4: Run tests — expect pass.**

```bash
npm run test:unit -- --test-name-pattern='evaluateStateInference'
```

- [ ] **Step 5: Lint + commit.**

```bash
npm run lint
git add system/cognition/jobs/internal/state-inference.js system/tests/unit/state-inference-evaluate.test.js
git commit -m "feat(state-inference): evaluateStateInference (active-source loop, config read)"
```

### Task 5.2: Heartbeat ticker registration in `server.js`

**Files:** `system/runtime/daemon/server.js`

- [ ] **Step 1: Read the existing `closeStaleEpisodes` ticker (lines 607–620) to confirm the pattern.**

```bash
grep -n "closeStaleEpisodes\|action-trust-decay\|setInterval" system/runtime/daemon/server.js
```

Expected: confirms the `setInterval(... 600_000)` block at lines ~607–620 and the `actionTrustDecay` block at ~624–636.

- [ ] **Step 2: Register the state-inference ticker.**

**Branch A — R-2 of `docs/superpowers/plans/2026-05-11-runtime-layer-hardening.md` has shipped.** If `createScheduler({ buckets: [...] })` is in place (look for the definition in `system/runtime/daemon/boot.js` or `system/runtime/daemon/heartbeat-scheduler.js`), register `state-inference` as a bucket entry alongside the `actionTrustDecay` bucket. The shape (verify against the existing `actionTrustDecay` registration in that file):

```js
{
  name: 'state-inference',
  intervalMs: tickMs,
  tick: async () => {
    if (!ctx.host) return; // requires invokeLLM
    await evaluateStateInference({
      db: ctx.db,
      host: ctx.host,
      embedder: ctx.embedder,
    });
  },
}
```

Import `evaluateStateInference` and `readStateInferenceConfig` at the top of the boot module; resolve `tickMs` from `readStateInferenceConfig(ctx.db)` before constructing the bucket (fallback to `300_000`). Do NOT add an inline `setInterval` — that would be a fifth ticker R-2 just removed.

**Branch B — R-2 has not shipped.** Edit `system/runtime/daemon/server.js`. Locate the closing of the `actionTrustDecayTicker` block (the line `actionTrustDecayTicker.unref?.();` followed by `}` — around line 635). Append immediately after:

```js
    // Cognition D1: state-inference ticker. Default 5 min; tunable via
    // runtime:state_inference.config.tick_ms. Skipped when host is absent
    // (the faculty needs invokeLLM); each tick is gated by cfg.enabled
    // inside evaluateStateInference (false → no work; 'shadow' → runs
    // without writing memos; true → full path).
    let stateInferenceTicker = null;
    if (host) {
      const { evaluateStateInference, readStateInferenceConfig } = await import(
        '../../cognition/jobs/internal/state-inference.js'
      );
      const initialCfg = await readStateInferenceConfig(dbHandle).catch(() => ({ tick_ms: 300_000 }));
      const tickMs = Number.isInteger(initialCfg?.tick_ms) ? initialCfg.tick_ms : 300_000;
      stateInferenceTicker = setInterval(() => {
        evaluateStateInference({ db: dbHandle, host, embedder: embedderWrap }).catch((e) => {
          console.warn(`[state-inference] ${e.message}`);
        });
      }, tickMs);
      stateInferenceTicker.unref?.();
    }
```

Register the ticker in `shutdown()` — find the existing `if (sessionSweeper) clearInterval(sessionSweeper);` line and add alongside the other `clearInterval` calls inside `shutdown`:

```js
    if (stateInferenceTicker) clearInterval(stateInferenceTicker);
```

(If the existing shutdown only relies on `.unref?.()` and does not clear other tickers explicitly, the `unref` is sufficient — verify by reading lines 109–135 of `server.js` first.)

Detect which branch applies with `grep -l 'createScheduler' system/runtime/daemon/*.js` before editing.

- [ ] **Step 3: Write an integration test that starts the daemon and asserts the ticker registers.**

This is covered indirectly by `state-inference-cycle.test.js` in Phase 10 (E1 runs the full heartbeat → memo → recall path). No standalone ticker test needed; instead, verify by running `npm run test:integration` after Phase 10 lands.

- [ ] **Step 4: Manual smoke — ensure the daemon module still parses.**

```bash
node --check system/runtime/daemon/server.js
```

Expected: no syntax errors.

- [ ] **Step 5: Lint + commit.**

```bash
npm run lint
git add system/runtime/daemon/server.js
git commit -m "feat(daemon): register state-inference heartbeat ticker (5-min default)"
```

### Task 5.3: Operator-facing manifest

**Files:** `system/cognition/jobs/builtin/state-inference.md` (new)

- [ ] **Step 1: Confirm the manifest pattern.**

```bash
cat system/cognition/jobs/builtin/reinforce-recall.md
```

- [ ] **Step 2: Create the manifest.**

Write `system/cognition/jobs/builtin/state-inference.md`:

```markdown
---
name: state-inference
schedule: "*/5 * * * *"
runtime: internal
enabled: true
catch_up: false
timeout_minutes: 2
notify: none
notify_on_failure: true
manually_runnable: true
description: Per-source focus inference (5-min cadence). Reads attention + arcs + recent biographed events; LLM-gated by a signal-hash change detector.
---

Internal job. Implementation in `cognition/jobs/internal/state-inference.js`. Heartbeat-paced ticker is mounted in `runtime/daemon/server.js` alongside `close-stale-episodes` — this manifest is the operator-facing documentation; the actual cadence is set by the daemon ticker (default 5 min), not by the `schedule` field above.

Per tick, for each active episode source:

1. Read the latest non-superseded `state_inference` memo for the source (`latestForSource`).
2. Read the current attention lens at `cfg.attention_window_min` (default 90 min).
3. Pick the dominant active arc (entity-set overlap).
4. Pick up to 5 recently biographed events whose `mentions` edges touch the attention entity set.
5. Compute a SHA-256 hash of `{entities, arc_id, last_event_id}`. If equal to `prior.meta.signal_hash` and the prior is fresh (`< refresh_after_minutes`), skip the LLM call entirely.
6. Otherwise emit a calibration row to `evidence_ledger` (corroborate/refute) classifying the prior against the current snapshot.
7. Call `host.invokeLLM` (fast tier). LLM returns `{ focus_statement, confidence, evidence_snippet, ambiguous, drop }`.
8. If `drop=false`, write a new `kind='state_inference'` memo and supersede the prior. If any candidate entity/event/arc has `scope='private'`, the new memo inherits `scope='private'`.
9. Append one row to `state_inference_telemetry` per source per tick.

Gated by `runtime:state_inference.config.enabled` (three-valued: `false` | `'shadow'` | `true`).

Surfacing of the `<!-- current focus -->` block in the intuition path is also gated by `enabled === true` (suppression rule 1, `system/cognition/intuition/inject.js`).
```

- [ ] **Step 3: Commit.**

```bash
git add system/cognition/jobs/builtin/state-inference.md
git commit -m "docs(jobs): state-inference manifest"
```

---

## Phase 6 — Recall surfacing (focus block in intuition)

### Task 6.1: Source resolution in `handler.js`

**Files:** `system/cognition/intuition/handler.js`

- [ ] **Step 1: Write a failing test for source resolution.**

Create `system/tests/unit/intuition-handler-source.test.js`:

```js
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolveSourceForHandler } from '../../cognition/intuition/handler.js';

test('ROBIN_SOURCE env wins', () => {
  const r = resolveSourceForHandler({ env: { ROBIN_SOURCE: 'agent:custom' } });
  assert.equal(r, 'agent:custom');
});

test('CLAUDE_PROJECT_DIR → agent:claude-code', () => {
  const r = resolveSourceForHandler({ env: { CLAUDE_PROJECT_DIR: '/x' } });
  assert.equal(r, 'agent:claude-code');
});

test('GEMINI_CLI_SESSION → agent:gemini-cli', () => {
  const r = resolveSourceForHandler({ env: { GEMINI_CLI_SESSION: 'abc' } });
  assert.equal(r, 'agent:gemini-cli');
});

test('no signal → null', () => {
  const r = resolveSourceForHandler({ env: {} });
  assert.equal(r, null);
});
```

- [ ] **Step 2: Run — expect failure (export missing).**

```bash
npm run test:unit -- --test-name-pattern='resolveSourceForHandler'
```

- [ ] **Step 3: Add `resolveSourceForHandler` and wire into the handler.**

Edit `system/cognition/intuition/handler.js`.

(a) Add an export above `intuitionHandler`:

```js
/**
 * Resolve the agent-host source for the focus block (spec §4.2 step 1).
 *
 * Priority: ROBIN_SOURCE env → CLAUDE_PROJECT_DIR (→ agent:claude-code) →
 * GEMINI_CLI_SESSION (→ agent:gemini-cli) → null. The daemon performs
 * additional fallback (host?.name → most-recently-active episode lookup);
 * the handler stays additive.
 */
export function resolveSourceForHandler({ env = process.env } = {}) {
  const explicit = env.ROBIN_SOURCE;
  if (typeof explicit === 'string' && explicit.length > 0) return explicit;
  if (typeof env.CLAUDE_PROJECT_DIR === 'string' && env.CLAUDE_PROJECT_DIR.length > 0) {
    return 'agent:claude-code';
  }
  if (typeof env.GEMINI_CLI_SESSION === 'string' && env.GEMINI_CLI_SESSION.length > 0) {
    return 'agent:gemini-cli';
  }
  return null;
}
```

(b) In `intuitionHandler`, compute `source` once and include it in the POST body. Locate the existing `body: JSON.stringify({ query, prior_assistant: priorAssistant, k: 6, recency_days: 30, token_budget: 1500 })` block. Add a `source` variable above the `try`/fetch block:

```js
  const source = resolveSourceForHandler();
```

…and extend the body to include it:

```js
      body: JSON.stringify({
        query,
        prior_assistant: priorAssistant,
        k: 6,
        recency_days: 30,
        token_budget: 1500,
        source,
      }),
```

(c) After the existing `const block = typeof payload.block === 'string' ? payload.block : '';` line, prepend the focus block before writing to stdout:

```js
  const focusBlock = typeof payload.focus_block === 'string' ? payload.focus_block : '';
  const combined = `${focusBlock}${block}`;
  if (combined.length > 0) {
    writeOut(combined);
  }
```

Remove the old `if (block.length > 0) { writeOut(block); }` block — replaced by the combined writer.

- [ ] **Step 4: Run the tests — expect pass.**

```bash
npm run test:unit -- --test-name-pattern='resolveSourceForHandler'
```

- [ ] **Step 5: Lint + commit.**

```bash
npm run lint
git add system/cognition/intuition/handler.js system/tests/unit/intuition-handler-source.test.js
git commit -m "feat(intuition): source resolution + focus_block concatenation in handler"
```

### Task 6.2: Focus block in `inject.js` + suppression rules

**Files:** `system/cognition/intuition/inject.js`

- [ ] **Step 1: Write unit tests for the focus block builder and suppression helpers.**

Create `system/tests/unit/intuition-focus-block.test.js`:

```js
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildFocusBlock,
  evaluateFocusSuppression,
  humaniseDuration,
} from '../../cognition/intuition/inject.js';

test('humaniseDuration: 23m, 4h, 2d', () => {
  assert.equal(humaniseDuration(23 * 60_000), '23m');
  assert.equal(humaniseDuration(4 * 3_600_000), '4h');
  assert.equal(humaniseDuration(2 * 86_400_000), '2d');
  assert.equal(humaniseDuration(0), '0m');
});

test('buildFocusBlock renders frame + body + arc short id', () => {
  const ts = new Date(Date.now() - 23 * 60_000);
  const memo = {
    id: 'memos:abc',
    content: 'Kevin is refactoring cognition',
    confidence: 0.8,
    meta: {
      last_active_at: ts.toISOString(),
      arc_id: 'arcs:01HZABCDEFGHIJK',
    },
  };
  const block = buildFocusBlock(memo, { now: new Date() });
  assert.match(block, /<!-- current focus -->/);
  assert.match(block, /<!-- \/current focus -->/);
  assert.match(block, /\[focus, last active 23m ago, conf 0\.80\]/);
  assert.match(block, /Kevin is refactoring cognition/);
  assert.match(block, /arc:arcs:01HZABCDEFGHIJK/);
});

test('buildFocusBlock omits arc tag when arc_id is null', () => {
  const memo = {
    content: 'something',
    confidence: 0.6,
    meta: { last_active_at: new Date().toISOString(), arc_id: null },
  };
  const block = buildFocusBlock(memo, { now: new Date() });
  assert.doesNotMatch(block, /arc:/);
});

test('suppression rule 1: enabled !== true → suppressed=disabled', () => {
  const r = evaluateFocusSuppression({ cfg: { enabled: 'shadow' }, memo: null, query: '', now: new Date() });
  assert.equal(r.suppressed, 'disabled');
});

test('suppression rule 2: no memo → no_memo', () => {
  const r = evaluateFocusSuppression({ cfg: { enabled: true }, memo: null, query: '', now: new Date() });
  assert.equal(r.suppressed, 'no_memo');
});

test('suppression rule 3: confidence below floor → low_confidence', () => {
  const memo = {
    confidence: 0.3,
    meta: { last_active_at: new Date().toISOString(), entities: [] },
  };
  const r = evaluateFocusSuppression({
    cfg: { enabled: true, min_confidence_to_surface: 0.5, stale_after_minutes: 120 },
    memo,
    query: 'anything',
    now: new Date(),
  });
  assert.equal(r.suppressed, 'low_confidence');
});

test('suppression rule 4: stale → stale', () => {
  const memo = {
    confidence: 0.8,
    meta: { last_active_at: new Date(Date.now() - 4 * 3_600_000).toISOString(), entities: [] },
  };
  const r = evaluateFocusSuppression({
    cfg: { enabled: true, min_confidence_to_surface: 0.5, stale_after_minutes: 120 },
    memo,
    query: 'anything',
    now: new Date(),
  });
  assert.equal(r.suppressed, 'stale');
});

test('suppression rule 7: scope=private → private', () => {
  const memo = {
    confidence: 0.8,
    scope: 'private',
    content: 'secret',
    meta: { last_active_at: new Date().toISOString(), entities: [] },
  };
  const r = evaluateFocusSuppression({
    cfg: { enabled: true, min_confidence_to_surface: 0.5, stale_after_minutes: 120 },
    memo,
    query: 'secret',
    now: new Date(),
  });
  assert.equal(r.suppressed, 'private');
});

test('suppression rule 6: zero keyword overlap → pivot', () => {
  const memo = {
    confidence: 0.8,
    content: 'Kevin is refactoring cognition layer',
    meta: {
      last_active_at: new Date().toISOString(),
      entities: ['entities:cognition_refactor'],
    },
  };
  const r = evaluateFocusSuppression({
    cfg: { enabled: true, min_confidence_to_surface: 0.5, stale_after_minutes: 120 },
    memo,
    query: 'lunch plans tomorrow',
    now: new Date(),
  });
  assert.equal(r.suppressed, 'pivot');
});

test('all rules pass → suppressed=null', () => {
  const memo = {
    confidence: 0.8,
    content: 'Kevin is refactoring cognition layer',
    meta: {
      last_active_at: new Date().toISOString(),
      entities: ['entities:cognition_refactor'],
    },
  };
  const r = evaluateFocusSuppression({
    cfg: { enabled: true, min_confidence_to_surface: 0.5, stale_after_minutes: 120 },
    memo,
    query: 'how is the cognition refactoring going?',
    now: new Date(),
  });
  assert.equal(r.suppressed, null);
});
```

- [ ] **Step 2: Run — expect failure.**

```bash
npm run test:unit -- --test-name-pattern='buildFocusBlock|evaluateFocusSuppression|humaniseDuration'
```

- [ ] **Step 3: Modify `inject.js` — add the focus block + suppression helpers + new wire format.**

Edit `system/cognition/intuition/inject.js`.

(a) Add imports near the top (after the existing imports):

```js
import { latestForSource } from '../memory/state_inference.js';
import { readStateInferenceConfig } from '../jobs/internal/state-inference.js';
import { isOutboundBlocked } from '../memory/scope-registry.js';
```

(b) Add constants near `const OPEN = ...`:

```js
const FOCUS_OPEN = '<!-- current focus -->';
const FOCUS_CLOSE = '<!-- /current focus -->';
const FOCUS_FRAME_TOKENS = estimateTokens(`${FOCUS_OPEN}\n${FOCUS_CLOSE}\n`);
const FOCUS_TOKEN_BUDGET = 200;
```

(c) Add helpers:

```js
export function humaniseDuration(ms) {
  const m = Math.max(0, Math.floor(ms / 60_000));
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  return `${d}d`;
}

export function buildFocusBlock(memo, { now = new Date() } = {}) {
  const ts = memo?.meta?.last_active_at;
  const lastActive = ts instanceof Date ? ts : new Date(ts);
  const dur = humaniseDuration(now.getTime() - lastActive.getTime());
  const conf = (memo?.confidence ?? 0).toFixed(2);
  const arcId = memo?.meta?.arc_id;
  const arcTag = arcId ? ` — arc:${String(arcId)}` : '';
  const body = `[focus, last active ${dur} ago, conf ${conf}] ${memo.content}${arcTag}`;
  return `${FOCUS_OPEN}\n${body}\n${FOCUS_CLOSE}`;
}

function keywordTokens(s) {
  return new Set(
    (typeof s === 'string' ? s : '')
      .toLowerCase()
      .split(/\W+/)
      .filter((w) => w.length > 3),
  );
}

export function evaluateFocusSuppression({ cfg, memo, query, now = new Date() }) {
  if (cfg?.enabled !== true) return { suppressed: 'disabled' };
  if (!memo) return { suppressed: 'no_memo' };
  if (memo.scope && isOutboundBlocked(memo.scope)) return { suppressed: 'private' };
  const minConf = cfg.min_confidence_to_surface ?? 0.5;
  if ((memo.confidence ?? 0) < minConf) return { suppressed: 'low_confidence' };
  const lastActive = memo?.meta?.last_active_at
    ? new Date(memo.meta.last_active_at)
    : new Date(0);
  const ageMin = (now.getTime() - lastActive.getTime()) / 60_000;
  const staleMin = cfg.stale_after_minutes ?? 120;
  if (ageMin > staleMin) return { suppressed: 'stale' };
  // Defensive supersedes-leak check (rule 5): caller already filters via
  // latestForSource; if a `_superseded_count` was hydrated and > 0, suppress.
  if ((memo._superseded_count ?? 0) > 0) return { suppressed: 'superseded' };
  // Pivot detection (rule 6): zero keyword overlap with entities OR content.
  const qTokens = keywordTokens(query);
  if (qTokens.size === 0) return { suppressed: null };
  const cTokens = keywordTokens(memo.content);
  const entTokens = new Set();
  for (const e of memo?.meta?.entities ?? []) {
    for (const t of keywordTokens(String(e).split(':').slice(1).join('_'))) entTokens.add(t);
  }
  let intersect = 0;
  for (const t of qTokens) if (cTokens.has(t) || entTokens.has(t)) intersect++;
  if (intersect === 0) return { suppressed: 'pivot' };
  return { suppressed: null };
}
```

(d) Extend `intuitionEndpoint`'s signature to accept `source`.

Coordinate with A3 (`docs/superpowers/plans/2026-05-11-cognition-a3-recall-eval-and-mmr.md`): A3 introduces `sessionId` to the same destructure (snake_case `session_id` in the POST body, destructured to `sessionId` locally). The merge order is A3 → B1 (which reuses A3's plumbing) → D1, so by the time this task lands, `sessionId` may already be present.

**If A3 has shipped** (look for `sessionId` in the current destructure), the block becomes:

```js
export async function intuitionEndpoint({
  db,
  embedder,
  query,
  priorAssistant = '',
  sessionId = null,
  source = null,
  k = 6,
  recencyDays = 30,
  tokenBudget = 1500,
}) {
```

Add only `source = null`; leave `sessionId` untouched.

**If A3 has not shipped**, add both fields together:

```js
export async function intuitionEndpoint({
  db,
  embedder,
  query,
  priorAssistant = '',
  sessionId = null,
  source = null,
  k = 6,
  recencyDays = 30,
  tokenBudget = 1500,
}) {
```

…and document in the commit message that B1 + A3 coordinate via `session_id` (snake_case body field, destructured to `sessionId` locally). The original signature `{ db, embedder, query, priorAssistant = '', k = 6, recencyDays = 30, tokenBudget = 1500 }` is replaced wholesale.

(e) After the existing `block`/`tokens`/`truncated` computation (around line ~173) but before the telemetry write, compute the focus block:

```js
  // Cognition D1: focus block. Suppression is layered (rules 1–7).
  let focus_block = '';
  let focus_tokens = 0;
  let focus_suppressed_reason = null;
  try {
    const cfg = await readStateInferenceConfig(db);
    if (cfg.enabled !== true) {
      focus_suppressed_reason = 'disabled';
    } else if (!source) {
      focus_suppressed_reason = 'no_memo';
    } else {
      const memo = await latestForSource(db, source);
      const sup = evaluateFocusSuppression({ cfg, memo, query: safeQuery, now: new Date() });
      if (sup.suppressed) {
        focus_suppressed_reason = sup.suppressed;
        // Defensive supersedes-leak log (rule 5) — should never fire because
        // latestForSource already filters out superseded rows.
        if (sup.suppressed === 'superseded') {
          try {
            await db
              .query(
                surql`CREATE state_inference_telemetry CONTENT ${{
                  source,
                  outcome: 'error',
                  reason: 'supersedes_leak',
                }}`,
              )
              .collect();
          } catch {
            /* advisory */
          }
        }
      } else {
        const candidate = buildFocusBlock(memo);
        const candidateTokens = estimateTokens(candidate);
        if (candidateTokens <= FOCUS_TOKEN_BUDGET) {
          focus_block = candidate;
          focus_tokens = candidateTokens;
        } else {
          focus_suppressed_reason = 'over_budget';
        }
      }
    }
  } catch {
    // Fail-soft: never break the recall response.
    focus_suppressed_reason = 'error';
  }
```

(f) Extend telemetry — two surfaces:

**`intuition_telemetry`** (additive, advisory). Modify the existing `CREATE intuition_telemetry CONTENT ${{...}}` block to include:

```js
            focus_tokens,
            focus_suppressed_reason,
```

…inside the content object.

**`recall_log.meta`** (contract with A3). A3's eval harness stratifies recall metrics on `recall_log.meta.focus_block_present` (bool) and `recall_log.meta.focus_block_tokens` (number). Today `inject.js` writes (at lines 204–210 in current source — or wherever the `CREATE recall_log CONTENT` block has migrated to):

```js
        surql`CREATE recall_log CONTENT ${{
          query: safeQuery,
          k,
          ranked_hits: rankedHits,
          outcome: 'pending',
          meta: { latency_ms, truncated },
        }}`,
```

Extend the `meta` object inline so its keys match A3's golden-fixture field names exactly:

```js
          meta: {
            latency_ms,
            truncated,
            focus_block_present: focus_block.length > 0,
            focus_block_tokens: focus_tokens,
          },
```

A3 is the read side of this contract — do not rename either key without bumping A3's plan in lockstep.

(g) Extend the return value:

```js
  return {
    block,
    hits: hits.length,
    tokens,
    latency_ms,
    truncated,
    focus_block,
    focus_tokens,
    focus_suppressed_reason,
  };
```

- [ ] **Step 4: Run the focus-block unit tests — expect pass.**

```bash
npm run test:unit -- --test-name-pattern='buildFocusBlock|evaluateFocusSuppression|humaniseDuration'
```

- [ ] **Step 5: Lint + commit.**

```bash
npm run lint
git add system/cognition/intuition/inject.js system/tests/unit/intuition-focus-block.test.js
git commit -m "feat(intuition): current-focus block + 7-rule suppression layer"
```

### Task 6.3: Daemon forwards `source` to `intuitionEndpoint`

**Files:** `system/runtime/daemon/server.js` — OR `system/runtime/daemon/routes/intuition.js` if R-3 of `docs/superpowers/plans/2026-05-11-runtime-layer-hardening.md` has shipped.

Detect with `grep -l intuition system/runtime/daemon/routes/*.js 2>/dev/null` — if a file exists, edit it; otherwise edit server.js around line 897.

- [ ] **Step 1: Locate the existing `/internal/intuition` handler and extend it to read `body.source` with a host fallback.**

Edit the `if (req.method === 'POST' && req.url === '/internal/intuition')` block (server.js) or the equivalent `intuitionRoutes` entry (routes/intuition.js). Replace the `intuitionEndpoint(...)` call's argument object:

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
              source: await resolveDaemonSource(dbHandle, body, host),
            }).catch(() => ({
              block: '',
              hits: 0,
              tokens: 0,
              latency_ms: 0,
              focus_block: '',
              focus_tokens: 0,
              focus_suppressed_reason: 'error',
            }));
```

Also extend the no-`intuitionEndpoint` fallback path's payload to include focus fields:

```js
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(
            JSON.stringify({
              block: '',
              hits: 0,
              tokens: 0,
              latency_ms: 0,
              focus_block: '',
              focus_tokens: 0,
              focus_suppressed_reason: 'no_endpoint',
            }),
          );
          return;
```

- [ ] **Step 2: Add `resolveDaemonSource` helper near the top of the file (after the existing `BUILTIN_JOBS_DIR` constant).**

```js
async function resolveDaemonSource(db, body, host) {
  if (typeof body?.source === 'string' && body.source.length > 0) return body.source;
  if (host?.name) {
    // Map host name to canonical source.
    if (host.name === 'claude-code') return 'agent:claude-code';
    if (host.name === 'gemini') return 'agent:gemini-cli';
    return `agent:${host.name}`;
  }
  // Last-ditch: most-recently active episode's source. Bound to 60s
  // to keep the recall path fast.
  try {
    const [rows] = await db
      .query(
        `SELECT VALUE source FROM episodes
         WHERE ended_at IS NONE
           AND last_event_at >= time::now() - 60s
         ORDER BY last_event_at DESC
         LIMIT 1`,
      )
      .collect();
    return rows?.[0] ?? null;
  } catch {
    return null;
  }
}
```

- [ ] **Step 3: Smoke-check.**

```bash
node --check system/runtime/daemon/server.js
```

Expected: clean.

- [ ] **Step 4: Lint + commit.**

```bash
npm run lint
git add system/runtime/daemon/server.js
git commit -m "feat(daemon): forward source (body→host→episode) into intuitionEndpoint"
```

---

## Phase 7 — Calibration loop (already wired in composeForSource)

Note: The calibration logic landed in Phase 4.3 (`classifyPriorVsCurrent` + `addEvidence` call inside `composeForSource` + `priorHasCalibrationRow` dedup). Phase 7 is a single task: a focused calibration test that exercises the pivot and corroborate paths in isolation.

### Task 7.1: Calibration emission test

**Files:** `system/tests/unit/state-inference-calibration.test.js` (new)

- [ ] **Step 1: Write the test.**

```js
import assert from 'node:assert/strict';
import { mkdirSync as __mk } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { surql } from 'surrealdb';
import { composeForSource } from '../../cognition/jobs/internal/state-inference.js';
import { noteStateInference } from '../../cognition/memory/state_inference.js';
import * as store from '../../cognition/memory/store.js';
import { writeConfig } from '../../config/paths.js';
import { close, connect } from '../../data/db/client.js';
import { runMigrations } from '../../data/db/migrate.js';
import { createStubEmbedder } from '../../data/embed/embedder.js';

const HOME = join(tmpdir(), `robin-cal-${process.pid}-${Math.random().toString(36).slice(2)}`);
__mk(HOME, { recursive: true });
process.env.ROBIN_HOME = HOME;
await writeConfig({ embedder_profile: 'mxbai-1024' });

async function fresh() {
  const db = await connect({ engine: 'mem://' });
  await runMigrations(db, resolve(import.meta.dirname, '../../data/db/migrations'));
  return db;
}

// Inlined copy of the fixture helper from
// `state-inference-compose.test.js` (Task 4.3). Keep these helpers in sync
// across the test suite. recordEvent's VALID_SOURCES enum cannot accommodate
// agent transcripts, and the function ignores episode_id / entity_refs /
// biographed_at — so tests that need biographed events with mentions edges
// build them with raw SurrealQL.
async function seedBiographedEvent(db, embedder, {
  source = 'conversation',
  content,
  entities = [],
  episodeId = null,
}) {
  const [created] = await db
    .query(surql`CREATE events CONTENT ${{ source, content, biographed_at: new Date() }}`)
    .collect();
  const row = Array.isArray(created) ? created[0] : created;
  const eventId = row.id;
  if (episodeId) {
    await db.query(surql`UPDATE ${eventId} SET episode_id = ${episodeId}`).collect();
  }
  for (const entId of entities) {
    await db
      .query(surql`RELATE ${eventId}->mentions->${entId} CONTENT { kind: 'mentions' }`)
      .collect();
  }
  return { id: eventId };
}

async function seedEpisode(db, source = 'conversation') {
  await db
    .query(
      surql`CREATE episodes CONTENT ${{
        source,
        started_at: new Date(Date.now() - 5 * 60_000),
        last_event_at: new Date(),
      }}`,
    )
    .collect();
  const [epRows] = await db
    .query(surql`SELECT id FROM episodes WHERE source = ${source} LIMIT 1`)
    .collect();
  return epRows[0].id;
}

const TEST_SOURCE = 'conversation';

const CFG = {
  enabled: true,
  tick_ms: 300000,
  attention_window_min: 90,
  refresh_after_minutes: 30,
  min_events_for_inference: 2,
  max_sources_per_tick: 4,
  min_confidence_to_surface: 0.5,
  stale_after_minutes: 120,
  pivot_weight: 1.0,
  corroborate_weight: 1.0,
};

test('I7 — pivot emits state_inference_pivoted refute row', async () => {
  const db = await fresh();
  const e = createStubEmbedder({ dimension: 1024 });
  const epId = await seedEpisode(db);
  const entA = await store.upsertEntity(db, e, { type: 'topic', name: 'A' });
  const entB = await store.upsertEntity(db, e, { type: 'topic', name: 'B' });
  const prior = await noteStateInference(db, e, {
    source: TEST_SOURCE,
    content: 'about A',
    confidence: 0.8,
    entities: [entA.id],
    arc_id: 'arcs:01',
    last_active_at: new Date(),
    signal_hash: 'old',
  });
  await seedBiographedEvent(db, e, {
    source: TEST_SOURCE,
    content: 'new B',
    entities: [entB.id],
    episodeId: epId,
  });
  const host = {
    invokeLLM: async () => ({
      content: JSON.stringify({
        focus_statement: 'Working on B',
        confidence: 0.7,
        evidence_snippet: 'new B',
        ambiguous: false,
        drop: false,
      }),
      usage: { input_tokens: 200, output_tokens: 60 },
    }),
  };
  await composeForSource({ db, embedder: e, host, source: TEST_SOURCE, cfg: CFG });
  const [rows] = await db
    .query(`SELECT polarity, reason FROM evidence_ledger WHERE memo_id = $id`, {
      id: prior.id,
    })
    .collect();
  const refute = (rows ?? []).find(
    (r) => r.polarity === 'refutes' && r.reason === 'state_inference_pivoted',
  );
  assert.ok(refute, 'expected one state_inference_pivoted refute row');
  await close(db);
});

test('calibration is deduped — running composeForSource twice does not double-emit', async () => {
  const db = await fresh();
  const e = createStubEmbedder({ dimension: 1024 });
  const epId = await seedEpisode(db);
  const entA = await store.upsertEntity(db, e, { type: 'topic', name: 'A' });
  const entB = await store.upsertEntity(db, e, { type: 'topic', name: 'B' });
  const prior = await noteStateInference(db, e, {
    source: TEST_SOURCE,
    content: 'about A',
    confidence: 0.8,
    entities: [entA.id],
    arc_id: 'arcs:01',
    last_active_at: new Date(),
    signal_hash: 'old',
  });
  await seedBiographedEvent(db, e, {
    source: TEST_SOURCE,
    content: 'new B',
    entities: [entB.id],
    episodeId: epId,
  });
  // First tick: LLM drops → no write, but calibration row should still fire.
  const dropHost = {
    invokeLLM: async () => ({
      content: JSON.stringify({
        focus_statement: '',
        confidence: 0.1,
        evidence_snippet: '',
        ambiguous: true,
        drop: true,
      }),
    }),
  };
  await composeForSource({ db, embedder: e, host: dropHost, source: TEST_SOURCE, cfg: CFG });
  // Second tick: also drop. Dedup guard must prevent a second ledger row.
  await composeForSource({ db, embedder: e, host: dropHost, source: TEST_SOURCE, cfg: CFG });
  const [rows] = await db
    .query(
      `SELECT count() AS n FROM evidence_ledger
       WHERE memo_id = $id AND reason IN ['state_inference_pivoted','state_inference_held']
         AND ts > $prior_derived_at
       GROUP ALL`,
      { id: prior.id, prior_derived_at: prior.derived_at },
    )
    .collect();
  assert.equal(rows?.[0]?.n ?? 0, 1, 'expected exactly one post-derived calibration row');
  await close(db);
});
```

- [ ] **Step 2: Run — expect pass (code already in place from Phase 4.3).**

```bash
npm run test:unit -- --test-name-pattern='I7 —|calibration is deduped'
```

- [ ] **Step 3: Commit.**

```bash
git add system/tests/unit/state-inference-calibration.test.js
git commit -m "test(state-inference): calibration ledger emission + dedup"
```

---

## Phase 8 — Privacy propagation (already wired in `composeForSource`)

The privacy logic landed inside `readInputsForSource` (privateScopeDetected flag) and `composeForSource` (scope inheritance into the new memo). Phase 8 adds two targeted tests that pin the contract.

### Task 8.1: Privacy contract tests

**Files:** `system/tests/unit/state-inference-privacy.test.js` (new)

- [ ] **Step 1: Write A1 + A2 tests (spec §8.4).**

Create `system/tests/unit/state-inference-privacy.test.js`:

```js
import assert from 'node:assert/strict';
import { mkdirSync as __mk } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { surql } from 'surrealdb';
import { composeForSource } from '../../cognition/jobs/internal/state-inference.js';
import { noteStateInference } from '../../cognition/memory/state_inference.js';
import * as store from '../../cognition/memory/store.js';
import { writeConfig } from '../../config/paths.js';
import { close, connect } from '../../data/db/client.js';
import { runMigrations } from '../../data/db/migrate.js';
import { createStubEmbedder } from '../../data/embed/embedder.js';
import { createExplainStateInferenceTool } from '../../io/mcp/tools/explain-state-inference.js';

const HOME = join(tmpdir(), `robin-priv-${process.pid}-${Math.random().toString(36).slice(2)}`);
__mk(HOME, { recursive: true });
process.env.ROBIN_HOME = HOME;
await writeConfig({ embedder_profile: 'mxbai-1024' });

async function fresh() {
  const db = await connect({ engine: 'mem://' });
  await runMigrations(db, resolve(import.meta.dirname, '../../data/db/migrations'));
  return db;
}

// Inlined copy of the fixture helpers from
// `state-inference-compose.test.js` (Task 4.3). Keep these helpers in sync
// across the test suite.
async function seedBiographedEvent(db, embedder, {
  source = 'conversation',
  content,
  entities = [],
  episodeId = null,
}) {
  const [created] = await db
    .query(surql`CREATE events CONTENT ${{ source, content, biographed_at: new Date() }}`)
    .collect();
  const row = Array.isArray(created) ? created[0] : created;
  const eventId = row.id;
  if (episodeId) {
    await db.query(surql`UPDATE ${eventId} SET episode_id = ${episodeId}`).collect();
  }
  for (const entId of entities) {
    await db
      .query(surql`RELATE ${eventId}->mentions->${entId} CONTENT { kind: 'mentions' }`)
      .collect();
  }
  return { id: eventId };
}

async function seedEpisode(db, source = 'conversation') {
  await db
    .query(
      surql`CREATE episodes CONTENT ${{
        source,
        started_at: new Date(Date.now() - 5 * 60_000),
        last_event_at: new Date(),
      }}`,
    )
    .collect();
  const [epRows] = await db
    .query(surql`SELECT id FROM episodes WHERE source = ${source} LIMIT 1`)
    .collect();
  return epRows[0].id;
}

const TEST_SOURCE = 'conversation';

const CFG = {
  enabled: true,
  tick_ms: 300000,
  attention_window_min: 90,
  refresh_after_minutes: 30,
  min_events_for_inference: 2,
  max_sources_per_tick: 4,
  min_confidence_to_surface: 0.5,
  stale_after_minutes: 120,
  pivot_weight: 1.0,
  corroborate_weight: 1.0,
};

test('A1 — private state_inference memo redacted by explain_state_inference', async () => {
  const db = await fresh();
  const e = createStubEmbedder({ dimension: 1024 });
  const { id } = await noteStateInference(db, e, {
    source: TEST_SOURCE,
    content: 'SENSITIVE: ...',
    confidence: 0.9,
    entities: [],
    last_active_at: new Date(),
    signal_hash: 'priv',
    scope: 'private',
  });
  const tool = createExplainStateInferenceTool({ db });
  const r = await tool.handler({ source: TEST_SOURCE });
  assert.equal(r.current.private, true);
  assert.equal(typeof r.current.derived_at, 'string');
  assert.equal(r.current.content, undefined);
  await close(db);
});

test('A2 — entity scope=private causes new state_inference memo to inherit private', async () => {
  const db = await fresh();
  const e = createStubEmbedder({ dimension: 1024 });
  const epId = await seedEpisode(db);
  const ent = await store.upsertEntity(db, e, { type: 'topic', name: 'secret', scope: 'private' });
  await seedBiographedEvent(db, e, {
    source: TEST_SOURCE,
    content: 'hush',
    entities: [ent.id],
    episodeId: epId,
  });
  const host = {
    invokeLLM: async () => ({
      content: JSON.stringify({
        focus_statement: 'Working on secret',
        confidence: 0.7,
        evidence_snippet: 'hush',
        ambiguous: false,
        drop: false,
      }),
    }),
  };
  await composeForSource({ db, embedder: e, host, source: TEST_SOURCE, cfg: CFG });
  const [rows] = await db
    .query(`SELECT scope FROM memos WHERE kind = 'state_inference' LIMIT 1`)
    .collect();
  assert.equal(rows?.[0]?.scope, 'private');
  await close(db);
});
```

- [ ] **Step 2: Run — A1 will fail until the introspection tool lands (Phase 9). A2 should pass.**

```bash
npm run test:unit -- --test-name-pattern='A2 —'
```

Expected: A2 passes.

- [ ] **Step 3: Commit (A1 follows in Phase 9).**

```bash
git add system/tests/unit/state-inference-privacy.test.js
git commit -m "test(state-inference): privacy contract A2 (scope inheritance); A1 pending tool"
```

---

## Phase 9 — Introspection MCP tool `explain_state_inference`

### Task 9.1: Tool implementation

**Files:** `system/io/mcp/tools/explain-state-inference.js` (new)

- [ ] **Step 1: Confirm pattern via `explain-recall.js`.**

Already read in context; the tool returns `{ ... }` with no DB writes.

- [ ] **Step 2: Write the tool.**

Create `system/io/mcp/tools/explain-state-inference.js`:

```js
// explain-state-inference.js — Cognition D1 / Theme 4 introspection. Read-only.
//
// Returns:
//   current        latest non-superseded state_inference memo for the source
//                  (or for all sources if source is omitted, taking the
//                  highest derived_at across sources).
//   history        up to 10 hops of <-supersedes chain from current.
//   evidence_replay  ledger rows for every memo in history (chronological).
//
// Private-scope memos return only { private: true, id, derived_at }.

import { BoundQuery } from 'surrealdb';
import { isOutboundBlocked } from '../../../cognition/memory/scope-registry.js';

const HISTORY_HOPS = 10;

function redactIfPrivate(memo) {
  if (memo?.scope && isOutboundBlocked(memo.scope)) {
    return { private: true, id: String(memo.id), derived_at: memo.derived_at };
  }
  return {
    id: String(memo.id),
    content: memo.content,
    confidence: memo.confidence,
    derived_at: memo.derived_at,
    scope: memo.scope,
    meta: memo.meta,
  };
}

export function createExplainStateInferenceTool({ db }) {
  return {
    name: 'explain_state_inference',
    description:
      'Theme 4 introspection. Returns the latest state_inference memo for a source (or the freshest across all sources), plus its supersedes chain (up to 10 hops) and ledger rows. Read-only.',
    inputSchema: {
      type: 'object',
      properties: {
        source: { type: 'string', description: "e.g. 'agent:claude-code'" },
      },
    },
    handler: async ({ source } = {}) => {
      // current (most-recent non-superseded for source, or globally).
      const whereSource = source ? `AND meta.source = $source` : '';
      const [curRows] = await db
        .query(
          new BoundQuery(
            `SELECT id, content, confidence, derived_at, scope, meta FROM memos
             WHERE kind = 'state_inference' AND count(<-supersedes) = 0 ${whereSource}
             ORDER BY derived_at DESC LIMIT 1`,
            source ? { source } : {},
          ),
        )
        .collect();
      const cur = curRows?.[0];
      if (!cur) {
        return { current: null, history: [], evidence_replay: [] };
      }

      // history: walk <-supersedes from cur (up to HISTORY_HOPS).
      const history = [];
      let frontier = cur.id;
      for (let i = 0; i < HISTORY_HOPS; i++) {
        const [hops] = await db
          .query(
            new BoundQuery(
              `SELECT VALUE in FROM supersedes WHERE out = $id LIMIT 1`,
              { id: frontier },
            ),
          )
          .collect();
        const priorId = hops?.[0];
        if (!priorId) break;
        const [memoRows] = await db
          .query(
            new BoundQuery(
              `SELECT id, content, confidence, derived_at, scope, meta FROM ONLY $id`,
              { id: priorId },
            ),
          )
          .collect();
        const memo = memoRows?.[0] ?? memoRows;
        if (!memo) break;
        history.push(redactIfPrivate(memo));
        frontier = memo.id;
      }

      // evidence_replay: ledger rows for cur + every memo in history.
      const allIds = [cur.id, ...history.map((h) => h.id).filter((id) => !id?.startsWith?.('memos:'))];
      // Note: redacted entries serialize id as a string. Always include cur.id
      // plus the history ids; SurrealDB BoundQuery accepts string-or-record-ref
      // refs for `IN` filters.
      const refs = [cur.id, ...history.map((h) => h.id)];
      const [ledger] = await db
        .query(
          new BoundQuery(
            `SELECT memo_id, polarity, reason, weight, ts FROM evidence_ledger
             WHERE memo_id IN $refs ORDER BY ts ASC`,
            { refs },
          ),
        )
        .collect();

      return {
        current: redactIfPrivate(cur),
        history,
        evidence_replay: ledger ?? [],
      };
    },
  };
}
```

- [ ] **Step 3: Add the tool to the audit-introspection-readonly allowlist.**

Edit `system/tests/unit/audit-introspection-readonly.test.js`. Replace the `INTROSPECTION_TOOLS` array with the existing 7 entries plus the new one:

```js
const INTROSPECTION_TOOLS = [
  'system/io/mcp/tools/explain-recall.js',
  'system/io/mcp/tools/explain-belief.js',
  'system/io/mcp/tools/explain-action-trust.js',
  'system/io/mcp/tools/show-pending-triggers.js',
  'system/io/mcp/tools/show-step-health.js',
  'system/io/mcp/tools/recent-refusals.js',
  'system/io/mcp/tools/archive-history.js',
  'system/io/mcp/tools/explain-state-inference.js',
];
```

- [ ] **Step 4: Register the tool.**

The tool-registration site moves to its own module under R-3 of `docs/superpowers/plans/2026-05-11-runtime-layer-hardening.md` (`system/runtime/daemon/tools.js`). Detect with `grep -l 'createExplainRecallTool' system/runtime/daemon/{server.js,tools.js,boot.js} 2>/dev/null` and edit whichever file contains the existing registrations.

**If R-3 has shipped** (`tools.js` exists with the other registrations), add the import + `tools.push(...)` line there.

**Otherwise** edit `system/runtime/daemon/server.js`. Add an import near the other tool imports (alphabetical order — between `createExplainRecallTool` line 39 and `createFindEntityTool` line 40):

```js
import { createExplainStateInferenceTool } from '../../io/mcp/tools/explain-state-inference.js';
```

In the tool registration block (around line 472, right after `tools.push(createExplainRecallTool(...))`), add:

```js
    tools.push(createExplainStateInferenceTool({ db: dbHandle }));
```

- [ ] **Step 5: Run privacy A1 test + audit test — expect pass.**

```bash
npm run test:unit -- --test-name-pattern='A1 —|introspection tools are read-only'
```

Expected: both pass.

- [ ] **Step 6: Lint + commit.**

```bash
npm run lint
git add system/io/mcp/tools/explain-state-inference.js system/runtime/daemon/server.js system/tests/unit/audit-introspection-readonly.test.js
git commit -m "feat(mcp): explain_state_inference tool (read-only, private-redacting)"
```

### Task 9.2: Health rollup

**Files:** `system/runtime/cli/health.js`

- [ ] **Step 1: Add `rollupStateInference` + thread through `runHealth`.**

Edit `system/runtime/cli/health.js`. After `rollupStaleDream` (line ~91), add:

```js
export async function rollupStateInference(db) {
  let writes_24h = 0;
  let avg_conf = null;
  let errors_1h = 0;
  try {
    const [r] = await db
      .query(
        surql`SELECT count() AS n, math::mean(confidence) AS c
              FROM memos
              WHERE kind = 'state_inference'
                AND derived_at > time::now() - 24h`,
      )
      .collect();
    writes_24h = r?.[0]?.n ?? 0;
    avg_conf = r?.[0]?.c ?? null;
  } catch {}
  try {
    const [r] = await db
      .query(
        surql`SELECT count() AS n FROM state_inference_telemetry
              WHERE outcome = 'error' AND ts > time::now() - 1h GROUP ALL`,
      )
      .collect();
    errors_1h = r?.[0]?.n ?? 0;
  } catch {}
  let status = 'ok';
  if (errors_1h >= 3) status = 'fail';
  else if (errors_1h >= 1) status = 'warn';
  return { writes_24h, avg_conf, errors_1h, status };
}
```

(b) Update `runHealth` to call it and include in the all-status array:

Find:

```js
  const [budget, faculties, pending, dream] = await Promise.all([
    rollupTokenBudget(db),
    rollupFacultyErrors(db),
    rollupPendingTriggers(db),
    rollupStaleDream(db),
  ]);
  const all = [budget, ...faculties, pending, dream];
```

Replace with:

```js
  const [budget, faculties, pending, dream, stateInference] = await Promise.all([
    rollupTokenBudget(db),
    rollupFacultyErrors(db),
    rollupPendingTriggers(db),
    rollupStaleDream(db),
    rollupStateInference(db),
  ]);
  const all = [budget, ...faculties, pending, dream, stateInference];
```

In the JSON output block, add `state_inference: stateInference` to the object. In the text-output `lines`, add:

```js
  lines.push(
    `State inference (24h): ${GLYPH[stateInference.status]} ${stateInference.writes_24h} writes, ${stateInference.avg_conf == null ? '—' : `avg conf ${stateInference.avg_conf.toFixed(2)}`}, ${stateInference.errors_1h} errs/1h`,
  );
```

- [ ] **Step 2: Write a unit test for the rollup status thresholds.**

Create `system/tests/unit/state-inference-health.test.js`:

```js
import assert from 'node:assert/strict';
import { mkdirSync as __mk } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { writeConfig } from '../../config/paths.js';
import { close, connect } from '../../data/db/client.js';
import { runMigrations } from '../../data/db/migrate.js';
import { rollupStateInference } from '../../runtime/cli/health.js';

const HOME = join(tmpdir(), `robin-h-${process.pid}-${Math.random().toString(36).slice(2)}`);
__mk(HOME, { recursive: true });
process.env.ROBIN_HOME = HOME;
await writeConfig({ embedder_profile: 'mxbai-1024' });

async function fresh() {
  const db = await connect({ engine: 'mem://' });
  await runMigrations(db, resolve(import.meta.dirname, '../../data/db/migrations'));
  return db;
}

test('rollupStateInference: 0 errors → ok', async () => {
  const db = await fresh();
  const r = await rollupStateInference(db);
  assert.equal(r.status, 'ok');
  await close(db);
});

test('rollupStateInference: ≥1 error in last 1h → warn', async () => {
  const db = await fresh();
  await db
    .query(`CREATE state_inference_telemetry CONTENT { source: 'x', outcome: 'error' }`)
    .collect();
  const r = await rollupStateInference(db);
  assert.equal(r.status, 'warn');
  await close(db);
});

test('rollupStateInference: ≥3 errors in last 1h → fail', async () => {
  const db = await fresh();
  for (let i = 0; i < 3; i++) {
    await db
      .query(`CREATE state_inference_telemetry CONTENT { source: 'x', outcome: 'error' }`)
      .collect();
  }
  const r = await rollupStateInference(db);
  assert.equal(r.status, 'fail');
  await close(db);
});
```

- [ ] **Step 3: Run tests — expect pass.**

```bash
npm run test:unit -- --test-name-pattern='rollupStateInference'
```

- [ ] **Step 4: Lint + commit.**

```bash
npm run lint
git add system/runtime/cli/health.js system/tests/unit/state-inference-health.test.js
git commit -m "feat(health): state_inference rollup (writes/24h, avg conf, errors/1h)"
```

---

## Phase 10 — Integration tests (full cycle)

### Task 10.1: I1–I9 + E1–E2 integration test

**Files:** `system/tests/integration/state-inference-cycle.test.js` (new)

- [ ] **Step 1: Write the integration test file.**

Create `system/tests/integration/state-inference-cycle.test.js`:

```js
import assert from 'node:assert/strict';
import { mkdirSync as __mk } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { surql } from 'surrealdb';
import { intuitionEndpoint } from '../../cognition/intuition/inject.js';
import {
  composeForSource,
  evaluateStateInference,
} from '../../cognition/jobs/internal/state-inference.js';
import { noteStateInference } from '../../cognition/memory/state_inference.js';
import * as store from '../../cognition/memory/store.js';
import { writeConfig } from '../../config/paths.js';
import { close, connect } from '../../data/db/client.js';
import { runMigrations } from '../../data/db/migrate.js';
import { createStubEmbedder } from '../../data/embed/embedder.js';

const HOME = join(tmpdir(), `robin-int-${process.pid}-${Math.random().toString(36).slice(2)}`);
__mk(HOME, { recursive: true });
process.env.ROBIN_HOME = HOME;
await writeConfig({ embedder_profile: 'mxbai-1024' });

async function fresh() {
  const db = await connect({ engine: 'mem://' });
  await runMigrations(db, resolve(import.meta.dirname, '../../data/db/migrations'));
  return db;
}

async function setEnabled(db, value) {
  await db
    .query(`UPDATE runtime:\`state_inference.config\` SET value.enabled = $v`, { v: value })
    .collect();
}

const TEST_SOURCE = 'conversation';

// Inlined fixture helper — see Task 4.3 for the canonical definition. Keep
// in sync across compose/calibration/privacy/integration test files.
async function seedBiographedEvent(db, embedder, {
  source = TEST_SOURCE,
  content,
  entities = [],
  episodeId = null,
}) {
  const [created] = await db
    .query(surql`CREATE events CONTENT ${{ source, content, biographed_at: new Date() }}`)
    .collect();
  const row = Array.isArray(created) ? created[0] : created;
  const eventId = row.id;
  if (episodeId) {
    await db.query(surql`UPDATE ${eventId} SET episode_id = ${episodeId}`).collect();
  }
  for (const entId of entities) {
    await db
      .query(surql`RELATE ${eventId}->mentions->${entId} CONTENT { kind: 'mentions' }`)
      .collect();
  }
  return { id: eventId };
}

async function seedSource(db, e, { source = TEST_SOURCE, entities = ['cognition'] } = {}) {
  await db
    .query(
      surql`CREATE episodes CONTENT ${{
        source,
        started_at: new Date(Date.now() - 5 * 60_000),
        last_event_at: new Date(),
      }}`,
    )
    .collect();
  const [epRows] = await db
    .query(surql`SELECT id FROM episodes WHERE source = ${source} LIMIT 1`)
    .collect();
  const entRefs = [];
  for (const name of entities) {
    const ent = await store.upsertEntity(db, e, { type: 'topic', name });
    entRefs.push(ent.id);
  }
  await seedBiographedEvent(db, e, {
    source,
    content: 'event content',
    entities: entRefs,
    episodeId: epRows[0].id,
  });
  return { epId: epRows[0].id, entRefs };
}

function makeHost(focusStatement, confidence = 0.8, drop = false) {
  return {
    invokeLLM: async () => ({
      content: JSON.stringify({
        focus_statement: focusStatement,
        confidence,
        evidence_snippet: 'snippet',
        ambiguous: false,
        drop,
      }),
      usage: { input_tokens: 200, output_tokens: 60 },
    }),
  };
}

/**
 * Counter mock — wraps `makeHost` and exposes `.calls`. Used by E2 to assert
 * the steady-state "zero LLM calls on no-change tick" invariant at the
 * integration level (the unit test U2 already pins the contract; E2 makes it
 * a regression guard against the full request → telemetry → write loop).
 */
function makeCountingHost(focusStatement, confidence = 0.8, drop = false) {
  const inner = makeHost(focusStatement, confidence, drop);
  let calls = 0;
  return {
    invokeLLM: async (...args) => {
      calls++;
      return inner.invokeLLM(...args);
    },
    get calls() {
      return calls;
    },
  };
}

const QUERY = 'how is the cognition work going?';

test('I1 — write → recall surfaces the focus block', async () => {
  const db = await fresh();
  const e = createStubEmbedder({ dimension: 1024 });
  await setEnabled(db, true);
  await seedSource(db, e);
  await composeForSource({
    db,
    embedder: e,
    host: makeHost('Kevin is refactoring the cognition layer'),
    source: TEST_SOURCE,
    cfg: {
      enabled: true,
      attention_window_min: 90,
      refresh_after_minutes: 30,
      min_events_for_inference: 1,
      max_sources_per_tick: 4,
      min_confidence_to_surface: 0.5,
      stale_after_minutes: 120,
    },
  });
  const r = await intuitionEndpoint({
    db,
    embedder: e,
    query: QUERY,
    source: TEST_SOURCE,
  });
  assert.match(r.focus_block, /<!-- current focus -->/);
  assert.match(r.focus_block, /Kevin is refactoring the cognition layer/);
  assert.match(r.focus_block, /last active 0m ago/);
  assert.ok(r.focus_tokens > 0);
  await close(db);
});

test('I2 — low confidence → suppressed', async () => {
  const db = await fresh();
  const e = createStubEmbedder({ dimension: 1024 });
  await setEnabled(db, true);
  await noteStateInference(db, e, {
    source: TEST_SOURCE,
    content: 'low conf focus',
    confidence: 0.3,
    entities: [],
    last_active_at: new Date(),
    signal_hash: 's',
  });
  const r = await intuitionEndpoint({
    db,
    embedder: e,
    query: QUERY,
    source: TEST_SOURCE,
  });
  assert.equal(r.focus_block, '');
  assert.equal(r.focus_suppressed_reason, 'low_confidence');
  await close(db);
});

test('I3 — stale → suppressed', async () => {
  const db = await fresh();
  const e = createStubEmbedder({ dimension: 1024 });
  await setEnabled(db, true);
  await noteStateInference(db, e, {
    source: TEST_SOURCE,
    content: 'stale focus',
    confidence: 0.8,
    entities: [],
    last_active_at: new Date(Date.now() - 4 * 3_600_000),
    signal_hash: 's',
  });
  const r = await intuitionEndpoint({
    db,
    embedder: e,
    query: QUERY,
    source: TEST_SOURCE,
  });
  assert.equal(r.focus_suppressed_reason, 'stale');
  await close(db);
});

test('I4 — pivot (zero keyword overlap) → suppressed', async () => {
  const db = await fresh();
  const e = createStubEmbedder({ dimension: 1024 });
  await setEnabled(db, true);
  await noteStateInference(db, e, {
    source: TEST_SOURCE,
    content: 'Kevin is refactoring cognition',
    confidence: 0.8,
    entities: ['entities:cognition_refactor'],
    last_active_at: new Date(),
    signal_hash: 's',
  });
  const r = await intuitionEndpoint({
    db,
    embedder: e,
    query: 'lunch plans tomorrow',
    source: TEST_SOURCE,
  });
  assert.equal(r.focus_suppressed_reason, 'pivot');
  await close(db);
});

test('I5 — superseded chain: latestForSource returns B, not A', async () => {
  const db = await fresh();
  const e = createStubEmbedder({ dimension: 1024 });
  await setEnabled(db, true);
  const a = await noteStateInference(db, e, {
    source: TEST_SOURCE,
    content: 'A',
    confidence: 0.8,
    entities: ['entities:x'],
    last_active_at: new Date(),
    signal_hash: 'h1',
  });
  const b = await noteStateInference(db, e, {
    source: TEST_SOURCE,
    content: 'B',
    confidence: 0.8,
    entities: ['entities:x'],
    last_active_at: new Date(),
    signal_hash: 'h2',
  });
  await store.supersede(db, a.id, b.id);
  const r = await intuitionEndpoint({
    db,
    embedder: e,
    query: 'something x related',
    source: TEST_SOURCE,
  });
  assert.match(r.focus_block, /B/);
  assert.doesNotMatch(r.focus_block, /\] A —|\] A\n/);
  await close(db);
});

test('I6 — private memo → suppressed', async () => {
  const db = await fresh();
  const e = createStubEmbedder({ dimension: 1024 });
  await setEnabled(db, true);
  await noteStateInference(db, e, {
    source: TEST_SOURCE,
    content: 'secret',
    confidence: 0.9,
    entities: ['entities:secret'],
    last_active_at: new Date(),
    signal_hash: 'p',
    scope: 'private',
  });
  const r = await intuitionEndpoint({
    db,
    embedder: e,
    query: 'something secret related',
    source: TEST_SOURCE,
  });
  assert.equal(r.focus_suppressed_reason, 'private');
  await close(db);
});

test('I7 — calibration emits pivot refute (integration variant)', async () => {
  // Already covered exhaustively by the unit test; this assertion is a smoke
  // check that the ledger row is visible after composeForSource.
  const db = await fresh();
  const e = createStubEmbedder({ dimension: 1024 });
  await setEnabled(db, true);
  const { epId, entRefs: [entA] } = await seedSource(db, e, { entities: ['A'] });
  const entB = (await store.upsertEntity(db, e, { type: 'topic', name: 'B' })).id;
  const prior = await noteStateInference(db, e, {
    source: TEST_SOURCE,
    content: 'about A',
    confidence: 0.8,
    entities: [entA],
    arc_id: 'arcs:01',
    last_active_at: new Date(),
    signal_hash: 'old',
  });
  await seedBiographedEvent(db, e, {
    source: TEST_SOURCE,
    content: 'B happens',
    entities: [entB],
    episodeId: epId,
  });
  await composeForSource({
    db,
    embedder: e,
    host: makeHost('Working on B'),
    source: TEST_SOURCE,
    cfg: { enabled: true, attention_window_min: 90, refresh_after_minutes: 30, min_events_for_inference: 1, max_sources_per_tick: 4, min_confidence_to_surface: 0.5, stale_after_minutes: 120, pivot_weight: 1.0, corroborate_weight: 1.0 },
  });
  const [rows] = await db
    .query(`SELECT polarity, reason FROM evidence_ledger WHERE memo_id = $id`, { id: prior.id })
    .collect();
  const refute = (rows ?? []).find((r) => r.reason === 'state_inference_pivoted');
  assert.ok(refute);
  await close(db);
});

test('I8 — cfg.enabled=false → evaluate skips, intuition skips block', async () => {
  const db = await fresh();
  const e = createStubEmbedder({ dimension: 1024 });
  // default seed has enabled=false
  await seedSource(db, e);
  const host = makeHost('should never write');
  const r1 = await evaluateStateInference({ db, host, embedder: e });
  assert.equal(r1.outcome, 'skipped_disabled');
  const r2 = await intuitionEndpoint({
    db,
    embedder: e,
    query: QUERY,
    source: TEST_SOURCE,
  });
  assert.equal(r2.focus_suppressed_reason, 'disabled');
  await close(db);
});

test('I9 — shadow mode: pipeline runs, no memo written, focus block suppressed', async () => {
  const db = await fresh();
  const e = createStubEmbedder({ dimension: 1024 });
  await setEnabled(db, 'shadow');
  await seedSource(db, e);
  const host = makeHost('would-be focus');
  await evaluateStateInference({ db, host, embedder: e });
  // No memos written.
  const [memos] = await db
    .query(`SELECT count() AS n FROM memos WHERE kind = 'state_inference' GROUP ALL`)
    .collect();
  assert.equal(memos?.[0]?.n ?? 0, 0);
  // Telemetry rows exist.
  const [tel] = await db
    .query(`SELECT count() AS n FROM state_inference_telemetry GROUP ALL`)
    .collect();
  assert.ok((tel?.[0]?.n ?? 0) > 0);
  // Intuition path suppresses (rule 1 — 'shadow' is not literal true).
  const r = await intuitionEndpoint({
    db,
    embedder: e,
    query: QUERY,
    source: TEST_SOURCE,
  });
  assert.equal(r.focus_suppressed_reason, 'disabled');
  await close(db);
});

test('E1 — end-to-end: event → compose → recall surfaces; token count under cap', async () => {
  const db = await fresh();
  const e = createStubEmbedder({ dimension: 1024 });
  await setEnabled(db, true);
  await seedSource(db, e, { entities: ['cognition'] });
  await composeForSource({
    db,
    embedder: e,
    host: makeHost('Kevin is iterating on the cognition layer refactor'),
    source: TEST_SOURCE,
    cfg: { enabled: true, attention_window_min: 90, refresh_after_minutes: 30, min_events_for_inference: 1, max_sources_per_tick: 4, min_confidence_to_surface: 0.5, stale_after_minutes: 120 },
  });
  const r = await intuitionEndpoint({
    db,
    embedder: e,
    query: 'cognition work',
    source: TEST_SOURCE,
  });
  assert.match(r.focus_block, /Kevin is iterating on the cognition layer refactor/);
  assert.ok(r.focus_tokens <= 200, `expected focus_tokens ≤ 200, got ${r.focus_tokens}`);
  await close(db);
});

test('E2 — concurrent ticks within the same window are idempotent (zero LLM calls on rerun)', async () => {
  const db = await fresh();
  const e = createStubEmbedder({ dimension: 1024 });
  await setEnabled(db, true);
  await seedSource(db, e, { entities: ['cognition'] });
  const cfg = { enabled: true, attention_window_min: 90, refresh_after_minutes: 30, min_events_for_inference: 1, max_sources_per_tick: 4, min_confidence_to_surface: 0.5, stale_after_minutes: 120 };
  // First tick: counting host wraps the LLM call; we expect exactly one call.
  const firstHost = makeCountingHost('first');
  await composeForSource({
    db,
    embedder: e,
    host: firstHost,
    source: TEST_SOURCE,
    cfg,
  });
  assert.equal(firstHost.calls, 1, 'first tick: one LLM call');
  // Second tick: same inputs ⇒ same signal_hash ⇒ skipped_unchanged ⇒
  // the steady-state-no-LLM-call invariant requires zero invocations.
  const secondHost = makeCountingHost('would-be-second');
  const r = await composeForSource({
    db,
    embedder: e,
    host: secondHost,
    source: TEST_SOURCE,
    cfg,
  });
  assert.equal(r.outcome, 'skipped_unchanged');
  assert.equal(secondHost.calls, 0, 'second tick: zero LLM calls when nothing changed');
  const [memos] = await db
    .query(`SELECT count() AS n FROM memos WHERE kind = 'state_inference' GROUP ALL`)
    .collect();
  assert.equal(memos?.[0]?.n ?? 0, 1);
  await close(db);
});
```

- [ ] **Step 2: Run the integration suite — expect all to pass.**

```bash
npm run test:integration -- --test-name-pattern='I1 —|I2 —|I3 —|I4 —|I5 —|I6 —|I7 —|I8 —|I9 —|E1 —|E2 —'
```

Expected: 11 tests pass.

- [ ] **Step 3: Run the full unit + integration suites for regressions.**

```bash
npm run test:unit
npm run test:integration
```

Expected: clean (or only failures unrelated to state_inference). Investigate any unexpected red.

- [ ] **Step 4: Commit.**

```bash
git add system/tests/integration/state-inference-cycle.test.js
git commit -m "test(state-inference): integration suite I1–I9 + E1–E2"
```

---

## Phase 11 — Docs

### Task 11.1: `docs/faculties.md` — new "state inference" subsection + tool entry

**Files:** `docs/faculties.md`

- [ ] **Step 1: Read the existing "Process faculties" section's structure.**

```bash
grep -n "^## \|^### " docs/faculties.md
```

- [ ] **Step 2: Add a new subsection.**

In `docs/faculties.md`, locate the "## Process faculties" section. After the existing `### evidence (alpha.16, Theme 2a)` subsection (or wherever fits alphabetically by capability number — D1 sits after Theme 4 introspection), append:

```markdown
### state-inference (cognition D1)

**What:** One-line "what is the user currently working on?" inference, per agent source. Heartbeat-paced (default 5 min); LLM-gated by a SHA-256 signal-hash change detector over `(entities, arc_id, last_event_id)`.

**Data:** `memos.kind = 'state_inference'` (already in `kind-registry.js`). `meta.dimension = 'current_focus'` (v1 fixes this; other dimensions are deferred). `meta.source` carries the agent-host identity. Half-life: 6h.

**Code:**
- `system/cognition/memory/state_inference.js` — lens (`noteStateInference`, `latestForSource`, `listRecent`).
- `system/cognition/jobs/internal/state-inference.js` — heartbeat job (`evaluateStateInference`, `composeForSource`).
- `system/cognition/jobs/builtin/state-inference.md` — manifest.

**Surfacing:** Privileged `<!-- current focus -->` block above `<!-- relevant memory -->` in `system/cognition/intuition/inject.js`, gated by 7 suppression rules (disabled flag, no memo, low confidence, stale, supersedes leak, pivot, private scope) and a 200-token cap.

**Calibration:** Each new inference compares against the prior via entity-set Jaccard + arc match; emits one `evidence_ledger` row per pivot or hold (`reason ∈ {state_inference_held, state_inference_pivoted}`). Dedup via reason filter on rows newer than `prior.derived_at`.

**Rollout flag:** `runtime:state_inference.config.enabled` is three-valued: `false` | `'shadow'` | `true`. Shadow runs the pipeline (including the LLM) but suppresses the memo write and the intuition block.

**Introspection MCP tool:** `explain_state_inference` (read-only) — returns `{ current, history (up to 10 supersedes hops), evidence_replay }`. Private-scope memos return only `{ private: true, id, derived_at }`.
```

(b) Locate the existing introspection tool list (`### introspection (alpha.16, Theme 4)`) and append a bullet for `explain_state_inference`:

```markdown
- `explain_state_inference` — Latest state_inference memo for a source, supersedes chain, calibration replay.
```

- [ ] **Step 3: Commit.**

```bash
git add docs/faculties.md
git commit -m "docs(faculties): state-inference faculty + explain_state_inference tool"
```

### Task 11.2: `docs/architecture.md` — agent turn + heartbeat ticker

**Files:** `docs/architecture.md`

- [ ] **Step 1: Locate the "A typical agent turn" section (line ~120).**

- [ ] **Step 2: Insert a sentence about the focus block.**

Find the step that mentions injecting `<!-- relevant memory -->` and add immediately before it:

```markdown
- The handler asks the daemon for the latest `state_inference` for the agent's source; if one exists and is fresh + confident, the daemon returns a `<!-- current focus -->` block which is prepended above the relevant-memory block (200-token cap; suppression rules cover disabled flag, low confidence, staleness, supersedes leak, pivot detection, and private scope).
```

- [ ] **Step 3: Locate the "Evolution layer (alpha.16)" section and add an entry for D1.**

After the existing list, append:

```markdown
- **Cognition D1 (state inference).** Heartbeat-paced 5-min ticker in `runtime/daemon/server.js` runs `evaluateStateInference` once per active source. Writes `memos.kind = 'state_inference'` via `cognition/memory/state_inference.js`. The intuition path surfaces a `<!-- current focus -->` block when the latest inference is fresh, confident, and not pivoted away from the user's current prompt. Gated by `runtime:state_inference.config.enabled` (`false` | `'shadow'` | `true`).
```

- [ ] **Step 4: Commit.**

```bash
git add docs/architecture.md
git commit -m "docs(architecture): state_inference in agent-turn + heartbeat ticker"
```

---

## Phase 12 — Rollout (three-valued flag flips)

These are three separate tasks staged behind real telemetry. Plan them as discrete commits so the rollout history is auditable.

### Task 12.1: Initial state — `enabled: false` (already set by seed)

**Files:** none (verification only)

- [ ] **Step 1: Confirm the migration seed is `false`.**

```bash
grep -n "enabled:" system/data/db/migrations/0012-state-inference.surql
```

Expected: `enabled: false,`.

- [ ] **Step 2: Run the full test suite one more time.**

```bash
npm run test:unit && npm run test:integration
```

Expected: clean. The faculty is dark.

- [ ] **Step 3: No code change; no commit. Document in the PR that "Phase 12.2 — shadow" follows in a separate PR after this lands."**

### Task 12.2: Flip to shadow — D1-shadow-flip (after D1-initial-off lands cleanly)

**Files:** `system/data/db/migrations/0013-state-inference-shadow.surql` (new) — a one-line follow-up migration

- [ ] **Step 1: Create the migration.**

Write `system/data/db/migrations/0013-state-inference-shadow.surql`:

```surql
-- Cognition D1-shadow-flip: state_inference flag from false → 'shadow'.
-- After this migration, the faculty runs end-to-end (including LLM calls)
-- but does not write memos; telemetry rows are still emitted. The intuition
-- path continues to suppress the focus block until enabled === true.

UPSERT runtime:`state_inference.config` SET value.enabled = 'shadow';
```

- [ ] **Step 2: Run the migration test against the new file.**

```bash
npm run test:unit -- --test-name-pattern='0012 migration|state_inference_telemetry'
```

Expected: still passes (the test reads the cfg after running every migration in order; this one only mutates a single field).

- [ ] **Step 3: Manually verify shadow behavior in dev by starting the daemon and tailing `state_inference_telemetry`.**

(Document in commit message that telemetry verification is required before Phase 12.3 lands.)

- [ ] **Step 4: Commit.**

```bash
git add system/data/db/migrations/0013-state-inference-shadow.surql
git commit -m "feat(rollout): state-inference shadow mode (telemetry-only)"
```

### Task 12.3: Flip to default-on — D1-default-on (after ~3 days of clean shadow telemetry)

**Files:** `system/data/db/migrations/0014-state-inference-enable.surql` (new)

- [ ] **Step 1: Verify the cost target from telemetry — should match spec §9.2: `skipped_unchanged / wrote ≥ 4:1`, `tokens_in` median ≤ 500, no errors in last 24h.**

```bash
# Manual: run `robin doctor --health --json | jq .state_inference` and inspect.
```

- [ ] **Step 2: Create the migration.**

Write `system/data/db/migrations/0014-state-inference-enable.surql`:

```surql
-- Cognition D1-default-on: state_inference flag from 'shadow' → true.
-- After this migration, the focus block surfaces in the intuition path.
-- Operators can disable per-host via:
--   UPDATE runtime:`state_inference.config` SET value.enabled = false;
-- No restart required (5-second cfg cache).

UPSERT runtime:`state_inference.config` SET value.enabled = true;
```

- [ ] **Step 3: Run the full test suite.**

```bash
npm run test:unit && npm run test:integration
```

Expected: clean.

- [ ] **Step 4: Commit.**

```bash
git add system/data/db/migrations/0014-state-inference-enable.surql
git commit -m "feat(rollout): state-inference default-on (focus block surfaces)"
```

---

## Final verification

Run before opening the PR:

- [ ] `npm run lint` — clean.
- [ ] `npm run test:unit` — all green; in particular the 8 new unit test files all pass.
- [ ] `npm run test:integration` — all green; the 11 new integration assertions all pass.
- [ ] `node --check system/runtime/daemon/server.js` — clean.
- [ ] Manually inspect: `grep -rn "state_inference" docs/` shows entries in `faculties.md` + `architecture.md` only.
- [ ] Manually inspect: `ls system/data/db/migrations/` shows `0012-state-inference.surql` and (after Phase 12) `0013-state-inference-shadow.surql` + `0014-state-inference-enable.surql`.

## Open items (deferred follow-ups)

These are explicitly out of scope for this plan and tracked under the spec's §12 "Open questions":

- Top-K vs singleton per source (telemetry-driven; revisit if rapid intra-session arc toggling shows up).
- Multi-source consolidation (`dimension='current_focus_global'`).
- Embedding-overlap pivot detector (swap from cheap keyword overlap if false-negative rate > 10%).
- `refresh_after_minutes` tuning (default 30 is a guess).
- Manual override tool (`set_focus`) feeding the evidence ledger as a strong corroboration.
- Server-side `fn::freshness` mirror of the 6h half-life — currently a TODO comment near the constants in `0001-init.surql` (see spec §3.4); landing this requires a migration that re-creates `fn::freshness`.
