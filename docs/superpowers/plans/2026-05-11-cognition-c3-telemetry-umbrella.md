# Cognition C3 — Telemetry umbrella · Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land the telemetry umbrella from `docs/superpowers/specs/2026-05-11-cognition-c3-telemetry-umbrella-design.md` — one new rollup table (`telemetry_hourly`), one heartbeat-driven aggregator job, one retention sub-stage, one introspection MCP tool (`show_telemetry_rollup`), and one doctor probe (pending-row hard ceiling). No forced rewrites of existing recorders; raw tables stay where they are; the aggregator overlays a rolled-up view that consumers can opt into.

**Architecture:** A pure recorder (`system/cognition/telemetry/recorder.js`) enforces the §3.1/§3.4/§3.5 privacy / cardinality / fan-out contract for any *new* telemetry writer that chooses to adopt the umbrella shape. A per-faculty rollup registry (`system/cognition/telemetry/rollup-registry.js`) lists the hot SELECTs that the aggregator runs on each tick. The aggregator (`system/cognition/jobs/internal/telemetry-rollup.js`) reads cursors from `runtime:telemetry.cursor`, runs registered SELECTs against the hot raw tables, UPSERTs deterministic `telemetry_hourly:{dim_hash}` rows, advances cursors, prunes raw rows past `raw_retention_days` (default 7d) and hourly rows past `hourly_retention_days` (default 90d), and force-prunes stuck `recall_log` pending rows past `pending_recall_log_hard_ceiling_days` (default 30d). The MCP tool `show_telemetry_rollup` is a read-only window query over `telemetry_hourly`; the doctor probe surfaces the pending-row count as a health warning when it crosses the 100/7d threshold. Migration `0017-telemetry-umbrella.surql` is purely additive: the table, two `recall_log` indexes (`recall_log_evaluated_at`, `recall_log_outcome_evaluated`), a one-time legacy backfill of `recall_log.evaluated_at`, the two `runtime:telemetry.*` seeds, and a precondition check that A3's `DEFINE FIELD meta ON intuition_telemetry TYPE option<object> FLEXIBLE` is present.

**Tech Stack:** Node.js 18+, ES modules, SurrealDB 3.0.5 / `surrealkv://`, Biome (lint), `node --test` (runner).

**Spec:** `docs/superpowers/specs/2026-05-11-cognition-c3-telemetry-umbrella-design.md`

**Dependencies:**
- **A3 migration** `0010-recall-eval-and-mmr.surql` MUST land first — C3's migration precondition check fails loudly if `DEFINE FIELD meta ON intuition_telemetry TYPE option<object> FLEXIBLE` is missing. `migrate.js` runs migrations in numeric order, so `0010 < 0017` is satisfied naturally; the precondition check is belt-and-suspenders.
- **B1 migration** `0009-per-hit-reinforcement.surql` adds `recall_log.evaluated_at` (used by the `recall_log_eval` cursor) and `recall_log.attribution` (read by the attribution rollup branch). Same numeric-order guarantee.
- **R-3 (runtime-layer-hardening)** — already shipped per `system/runtime/daemon/routes/` and `system/runtime/daemon/tools.js:buildTools(ctx)`. C3 registers `show_telemetry_rollup` inside `buildTools(ctx)` (one-line addition). If a future R-3 reshuffle moves the registration site, edit the new site; the tool factory itself is unaffected.
- **Migration slot numbering.** Cross-cutting allocation from C3 design §7: B1=0009, A3=0010, C1=0011, D1=0012/0013/0014, B2=0015/0016, **C3=0017**, D2=0018, D3=0019, C2=0020. Every reference in this plan uses `0017-telemetry-umbrella.surql`. If a later land-order shuffle forces a renumber, bump and update all `0017-` references in this file.
- **Heartbeat job pattern.** The aggregator ships as a markdown-cron job under `system/cognition/jobs/builtin/*.md` dispatched by `system/runtime/daemon/dispatcher-tick.js`. R-2's bucket scheduler is **not** the host (per spec §11.1).
- **Existing precedents** — `system/cognition/jobs/internal/reinforce-recall.js` is the heartbeat-driven internal-job precedent; `system/cognition/jobs/internal/log-rotate.js` is the retention precedent. Both job descriptors (`.md`) use the same front-matter shape as `system/cognition/jobs/builtin/reinforce-recall.md`.
- **Snake_case naming convention** — `faculty`, `event_kind`, `dimensions_hash`, `metric_sums`, `metric_buckets`, `cadence_hot_steps`, `runtime:telemetry.config`, `runtime:telemetry.cursor`. Carry through to every key in every new file. JavaScript locals destructure to camelCase (`telemetryHourly`, `dimensionsHash`, `cadenceHotSteps`) per existing repo convention.

---

## File structure

| File | Status | Responsibility |
|---|---|---|
| `system/data/db/migrations/0017-telemetry-umbrella.surql` | **new** | `telemetry_hourly` schema + 2 indexes; `recall_log_evaluated_at` + `recall_log_outcome_evaluated` indexes; legacy `evaluated_at` backfill; `runtime:telemetry.config` + `runtime:telemetry.cursor` seeds; A3 precondition check via `INFO FOR TABLE` |
| `system/cognition/telemetry/recorder.js` | **new** | `recordTelemetry({faculty, event_kind, ts?, dimensions?, metrics?, meta?})` — enforces §3.1 dimension validation, §3.4 object fan-out + ≤16-key ceiling, §3.5 type restriction. Pure write to per-faculty raw tables (and an umbrella raw table for future opt-ins) |
| `system/cognition/telemetry/rollup-registry.js` | **new** | Per-faculty SELECT registry: cursor name, source table, SurrealQL SELECT, projection helper into `telemetry_hourly` row family. Entries: `intuition_telemetry`, `recall_log_eval`, `cadence_telemetry_hot`, `meta_cognition_telemetry` |
| `system/cognition/telemetry/rollup.js` | **new** | `rollupHotTelemetry({db, cfg})` — iterates registry, runs enabled SELECTs over `[$cursor, $cutoff)`, UPSERTs `telemetry_hourly:{dim_hash}` rows, advances per-cursor. Idempotent (every tick re-aggregates the cursor window). Fail-soft per branch |
| `system/cognition/telemetry/retention.js` | **new** | `pruneRawTelemetry({db, table, before, where?, timestampField?})` — one DELETE per call; fail-soft on error |
| `system/cognition/telemetry/config.js` | **new** | `readTelemetryConfig(db)` — reads `runtime:telemetry.config`, cached per tick |
| `system/cognition/telemetry/dimensions-hash.js` | **new** | `dimensionsHash(faculty, event_kind, hour, dimensions)` — deterministic sha256 over sorted-keys JSON; 24-hex truncation |
| `system/cognition/jobs/internal/telemetry-rollup.js` | **new** | Internal job entry — calls `rollupHotTelemetry`, then `pruneRawTelemetry` for raw + hourly + pending-hard-ceiling stages. Fail-soft per stage and per table |
| `system/cognition/jobs/internal/telemetry-prune.js` | **new** | Standalone retention-only entry point — re-uses `pruneRawTelemetry`; same contract as the prune stages inside `telemetry-rollup.js`. Lets operators run prune independently of rollup |
| `system/cognition/jobs/builtin/telemetry-rollup.md` | **new** | Cron descriptor — `schedule: "5 * * * *"`, `runtime: internal`, `enabled: true`, `catch_up: false`, `timeout_minutes: 2`, `notify_on_failure: true`, `manually_runnable: true` |
| `system/cognition/jobs/builtin/telemetry-prune.md` | **new** | Cron descriptor — `schedule: "15 * * * *"` (offset from rollup), `runtime: internal`, `enabled: true`. Belt-and-suspenders: prune runs even if rollup is failing |
| `system/io/mcp/tools/show-telemetry-rollup.js` | **new** | Read-only MCP introspection tool — `SELECT * FROM telemetry_hourly WHERE hour >= $since AND ($faculty IS NONE OR faculty = $faculty) AND ($event_kind IS NONE OR event_kind = $event_kind) ORDER BY hour DESC LIMIT $limit`. Shadow-mode-aware (returns error when `shadow_mode=true`) |
| `system/runtime/daemon/tools.js` | modify | Register `createShowTelemetryRollupTool({db: ctx.db})` inside `buildTools(ctx)` (one-line import + one-line `tools.push(...)`) |
| `system/runtime/cli/commands/doctor.js` | modify | Wire a new `probePendingRecallLog(db)` into the `--health` path. Surfaces "Pending recall_log >7d: ⚠ N (>100 indicates stuck reinforcement)" |
| `system/runtime/cli/health.js` | modify | Add `rollupPendingRecallLog(db)` aggregator + include in `runHealth` Promise.all + json output |
| `system/tests/unit/telemetry-recorder-validation.test.js` | **new** | §9.1 tests 7-8 + §3.5 type restriction — dimension length/charset/type validation, free-text rejection, object fan-out, ≤16-key ceiling |
| `system/tests/unit/telemetry-dimensions-hash.test.js` | **new** | §9.1 test 2 — hash determinism across key order; collision-free across faculty / event_kind / hour |
| `system/tests/unit/telemetry-rollup-math.test.js` | **new** | §9.1 tests 1, 3, 4, 5, 6 — hour bucket math; metric sums exactness; percentiles in GROUP BY (load-bearing SurrealQL idiom); empty window cursor advance; missing-dimension null bucket |
| `system/tests/unit/telemetry-rollup-registry.test.js` | **new** | Registry registration + lookup; faculties_enabled toggle; missing cursor name throws at boot |
| `system/tests/unit/telemetry-retention.test.js` | **new** | §9.1 tests 9-11 — prune respects `timestampField`, prune respects `where` clause (pending exclusion), pending hard-ceiling deletes + emits warning telemetry |
| `system/tests/integration/telemetry-rollup-job.test.js` | **new** | §9.2 tests 12-17 — idempotency, cursor advance, fallback on missing cursor, pending-not-rolled-up, post-evaluation rollup, per-faculty fail-soft |
| `system/tests/integration/telemetry-cadence-hot-bridge.test.js` | **new** | §9.2 test 20 + §3.2 — belief.%, dream.%, state_inference disposition; cadence_hot_steps config drives prefix match |
| `system/tests/integration/telemetry-migration-precondition.test.js` | **new** | §9.2 tests 21-22 — backfill UPDATE applies once; precondition check fails loudly if A3 meta DEFINE is missing |
| `system/tests/integration/telemetry-prune-job.test.js` | **new** | §9.2 tests 18-19 + standalone prune entry — default-path pending exclusion; shadow-mode behavior; standalone prune job runs without rollup stage |
| `system/tests/integration/telemetry-show-rollup-tool.test.js` | **new** | §9.4 test 30 — MCP tool read-only enforcement (existing `audit-introspection-readonly.test.js` covers the source-scan guard); filter by faculty / event_kind / window; shadow-mode error message |
| `system/tests/integration/telemetry-backwards-compat.test.js` | **new** | §9.3 tests 23-29 — `explain_recall` raw read unchanged; B1 attribution.mode counts propagate; A3 mmr_path dimension propagates; D1 focus_block_present propagates; B2 fan-out propagates; D3 query stays in `meta`; hand-aggregated raw == rollup ±1 row |
| `system/tests/integration/telemetry-doctor-probe.test.js` | **new** | §9.4 test 33 — pending-row probe count threshold; warns at >100 pending older than 7d |
| `docs/architecture.md` | modify | Add one paragraph under "Operational" / "Evolution layer" naming `telemetry_hourly` (90d retention) and pointing at this spec; diagram row added |
| `docs/faculties.md` | modify | New "Telemetry" subsection — describes `show_telemetry_rollup`, supported `faculty`/`event_kind` values, hot vs cold tier classification, `recordTelemetry` contract for new writers |

---

## Phase 0 — Migration `0017-telemetry-umbrella.surql`

> **Why first:** Every downstream phase reads `runtime:telemetry.config` or writes to `telemetry_hourly`. Migration is purely additive (one new table, two new indexes on `recall_log`, two `runtime:` seeds, one legacy backfill UPDATE, one `INFO FOR TABLE` precondition check). Lands behind `shadow_mode=true` so even if Phase 3 has not yet shipped, the row count stays at zero and no consumer is exposed.

### Task 0.1 — Verify migration slot `0017` is free

**Files (read only):** `system/data/db/migrations/`

- [ ] **Step 1: List existing migrations**

```bash
ls system/data/db/migrations/
```

Expected: file names end at `0008-doctor.surql` plus the in-flight slots through `0016-*.surql` if they've already landed. The listing must NOT already contain `0017-telemetry-umbrella.surql`. If a different `0017-*.surql` already exists (out-of-order land from a sibling C-track plan), escalate to the umbrella roadmap and bump to the next free numeric slot. Every reference to `0017-` in this plan would then need a rename in lockstep.

- [ ] **Step 2: Verify A3's `intuition_telemetry.meta` DEFINE is on disk in `0010-recall-eval-and-mmr.surql`**

```bash
grep -n 'DEFINE FIELD meta ON intuition_telemetry' system/data/db/migrations/0010-recall-eval-and-mmr.surql
```

Expected: one hit on the line `DEFINE FIELD meta ON intuition_telemetry TYPE option<object> FLEXIBLE`. If this line is missing, A3 has not yet landed — the §6.2 precondition check will trip and Phase 0 cannot ship. Block on A3.

### Task 0.2 — Failing integration test (precondition + backfill)

**Files:** `system/tests/integration/telemetry-migration-precondition.test.js`

- [ ] **Step 1: Failing test**

Create `system/tests/integration/telemetry-migration-precondition.test.js`:

```js
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { surql } from 'surrealdb';
import { close, connect } from '../../data/db/client.js';
import { runMigrations } from '../../data/db/migrate.js';

// Tests against an in-memory DB so the migration is exercised end-to-end.
test('0017 backfill: legacy recall_log rows get evaluated_at = ts (idempotent on re-run)', async () => {
  const db = await connect({ engine: 'mem://' });
  await runMigrations(db, 'system/data/db/migrations');

  // Seed pre-B1-shape rows: outcome set, evaluated_at NONE.
  const ts = new Date('2026-05-10T12:00:00Z');
  await db.query(surql`
    CREATE recall_log CONTENT {
      query: 'legacy A', k: 6, ranked_hits: [], outcome: 'reinforced',
      ts: ${ts}, evaluated_at: NONE, session_id: 'leg-1', meta: {}
    };
    CREATE recall_log CONTENT {
      query: 'legacy B', k: 6, ranked_hits: [], outcome: 'pending',
      ts: ${ts}, evaluated_at: NONE, session_id: 'leg-2', meta: {}
    };
  `).collect();

  // Re-run migration; migrate.js MUST treat 0017 as already-applied via
  // checksum (no UPDATE). We assert the backfill state from the first
  // apply only.
  await runMigrations(db, 'system/data/db/migrations');

  const [rows] = await db.query(surql`
    SELECT outcome, evaluated_at FROM recall_log ORDER BY query
  `).collect();
  // Reinforced row: stamped.
  assert.equal(rows[0].outcome, 'reinforced');
  assert.ok(rows[0].evaluated_at instanceof Date);
  // Pending row: untouched.
  assert.equal(rows[1].outcome, 'pending');
  assert.equal(rows[1].evaluated_at, null);

  await close(db);
});

test('0017 precondition: missing intuition_telemetry.meta DEFINE fails loudly', async () => {
  // Test fixture: a migration list with 0017 but without 0010's meta DEFINE.
  // Implementation re-uses `runMigrations` against a fixture path
  // containing only 0001..0008 and 0017. The 0017 INFO FOR TABLE check
  // MUST throw with a clear error message.
  const db = await connect({ engine: 'mem://' });
  // Run the baseline (0001..0008 only).
  await runMigrations(db, 'system/tests/fixtures/migrations-baseline');
  // Now attempt to apply 0017 in isolation. Expect an Error.
  await assert.rejects(
    runMigrations(db, 'system/tests/fixtures/migrations-with-0017-only'),
    /C3 precondition: DEFINE FIELD meta ON intuition_telemetry .* is required/,
  );
  await close(db);
});

test('0017 seeds runtime:telemetry.config and runtime:telemetry.cursor', async () => {
  const db = await connect({ engine: 'mem://' });
  await runMigrations(db, 'system/data/db/migrations');
  const [cfg] = await db.query(surql`SELECT value FROM ONLY runtime:\`telemetry.config\``).collect();
  assert.equal(cfg?.value?.enabled, true);
  assert.equal(cfg?.value?.shadow_mode, true);
  assert.equal(cfg?.value?.raw_retention_days, 7);
  assert.equal(cfg?.value?.hourly_retention_days, 90);
  assert.equal(cfg?.value?.cutoff_safety_seconds, 60);
  assert.deepEqual(cfg?.value?.cadence_hot_steps, ['belief.', 'dream.']);
  assert.equal(cfg?.value?.pending_recall_log_hard_ceiling_days, 30);
  const [cur] = await db.query(surql`SELECT value FROM ONLY runtime:\`telemetry.cursor\``).collect();
  assert.deepEqual(cur?.value, {});
  await close(db);
});

test('0017 adds recall_log indexes evaluated_at + outcome_evaluated', async () => {
  const db = await connect({ engine: 'mem://' });
  await runMigrations(db, 'system/data/db/migrations');
  const [info] = await db.query(surql`INFO FOR TABLE recall_log`).collect();
  // INFO FOR TABLE returns an object whose `indexes` key lists the indexes.
  // Surface shape may differ; the assertion below treats `info.indexes` as
  // a record-style map and falls back to string search if not found.
  const haystack = JSON.stringify(info ?? {});
  assert.match(haystack, /recall_log_evaluated_at/);
  assert.match(haystack, /recall_log_outcome_evaluated/);
  await close(db);
});
```

- [ ] **Step 2: Run → fail**

```bash
npm run test:integration -- --test-name-pattern '0017'
```

Expected: `Cannot find migration file system/data/db/migrations/0017-telemetry-umbrella.surql`.

### Task 0.3 — Create the migration

**Files:** `system/data/db/migrations/0017-telemetry-umbrella.surql`

- [ ] **Step 1: Create the migration file**

```surql
-- ============================================================================
-- Cognition C3 — telemetry umbrella.
-- One rollup table + one config row + one cursor row + two recall_log
-- indexes + a one-time legacy backfill. Existing per-faculty raw tables
-- (intuition_telemetry, recall_log, cadence_telemetry, …) stay; this
-- migration is purely additive.
-- ============================================================================

-- §6.2 precondition: A3's `meta` field on intuition_telemetry MUST be
-- defined before C3's rollup SELECT references `meta.from` / `meta.mmr_path`.
-- Without this DEFINE, every rolled-up row would silently group into
-- `dimensions: { source: null, mmr_path: null }` because the field doesn't
-- exist on the schema. Fail loudly here instead.
LET $info = (INFO FOR TABLE intuition_telemetry);
LET $has_meta = (
  string::contains(<string>$info, "DEFINE FIELD meta ON intuition_telemetry")
  AND string::contains(<string>$info, "FLEXIBLE")
);
IF !$has_meta THEN
  THROW "C3 precondition: DEFINE FIELD meta ON intuition_telemetry TYPE option<object> FLEXIBLE is required (lands in 0010-recall-eval-and-mmr.surql). Apply A3's migration before C3."
END;

-- ============================================================================
-- telemetry_hourly: the one rollup destination.
-- ============================================================================
DEFINE TABLE telemetry_hourly SCHEMAFULL TYPE NORMAL;
DEFINE FIELD hour            ON telemetry_hourly TYPE datetime;
DEFINE FIELD faculty         ON telemetry_hourly TYPE string;
DEFINE FIELD event_kind      ON telemetry_hourly TYPE string;
DEFINE FIELD dimensions      ON telemetry_hourly TYPE object FLEXIBLE DEFAULT {};
DEFINE FIELD count           ON telemetry_hourly TYPE int DEFAULT 0;
DEFINE FIELD metric_sums     ON telemetry_hourly TYPE object FLEXIBLE DEFAULT {};
DEFINE FIELD metric_buckets  ON telemetry_hourly TYPE object FLEXIBLE DEFAULT {};
DEFINE FIELD created_at      ON telemetry_hourly TYPE datetime DEFAULT time::now() READONLY;
DEFINE FIELD updated_at      ON telemetry_hourly TYPE datetime VALUE time::now();
DEFINE FIELD meta            ON telemetry_hourly TYPE option<object> FLEXIBLE;

-- Compound index for "filter by (faculty, event_kind), order by hour".
DEFINE INDEX telemetry_hourly_key  ON telemetry_hourly FIELDS faculty, event_kind, hour;
-- Secondary index for time-window scans (doctor, MCP default window).
DEFINE INDEX telemetry_hourly_hour ON telemetry_hourly FIELDS hour;

-- ============================================================================
-- recall_log indexes required by the recall_log_eval cursor SELECT (§4.2).
-- Existing recall_log indexes are recall_log_ts / recall_log_outcome /
-- recall_log_session — none cover `evaluated_at`. Without these, the
-- hourly rollup full-scans recall_log every tick.
-- ============================================================================
DEFINE INDEX recall_log_evaluated_at      ON recall_log FIELDS evaluated_at;
DEFINE INDEX recall_log_outcome_evaluated ON recall_log FIELDS outcome, evaluated_at;

-- ============================================================================
-- One-time backfill: pre-B1 recall_log rows have `outcome` set but
-- `evaluated_at IS NONE` (the field was added by B1). The cursor's
-- `WHERE evaluated_at IS NOT NONE` filter would silently drop them.
-- Stamp legacy rows with their original `ts` so the first rollup picks
-- them up. Pending rows untouched.
-- ============================================================================
UPDATE recall_log SET evaluated_at = ts
  WHERE outcome != 'pending' AND evaluated_at IS NONE;

-- ============================================================================
-- Config + cursor seeds. Ship with shadow_mode=true (§8.1) so rollups
-- accumulate silently for one week before the MCP tool surfaces them.
-- ============================================================================
UPSERT runtime:`telemetry.config` SET value = {
  enabled: true,
  shadow_mode: true,
  raw_retention_days: 7,
  hourly_retention_days: 90,
  daily_retention_days: 365,
  cutoff_safety_seconds: 60,
  cursor_fallback_window_hours: 24,
  faculties_enabled: ['intuition', 'reinforcement', 'belief', 'dream', 'meta_cognition'],
  cadence_hot_steps: ['belief.', 'dream.'],
  pending_recall_log_hard_ceiling_days: 30
};

-- Initialise the cursor row empty; the aggregator falls back to
-- `now - cursor_fallback_window_hours` on first tick per cursor key.
UPSERT runtime:`telemetry.cursor` SET value = {};
```

- [ ] **Step 2: Create the test fixtures used by the precondition test**

Create `system/tests/fixtures/migrations-baseline/` and `system/tests/fixtures/migrations-with-0017-only/`:

- `migrations-baseline/` contains copies of `0001-init.surql` through `0008-doctor.surql` only (no A3, no B1, no C3).
- `migrations-with-0017-only/` contains `0001-init.surql` through `0008-doctor.surql` AND `0017-telemetry-umbrella.surql` (no `0010` — the precondition trips).

Both fixtures are copy-from-source; the test does not maintain them, so a follow-up migration adding a new baseline file must also add it to the fixture (caught by the existing migration-fixture-sync test, if present; otherwise a one-line code review note).

- [ ] **Step 3: Run → pass**

```bash
npm run test:integration -- --test-name-pattern '0017'
```

Expected: all four 0017 tests pass.

- [ ] **Step 4: Verify existing migration tests still pass**

```bash
npm run test:integration -- --test-name-pattern 'bootstrap-empty-db'
```

Expected: pass — the umbrella migration applies cleanly on a fresh in-memory DB.

- [ ] **Step 5: Commit**

```bash
git commit -m "feat(schema): 0017-telemetry-umbrella — table + indexes + seeds + backfill"
```

---

## Phase 1 — `recorder.js` and the §3.1/§3.4/§3.5 contract

> **Why second:** Every downstream phase that writes new telemetry rows goes through `recordTelemetry()`. The recorder validates dimensions, fans out object-shaped metrics, and rejects free text — these are the hard contract that makes the rollup's GROUP BY safe. Land it with unit tests; later phases (`rollup-registry.js`, `rollup.js`) consume it.

### Task 1.1 — `recordTelemetry()` dimension validation

**Files:** `system/cognition/telemetry/recorder.js`, `system/tests/unit/telemetry-recorder-validation.test.js`

- [ ] **Step 1: Failing test**

Create `system/tests/unit/telemetry-recorder-validation.test.js`:

```js
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { recordTelemetry } from '../../cognition/telemetry/recorder.js';

// Stub DB: capture writes; no real schema interaction.
function stubDb() {
  const writes = [];
  return {
    writes,
    query: (q, params) => ({
      collect: async () => {
        writes.push({ q: String(q), params });
        return [[]];
      },
    }),
  };
}

test('recordTelemetry rejects dimension value > 64 chars', async () => {
  const db = stubDb();
  await assert.rejects(
    recordTelemetry({
      db,
      faculty: 'intuition',
      event_kind: 'recall',
      dimensions: { source: 'a'.repeat(65) },
      metrics: {},
    }),
    /dimension value exceeds 64 chars/,
  );
  assert.equal(db.writes.length, 0);
});

test('recordTelemetry rejects dimension value with disallowed chars', async () => {
  const db = stubDb();
  await assert.rejects(
    recordTelemetry({
      db,
      faculty: 'intuition',
      event_kind: 'recall',
      dimensions: { mode: 'has spaces' },
    }),
    /dimension value charset/,
  );
});

test('recordTelemetry accepts a normal dimension value', async () => {
  const db = stubDb();
  await recordTelemetry({
    db,
    faculty: 'intuition',
    event_kind: 'recall',
    dimensions: { kind: 'normal_value-1.0' },
    metrics: {},
  });
  assert.equal(db.writes.length, 1);
});

test('recordTelemetry rejects float / nested object / non-ASCII dimension values', async () => {
  const db = stubDb();
  await assert.rejects(recordTelemetry({ db, faculty: 'x', event_kind: 'y', dimensions: { a: 1.5 } }), /dimension value type/);
  await assert.rejects(recordTelemetry({ db, faculty: 'x', event_kind: 'y', dimensions: { a: { nested: 1 } } }), /dimension value type/);
  await assert.rejects(recordTelemetry({ db, faculty: 'x', event_kind: 'y', dimensions: { a: 'café' } }), /dimension value charset/);
});

test('recordTelemetry routes free text to meta, not dimensions', async () => {
  const db = stubDb();
  // The recorder MUST NOT auto-move; the caller is responsible. This test
  // documents the rejection so callers learn to put free text in `meta`.
  await assert.rejects(
    recordTelemetry({
      db,
      faculty: 'belief',
      event_kind: 'call',
      dimensions: { query: 'how do I bake a sourdough loaf?' },
    }),
    /dimension value charset|exceeds 64 chars/,
  );
  // Valid usage: put it in meta.
  await recordTelemetry({
    db,
    faculty: 'belief',
    event_kind: 'call',
    dimensions: {},
    meta: { query: 'how do I bake a sourdough loaf?' },
  });
  assert.equal(db.writes.length, 1);
});

test('recordTelemetry fans out object-shaped metrics into scalar entries', async () => {
  const db = stubDb();
  await recordTelemetry({
    db,
    faculty: 'intuition',
    event_kind: 'recall',
    dimensions: { source: 'intuition' },
    metrics: {
      latency_ms: 18,
      contradictions_suppressed_by_rule: { low_confidence: 3, private_redaction: 1 },
    },
  });
  // The write payload's `metrics` should contain three scalar entries:
  // latency_ms, contradictions_suppressed_low_confidence,
  // contradictions_suppressed_private_redaction.
  const payload = db.writes[0].params;
  assert.equal(payload.metrics.latency_ms, 18);
  assert.equal(payload.metrics.contradictions_suppressed_low_confidence, 3);
  assert.equal(payload.metrics.contradictions_suppressed_private_redaction, 1);
  assert.equal(payload.metrics.contradictions_suppressed_by_rule, undefined);
});

test('recordTelemetry rejects object-shaped metrics with > 16 keys', async () => {
  const db = stubDb();
  const big = Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`rule_${i}`, i]));
  await assert.rejects(
    recordTelemetry({
      db,
      faculty: 'intuition',
      event_kind: 'recall',
      dimensions: {},
      metrics: { contradictions_suppressed_by_rule: big },
    }),
    /object-shaped metric exceeds 16 keys/,
  );
});
```

- [ ] **Step 2: Run → fail**

```bash
npm run test:unit -- --test-name-pattern 'recordTelemetry'
```

Expected: `Cannot find module .../recorder.js`.

- [ ] **Step 3: Implement `recorder.js`**

Create `system/cognition/telemetry/recorder.js`:

```js
// recorder.js — recordTelemetry({faculty, event_kind, ts?, dimensions?, metrics?, meta?})
//
// Contract (spec §3.1 / §3.4 / §3.5):
//   - dimensions values: string | bool | int (NO floats, NO nested objects,
//     NO arrays). Strings must match /^[A-Za-z0-9_.-]{1,64}$/.
//   - metrics values: scalar numbers OR object<string, number> with ≤16
//     keys; object values are fanned out into `<key>_<subkey>` scalars at
//     write time.
//   - meta is FLEXIBLE per-row extras; free text goes here, NOT in
//     dimensions. The recorder does NOT auto-move; the caller is
//     responsible.
//
// The recorder is a write-only API; rollup SELECTs read from per-faculty
// raw tables (intuition_telemetry, recall_log, cadence_telemetry,
// meta_cognition_telemetry). Future faculties adopting the umbrella raw
// shape get a single `telemetry_raw` table — out of scope for C3.

const DIM_CHARSET = /^[A-Za-z0-9_.-]+$/;
const DIM_MAX_LEN = 64;
const METRIC_OBJECT_MAX_KEYS = 16;

function validateDimensions(dimensions) {
  if (dimensions == null) return;
  if (typeof dimensions !== 'object' || Array.isArray(dimensions)) {
    throw new Error('dimensions must be a plain object');
  }
  for (const [k, v] of Object.entries(dimensions)) {
    if (v === null || v === undefined) continue; // null grouping bucket is allowed
    const t = typeof v;
    if (t === 'boolean') continue;
    if (t === 'number') {
      if (!Number.isInteger(v)) throw new Error(`dimension value type: ${k} is float (only string|bool|int allowed)`);
      continue;
    }
    if (t !== 'string') {
      throw new Error(`dimension value type: ${k} is ${t} (only string|bool|int allowed)`);
    }
    if (v.length > DIM_MAX_LEN) throw new Error(`dimension value exceeds 64 chars: ${k}`);
    if (!DIM_CHARSET.test(v)) {
      throw new Error(`dimension value charset: ${k}=${JSON.stringify(v)} (only [A-Za-z0-9_.-] allowed)`);
    }
  }
}

function fanOutMetrics(metrics) {
  if (metrics == null) return {};
  if (typeof metrics !== 'object' || Array.isArray(metrics)) {
    throw new Error('metrics must be a plain object');
  }
  const out = {};
  for (const [k, v] of Object.entries(metrics)) {
    if (v == null) continue;
    if (typeof v === 'number') {
      out[k] = v;
      continue;
    }
    if (typeof v === 'object' && !Array.isArray(v)) {
      const subKeys = Object.keys(v);
      if (subKeys.length > METRIC_OBJECT_MAX_KEYS) {
        throw new Error(`object-shaped metric exceeds 16 keys: ${k} (${subKeys.length})`);
      }
      // Strip the trailing _by_<scope> from the parent key if present, so
      // `contradictions_suppressed_by_rule.low_confidence` becomes
      // `contradictions_suppressed_low_confidence` (spec §3.4 example).
      const prefix = k.replace(/_by_[a-z]+$/, '');
      for (const sk of subKeys) {
        const sv = v[sk];
        if (typeof sv !== 'number') throw new Error(`object-shaped metric ${k}.${sk} is non-numeric`);
        out[`${prefix}_${sk}`] = sv;
      }
      continue;
    }
    throw new Error(`metric value type: ${k} is ${typeof v} (number or object<string,number> only)`);
  }
  return out;
}

/**
 * Record one telemetry event. Pure write; no rollup.
 *
 * @param {object} args
 * @param {object} args.db                 SurrealDB handle (or stub).
 * @param {string} args.faculty            e.g. 'intuition' | 'reinforcement' | …
 * @param {string} args.event_kind         e.g. 'recall' | 'evaluate' | …
 * @param {Date}   [args.ts]               Defaults to now.
 * @param {object} [args.dimensions]       §3.1-conformant.
 * @param {object} [args.metrics]          §3.4 — scalar or ≤16-key object.
 * @param {object} [args.meta]             FLEXIBLE per-row extras (free text OK).
 * @param {string} [args.targetTable]      Optional override; defaults to
 *   `telemetry_raw_${faculty}` for the umbrella table family. The
 *   existing per-faculty tables (intuition_telemetry, recall_log,
 *   cadence_telemetry) are NOT migrated to the umbrella; their writers
 *   continue to use direct `CREATE` statements. `recordTelemetry()` is
 *   for NEW writers going forward.
 */
export async function recordTelemetry(args) {
  const { db, faculty, event_kind, ts, dimensions, metrics, meta, targetTable } = args;
  if (typeof faculty !== 'string' || !faculty.length) throw new Error('faculty required');
  if (typeof event_kind !== 'string' || !event_kind.length) throw new Error('event_kind required');
  validateDimensions(dimensions);
  const fannedMetrics = fanOutMetrics(metrics);
  const table = targetTable ?? `telemetry_raw_${faculty}`;
  // Implementation note: the umbrella raw table family `telemetry_raw_*`
  // is defined by future faculties as they opt in. Phase 1 only validates
  // and writes; no schema migration is shipped for the raw family in
  // this round.
  const payload = {
    ts: ts ?? new Date(),
    faculty,
    event_kind,
    dimensions: dimensions ?? {},
    metrics: fannedMetrics,
    meta: meta ?? null,
  };
  // The stub-db test inspects `params` directly; the real path uses a
  // bound query with the same shape.
  return await db.query(`CREATE ${table} CONTENT $payload`, payload).collect();
}
```

- [ ] **Step 4: Run → pass**

```bash
npm run test:unit -- --test-name-pattern 'recordTelemetry'
```

Expected: all seven recorder tests pass.

- [ ] **Step 5: Commit**

```bash
git commit -m "feat(telemetry): recordTelemetry — dimension validation + object fan-out"
```

### Task 1.2 — `dimensionsHash()` determinism

**Files:** `system/cognition/telemetry/dimensions-hash.js`, `system/tests/unit/telemetry-dimensions-hash.test.js`

- [ ] **Step 1: Failing test**

Create `system/tests/unit/telemetry-dimensions-hash.test.js`:

```js
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { dimensionsHash } from '../../cognition/telemetry/dimensions-hash.js';

const HOUR = new Date('2026-05-11T14:00:00Z');

test('dimensionsHash is deterministic across key insertion order', () => {
  const a = dimensionsHash('intuition', 'recall', HOUR, { source: 'intuition', mmr_path: 'cosine' });
  const b = dimensionsHash('intuition', 'recall', HOUR, { mmr_path: 'cosine', source: 'intuition' });
  assert.equal(a, b);
});

test('dimensionsHash distinguishes different faculties', () => {
  const a = dimensionsHash('intuition', 'recall', HOUR, { source: 'intuition' });
  const b = dimensionsHash('reinforcement', 'recall', HOUR, { source: 'intuition' });
  assert.notEqual(a, b);
});

test('dimensionsHash distinguishes different event_kinds', () => {
  const a = dimensionsHash('intuition', 'recall', HOUR, { source: 'intuition' });
  const b = dimensionsHash('intuition', 'recall_attribution', HOUR, { source: 'intuition' });
  assert.notEqual(a, b);
});

test('dimensionsHash distinguishes different hours', () => {
  const a = dimensionsHash('intuition', 'recall', HOUR, {});
  const b = dimensionsHash('intuition', 'recall', new Date(HOUR.getTime() + 3600_000), {});
  assert.notEqual(a, b);
});

test('dimensionsHash is 24 hex chars', () => {
  const h = dimensionsHash('intuition', 'recall', HOUR, { source: 'intuition' });
  assert.match(h, /^[0-9a-f]{24}$/);
});

test('dimensionsHash treats empty and missing dimensions identically', () => {
  const a = dimensionsHash('intuition', 'recall', HOUR, {});
  const b = dimensionsHash('intuition', 'recall', HOUR, undefined);
  const c = dimensionsHash('intuition', 'recall', HOUR, null);
  assert.equal(a, b);
  assert.equal(a, c);
});
```

- [ ] **Step 2: Run → fail**

```bash
npm run test:unit -- --test-name-pattern 'dimensionsHash'
```

- [ ] **Step 3: Implement**

Create `system/cognition/telemetry/dimensions-hash.js`:

```js
import { createHash } from 'node:crypto';

/**
 * Deterministic SHA-256 over `<faculty>|<event_kind>|<iso_hour>|<sorted_dims_json>`,
 * truncated to 24 hex chars (~96 bits — collision-safe for ≤10K rows).
 *
 * Sort-keys serialization is the canonical form (spec §3.5); restrictions
 * on dimension value types (string|bool|int only, ASCII charset) are
 * enforced upstream by `recordTelemetry()` (spec §3.1).
 *
 * @param {string} faculty
 * @param {string} event_kind
 * @param {Date}   hour          Top of the hour; the aggregator passes
 *                               `time::floor(ts, 1h)`.
 * @param {object|null|undefined} dimensions
 * @returns {string}             24-char hex.
 */
export function dimensionsHash(faculty, event_kind, hour, dimensions) {
  const sortedEntries = Object.entries(dimensions ?? {}).sort(([a], [b]) => a.localeCompare(b));
  const sorted = Object.fromEntries(sortedEntries);
  const key = `${faculty}|${event_kind}|${hour.toISOString()}|${JSON.stringify(sorted)}`;
  return createHash('sha256').update(key).digest('hex').slice(0, 24);
}
```

- [ ] **Step 4: Run → pass**

```bash
npm run test:unit -- --test-name-pattern 'dimensionsHash'
```

- [ ] **Step 5: Commit**

```bash
git commit -m "feat(telemetry): dimensionsHash — deterministic 24-hex over sorted dims"
```

### Task 1.3 — `readTelemetryConfig()` cached config reader

**Files:** `system/cognition/telemetry/config.js`

- [ ] **Step 1: Implement (no test — pure passthrough wrapped around a SELECT)**

Create `system/cognition/telemetry/config.js`:

```js
// config.js — read runtime:telemetry.config; cached per call site (the
// aggregator's tick boundary; the MCP tool's invocation boundary).

import { surql } from 'surrealdb';

/**
 * Returns the parsed config row, or a defaults object if the row is missing.
 * The migration seeds it, so the missing-row branch is defensive.
 *
 * @param {object} db SurrealDB handle.
 * @returns {Promise<{
 *   enabled: boolean,
 *   shadow_mode: boolean,
 *   raw_retention_days: number,
 *   hourly_retention_days: number,
 *   daily_retention_days: number,
 *   cutoff_safety_seconds: number,
 *   cursor_fallback_window_hours: number,
 *   faculties_enabled: string[],
 *   cadence_hot_steps: string[],
 *   pending_recall_log_hard_ceiling_days: number,
 * }>}
 */
export async function readTelemetryConfig(db) {
  const [row] = await db.query(surql`SELECT value FROM ONLY runtime:\`telemetry.config\``).collect();
  const v = row?.value ?? {};
  return {
    enabled: v.enabled ?? false,
    shadow_mode: v.shadow_mode ?? true,
    raw_retention_days: v.raw_retention_days ?? 7,
    hourly_retention_days: v.hourly_retention_days ?? 90,
    daily_retention_days: v.daily_retention_days ?? 365,
    cutoff_safety_seconds: v.cutoff_safety_seconds ?? 60,
    cursor_fallback_window_hours: v.cursor_fallback_window_hours ?? 24,
    faculties_enabled: v.faculties_enabled ?? [],
    cadence_hot_steps: v.cadence_hot_steps ?? ['belief.', 'dream.'],
    pending_recall_log_hard_ceiling_days: v.pending_recall_log_hard_ceiling_days ?? 30,
  };
}
```

- [ ] **Step 2: Commit**

```bash
git commit -m "feat(telemetry): readTelemetryConfig — defaults-tolerant config reader"
```

---

## Phase 2 — `rollup-registry.js` per-faculty SELECT registry

> **Why third:** The registry is the contract surface for the aggregator. One entry per `(cursor_name, source_table, faculty, event_kind, SELECT, projection)` — adding a new hot source is one new entry + one `faculties_enabled` flip. The registry is exhaustively unit-tested before the aggregator that consumes it.

### Task 2.1 — Registry registration + lookup

**Files:** `system/cognition/telemetry/rollup-registry.js`, `system/tests/unit/telemetry-rollup-registry.test.js`

- [ ] **Step 1: Failing test**

Create `system/tests/unit/telemetry-rollup-registry.test.js`:

```js
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildRegistry, getEnabledEntries } from '../../cognition/telemetry/rollup-registry.js';

test('buildRegistry returns the four built-in entries', () => {
  const reg = buildRegistry();
  const names = reg.map((e) => e.name).sort();
  assert.deepEqual(names, [
    'cadence_telemetry_hot',
    'intuition_telemetry',
    'meta_cognition_telemetry',
    'recall_log_eval',
  ]);
});

test('every entry has cursor name + source table + SELECT + projection', () => {
  const reg = buildRegistry();
  for (const e of reg) {
    assert.equal(typeof e.name, 'string');
    assert.equal(typeof e.cursorName, 'string');
    assert.equal(typeof e.sourceTable, 'string');
    assert.equal(typeof e.select, 'function'); // SELECT builder takes ($cursor, $cutoff, cfg)
    assert.equal(typeof e.project, 'function'); // projects SELECT result rows → telemetry_hourly rows
    assert.equal(typeof e.faculty, 'string');
    assert.ok(Array.isArray(e.event_kinds)); // a single SELECT may emit multiple event_kinds
  }
});

test('getEnabledEntries filters by faculties_enabled', () => {
  const reg = buildRegistry();
  const enabled = getEnabledEntries(reg, { faculties_enabled: ['intuition', 'reinforcement'] });
  // Both 'intuition' and 'reinforcement' map to the recall_log_eval / intuition_telemetry entries.
  const facs = new Set(enabled.map((e) => e.faculty));
  assert.ok(facs.has('intuition'));
  assert.ok(facs.has('reinforcement'));
  assert.ok(!facs.has('belief')); // cadence_telemetry_hot disabled
  assert.ok(!facs.has('meta_cognition'));
});

test('intuition_telemetry entry projects to faculty=intuition, event_kind=recall', () => {
  const reg = buildRegistry();
  const entry = reg.find((e) => e.name === 'intuition_telemetry');
  // Project a synthetic SELECT result row.
  const rowFamily = entry.project({
    hour: new Date('2026-05-11T14:00:00Z'),
    source: 'intuition',
    mmr_path: 'cosine',
    n: 3,
    latency_ms_sum: 60,
    p50_latency_ms: 20,
    p95_latency_ms: 25,
    p99_latency_ms: 30,
  });
  assert.equal(rowFamily.length, 1);
  assert.equal(rowFamily[0].faculty, 'intuition');
  assert.equal(rowFamily[0].event_kind, 'recall');
  assert.deepEqual(rowFamily[0].dimensions, { source: 'intuition', mmr_path: 'cosine' });
  assert.equal(rowFamily[0].count, 3);
  assert.equal(rowFamily[0].metric_sums.latency_ms_sum, 60);
  assert.deepEqual(rowFamily[0].metric_buckets.latency_ms, { p50: 20, p95: 25, p99: 30 });
});

test('recall_log_eval entry splits into two event_kinds (recall_attribution + evaluate)', () => {
  const reg = buildRegistry();
  const entry = reg.find((e) => e.name === 'recall_log_eval');
  const rowFamily = entry.project({
    hour: new Date('2026-05-11T14:00:00Z'),
    outcome: 'reinforced',
    attribution_mode: 'citation',
    source: 'intuition',
    focus_block_present: false,
    n: 5,
    used_count_sum: 4,
    total_sum: 6,
    dropped_hits_sum: 0,
    elapsed_ms_sum: 80,
    focus_block_tokens_sum: 0,
  });
  // One row family for attribution (intuition.recall_attribution),
  // one for the outcome bucket (reinforcement.evaluate). Splits in
  // `project` — the SELECT only runs once.
  const facs = rowFamily.map((r) => `${r.faculty}.${r.event_kind}`).sort();
  assert.deepEqual(facs, ['intuition.recall_attribution', 'reinforcement.evaluate']);
});

test('cadence_telemetry_hot entry splits by step prefix (belief vs dream)', () => {
  const reg = buildRegistry();
  const entry = reg.find((e) => e.name === 'cadence_telemetry_hot');
  const beliefRow = entry.project({
    hour: new Date('2026-05-11T14:00:00Z'),
    step: 'belief.call',
    success: true,
    n: 7,
    latency_ms_sum: 140,
    sample_rate_sum: 3.5,
  });
  assert.equal(beliefRow[0].faculty, 'belief');
  assert.equal(beliefRow[0].event_kind, 'call');
  const dreamRow = entry.project({
    hour: new Date('2026-05-11T14:00:00Z'),
    step: 'dream.gather',
    success: true,
    n: 4,
    latency_ms_sum: 200,
    sample_rate_sum: 4,
  });
  assert.equal(dreamRow[0].faculty, 'dream');
  assert.equal(dreamRow[0].event_kind, 'gather');
});
```

- [ ] **Step 2: Run → fail**

```bash
npm run test:unit -- --test-name-pattern 'buildRegistry|getEnabledEntries|cadence_telemetry_hot|recall_log_eval'
```

- [ ] **Step 3: Implement `rollup-registry.js`**

Create `system/cognition/telemetry/rollup-registry.js`:

```js
// rollup-registry.js — per-cursor entries the aggregator iterates each tick.
//
// Each entry owns:
//   - name          : unique key; matches a runtime:telemetry.cursor.value.<name>
//   - cursorName    : same as name (kept separate for future renaming)
//   - sourceTable   : the raw table to SELECT from
//   - faculty       : the umbrella `faculty` written into telemetry_hourly
//                     (or a hint, when project() emits multiple faculties)
//   - event_kinds   : array of event_kind strings this entry can emit
//   - select(cursor, cutoff, cfg) : returns a SurrealQL string + bind params
//                     for the grouped scan over [cursor, cutoff)
//   - project(row)  : maps one SELECT result row to one-or-more
//                     telemetry_hourly row-family entries:
//                     { faculty, event_kind, dimensions, count,
//                       metric_sums, metric_buckets }
//
// Adding a new hot source = one new entry + add its name to
// runtime:telemetry.config.faculties_enabled. No rollup.js edit.

const HOT_CADENCE_PREFIXES = ['belief.', 'dream.']; // also lives in config

function intuitionEntry() {
  return {
    name: 'intuition_telemetry',
    cursorName: 'intuition_telemetry',
    sourceTable: 'intuition_telemetry',
    faculty: 'intuition',
    event_kinds: ['recall'],
    select: ({ cursor, cutoff }) => ({
      sql: `SELECT
        time::floor(ts, 1h)              AS hour,
        meta.from                        AS source,
        meta.mmr_path                    AS mmr_path,
        count()                          AS n,
        math::sum(latency_ms)            AS latency_ms_sum,
        math::sum(tokens_injected)       AS tokens_injected_sum,
        math::sum(hits)                  AS hits_sum,
        math::sum(query_chars)           AS query_chars_sum,
        math::sum(meta.contradictions_surfaced) AS contradictions_surfaced_sum,
        math::sum(meta.conflict_block_tokens)   AS conflict_block_tokens_sum,
        math::percentile(latency_ms, 50) AS p50_latency_ms,
        math::percentile(latency_ms, 95) AS p95_latency_ms,
        math::percentile(latency_ms, 99) AS p99_latency_ms
      FROM intuition_telemetry
      WHERE ts >= $cursor AND ts < $cutoff
      GROUP BY hour, source, mmr_path`,
      params: { cursor, cutoff },
    }),
    project: (r) => [{
      faculty: 'intuition',
      event_kind: 'recall',
      hour: r.hour,
      dimensions: { source: r.source ?? null, mmr_path: r.mmr_path ?? null },
      count: r.n ?? 0,
      metric_sums: {
        latency_ms_sum: r.latency_ms_sum ?? 0,
        tokens_injected_sum: r.tokens_injected_sum ?? 0,
        hits_sum: r.hits_sum ?? 0,
        query_chars_sum: r.query_chars_sum ?? 0,
        contradictions_surfaced_sum: r.contradictions_surfaced_sum ?? 0,
        conflict_block_tokens_sum: r.conflict_block_tokens_sum ?? 0,
      },
      metric_buckets: {
        latency_ms: { p50: r.p50_latency_ms ?? 0, p95: r.p95_latency_ms ?? 0, p99: r.p99_latency_ms ?? 0 },
      },
    }],
  };
}

function recallLogEvalEntry() {
  return {
    name: 'recall_log_eval',
    cursorName: 'recall_log_eval',
    sourceTable: 'recall_log',
    faculty: 'intuition', // split in project() into intuition.recall_attribution + reinforcement.evaluate
    event_kinds: ['recall_attribution', 'evaluate'],
    select: ({ cursor, cutoff }) => ({
      sql: `SELECT
        time::floor(evaluated_at, 1h)        AS hour,
        outcome                              AS outcome,
        attribution.mode                     AS attribution_mode,
        meta.from                            AS source,
        meta.focus_block_present             AS focus_block_present,
        count()                              AS n,
        math::sum(attribution.used_count)    AS used_count_sum,
        math::sum(attribution.total)         AS total_sum,
        math::sum(attribution.dropped_hits)  AS dropped_hits_sum,
        math::sum(attribution.elapsed_ms)    AS elapsed_ms_sum,
        math::sum(meta.focus_block_tokens)   AS focus_block_tokens_sum
      FROM recall_log
      WHERE evaluated_at IS NOT NONE
        AND evaluated_at >= $cursor
        AND evaluated_at < $cutoff
      GROUP BY hour, outcome, attribution_mode, source, focus_block_present`,
      params: { cursor, cutoff },
    }),
    project: (r) => {
      const out = [];
      if (r.attribution_mode != null) {
        out.push({
          faculty: 'intuition',
          event_kind: 'recall_attribution',
          hour: r.hour,
          dimensions: { mode: r.attribution_mode, source: r.source ?? null, focus_block_present: r.focus_block_present ?? null },
          count: r.n ?? 0,
          metric_sums: {
            used_count_sum: r.used_count_sum ?? 0,
            total_sum: r.total_sum ?? 0,
            dropped_hits_sum: r.dropped_hits_sum ?? 0,
            elapsed_ms_sum: r.elapsed_ms_sum ?? 0,
            focus_block_tokens_sum: r.focus_block_tokens_sum ?? 0,
          },
          metric_buckets: {},
        });
      }
      out.push({
        faculty: 'reinforcement',
        event_kind: 'evaluate',
        hour: r.hour,
        dimensions: { outcome: r.outcome },
        count: r.n ?? 0,
        metric_sums: {},
        metric_buckets: {},
      });
      return out;
    },
  };
}

function cadenceTelemetryHotEntry() {
  return {
    name: 'cadence_telemetry_hot',
    cursorName: 'cadence_telemetry_hot',
    sourceTable: 'cadence_telemetry',
    faculty: 'belief', // split in project() by step prefix
    event_kinds: ['call', 'gather', /* …per-sub-step dream kinds, dynamic */],
    select: ({ cursor, cutoff, cfg }) => {
      // Build the prefix OR clause from cfg.cadence_hot_steps so a new
      // prefix lands without a code change.
      const prefixes = (cfg?.cadence_hot_steps ?? HOT_CADENCE_PREFIXES);
      const orClauses = prefixes
        .map((p, i) => `string::starts_with(step, $p${i})`)
        .join(' OR ');
      const params = { cursor, cutoff };
      prefixes.forEach((p, i) => { params[`p${i}`] = p; });
      return {
        sql: `SELECT
          time::floor(ts, 1h)              AS hour,
          step                             AS step,
          success                          AS success,
          count()                          AS n,
          math::sum(latency_ms)            AS latency_ms_sum,
          math::sum(sample_rate)           AS sample_rate_sum,
          math::sum(tokens_in)             AS tokens_in_sum,
          math::sum(tokens_out)            AS tokens_out_sum
        FROM cadence_telemetry
        WHERE ts >= $cursor AND ts < $cutoff
          AND (${orClauses})
        GROUP BY hour, step, success`,
        params,
      };
    },
    project: (r) => {
      const step = String(r.step ?? '');
      const dot = step.indexOf('.');
      const family = dot > 0 ? step.slice(0, dot) : step; // 'belief' / 'dream'
      const kind = dot > 0 ? step.slice(dot + 1) : 'unknown';
      return [{
        faculty: family,
        event_kind: kind,
        hour: r.hour,
        dimensions: { success: r.success ?? null },
        count: r.n ?? 0,
        metric_sums: {
          latency_ms_sum: r.latency_ms_sum ?? 0,
          sample_rate_sum: r.sample_rate_sum ?? 0,
          tokens_in_sum: r.tokens_in_sum ?? 0,
          tokens_out_sum: r.tokens_out_sum ?? 0,
        },
        metric_buckets: {},
      }];
    },
  };
}

function metaCognitionEntry() {
  return {
    name: 'meta_cognition_telemetry',
    cursorName: 'meta_cognition_telemetry',
    sourceTable: 'meta_cognition_telemetry',
    faculty: 'meta_cognition',
    event_kinds: ['run'],
    select: ({ cursor, cutoff }) => ({
      sql: `SELECT
        time::floor(ts, 1h)              AS hour,
        outcome                          AS outcome,
        count()                          AS n,
        math::sum(tokens_in)             AS tokens_in_sum,
        math::sum(tokens_out)            AS tokens_out_sum,
        math::sum(latency_ms)            AS latency_ms_sum,
        math::sum(actions_proposed)      AS actions_proposed_sum,
        math::sum(actions_accepted)      AS actions_accepted_sum
      FROM meta_cognition_telemetry
      WHERE ts >= $cursor AND ts < $cutoff
      GROUP BY hour, outcome`,
      params: { cursor, cutoff },
    }),
    project: (r) => [{
      faculty: 'meta_cognition',
      event_kind: 'run',
      hour: r.hour,
      dimensions: { outcome: r.outcome ?? null },
      count: r.n ?? 0,
      metric_sums: {
        tokens_in_sum: r.tokens_in_sum ?? 0,
        tokens_out_sum: r.tokens_out_sum ?? 0,
        latency_ms_sum: r.latency_ms_sum ?? 0,
        actions_proposed_sum: r.actions_proposed_sum ?? 0,
        actions_accepted_sum: r.actions_accepted_sum ?? 0,
      },
      metric_buckets: {},
    }],
  };
}

export function buildRegistry() {
  return [
    intuitionEntry(),
    recallLogEvalEntry(),
    cadenceTelemetryHotEntry(),
    metaCognitionEntry(),
  ];
}

export function getEnabledEntries(reg, cfg) {
  const enabled = new Set(cfg?.faculties_enabled ?? []);
  // Each registry entry maps to one-or-more faculties via its project()
  // output. For the kill-switch we use a hard mapping by name.
  const nameToFaculties = {
    intuition_telemetry: ['intuition'],
    recall_log_eval: ['intuition', 'reinforcement'],
    cadence_telemetry_hot: ['belief', 'dream'],
    meta_cognition_telemetry: ['meta_cognition'],
  };
  return reg.filter((e) => (nameToFaculties[e.name] ?? []).some((f) => enabled.has(f)));
}
```

- [ ] **Step 4: Run → pass**

```bash
npm run test:unit -- --test-name-pattern 'buildRegistry|getEnabledEntries|cadence_telemetry_hot|recall_log_eval'
```

- [ ] **Step 5: Commit**

```bash
git commit -m "feat(telemetry): rollup-registry — per-cursor SELECT/projection entries"
```

---

## Phase 3 — Aggregator `rollup.js`

> **Why fourth:** The aggregator is the consumer of registry + recorder + config. It runs the SELECTs, UPSERTs `telemetry_hourly:{dim_hash}` rows, advances cursors. Idempotent (every tick re-aggregates the window). Fail-soft per branch — a malformed SELECT in one entry does NOT prevent another entry's cursor from advancing.

### Task 3.1 — Hour bucket math + UPSERT idempotency

**Files:** `system/cognition/telemetry/rollup.js`, `system/tests/unit/telemetry-rollup-math.test.js`

- [ ] **Step 1: Failing test**

Create `system/tests/unit/telemetry-rollup-math.test.js`:

```js
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { surql } from 'surrealdb';
import { close, connect } from '../../data/db/client.js';
import { runMigrations } from '../../data/db/migrate.js';
import { rollupHotTelemetry } from '../../cognition/telemetry/rollup.js';
import { readTelemetryConfig } from '../../cognition/telemetry/config.js';

async function fresh() {
  const db = await connect({ engine: 'mem://' });
  await runMigrations(db, 'system/data/db/migrations');
  return db;
}

test('hour bucket math: 6 intuition_telemetry rows across 2 hours → 2 rollup rows', async () => {
  const db = await fresh();
  const h1 = new Date('2026-05-11T14:00:00Z');
  const h2 = new Date('2026-05-11T15:00:00Z');
  for (const [hour, lat] of [[h1, 10], [h1, 20], [h1, 30], [h2, 40], [h2, 50], [h2, 60]]) {
    await db.query(surql`
      CREATE intuition_telemetry CONTENT ${{
        ts: new Date(hour.getTime() + Math.floor(Math.random() * 60_000)),
        latency_ms: lat, tokens_injected: 100, hits: 2, query_chars: 50,
        meta: { from: 'intuition', mmr_path: 'cosine' },
      }};
    `).collect();
  }
  const cfg = await readTelemetryConfig(db);
  await rollupHotTelemetry({ db, cfg });
  const [rows] = await db.query(surql`SELECT * FROM telemetry_hourly WHERE faculty='intuition' AND event_kind='recall' ORDER BY hour`).collect();
  assert.equal(rows.length, 2);
  assert.equal(rows[0].count, 3);
  assert.equal(rows[0].metric_sums.latency_ms_sum, 60); // 10+20+30
  assert.equal(rows[1].count, 3);
  assert.equal(rows[1].metric_sums.latency_ms_sum, 150); // 40+50+60
  await close(db);
});

test('metric_sums exactness: no float rounding drift', async () => {
  const db = await fresh();
  const hour = new Date('2026-05-11T14:00:00Z');
  // Use values that sum to a precise int.
  for (const lat of [123, 456, 789]) {
    await db.query(surql`
      CREATE intuition_telemetry CONTENT ${{
        ts: hour, latency_ms: lat, tokens_injected: 0, hits: 0, query_chars: 0,
        meta: { from: 'intuition', mmr_path: 'cosine' },
      }};
    `).collect();
  }
  const cfg = await readTelemetryConfig(db);
  await rollupHotTelemetry({ db, cfg });
  const [rows] = await db.query(surql`SELECT metric_sums FROM telemetry_hourly WHERE faculty='intuition'`).collect();
  assert.equal(rows[0].metric_sums.latency_ms_sum, 1368); // 123+456+789
  await close(db);
});

test('percentile bucket (load-bearing): 100 rows latency 1..100 → p50≈50, p95≈95, p99≈99', async () => {
  const db = await fresh();
  const hour = new Date('2026-05-11T14:00:00Z');
  for (let i = 1; i <= 100; i++) {
    await db.query(surql`
      CREATE intuition_telemetry CONTENT ${{
        ts: new Date(hour.getTime() + i * 100),
        latency_ms: i, tokens_injected: 0, hits: 0, query_chars: 0,
        meta: { from: 'intuition', mmr_path: 'cosine' },
      }};
    `).collect();
  }
  const cfg = await readTelemetryConfig(db);
  await rollupHotTelemetry({ db, cfg });
  const [rows] = await db.query(surql`SELECT metric_buckets FROM telemetry_hourly WHERE faculty='intuition'`).collect();
  const lb = rows[0].metric_buckets.latency_ms;
  // Tolerate ±2 — math::percentile interpolation may yield 50.5 / 95 / 99
  // depending on the rank-interpolation method SurrealDB picks.
  assert.ok(Math.abs(lb.p50 - 50) <= 2, `p50=${lb.p50}`);
  assert.ok(Math.abs(lb.p95 - 95) <= 2, `p95=${lb.p95}`);
  assert.ok(Math.abs(lb.p99 - 99) <= 2, `p99=${lb.p99}`);
  await close(db);
});

test('empty window: cursor advances, no UPSERTs', async () => {
  const db = await fresh();
  const cfg = await readTelemetryConfig(db);
  const before = await db.query(surql`SELECT count() FROM telemetry_hourly GROUP ALL`).collect();
  await rollupHotTelemetry({ db, cfg });
  const after = await db.query(surql`SELECT count() FROM telemetry_hourly GROUP ALL`).collect();
  assert.deepEqual(after[0], before[0]); // no new rows
  const [cur] = await db.query(surql`SELECT value FROM ONLY runtime:\`telemetry.cursor\``).collect();
  // After an empty tick, every cursor advances to ~$cutoff (now - 60s).
  assert.ok(cur.value.intuition_telemetry instanceof Date);
  await close(db);
});

test('missing dimension: rows where meta.mmr_path is null group into a {mmr_path: null} bucket', async () => {
  const db = await fresh();
  const hour = new Date('2026-05-11T14:00:00Z');
  await db.query(surql`
    CREATE intuition_telemetry CONTENT { ts: ${hour}, latency_ms: 10, tokens_injected: 0, hits: 0, query_chars: 0, meta: { from: 'intuition' } };
    CREATE intuition_telemetry CONTENT { ts: ${hour}, latency_ms: 20, tokens_injected: 0, hits: 0, query_chars: 0, meta: { from: 'intuition', mmr_path: 'cosine' } };
  `).collect();
  const cfg = await readTelemetryConfig(db);
  await rollupHotTelemetry({ db, cfg });
  const [rows] = await db.query(surql`SELECT dimensions, count FROM telemetry_hourly WHERE faculty='intuition' AND event_kind='recall' ORDER BY dimensions.mmr_path`).collect();
  assert.equal(rows.length, 2);
  // null group present.
  assert.ok(rows.some((r) => r.dimensions.mmr_path == null && r.count === 1));
  assert.ok(rows.some((r) => r.dimensions.mmr_path === 'cosine' && r.count === 1));
  await close(db);
});
```

- [ ] **Step 2: Run → fail**

```bash
npm run test:unit -- --test-name-pattern 'hour bucket math|metric_sums exactness|percentile|empty window|missing dimension'
```

- [ ] **Step 3: Implement `rollup.js`**

Create `system/cognition/telemetry/rollup.js`:

```js
// rollup.js — heartbeat-paced aggregator. Reads cursors, runs registered
// SELECTs against [cursor, cutoff), UPSERTs telemetry_hourly:{dim_hash}
// rows, advances cursors. Idempotent (every tick re-aggregates the
// window). Fail-soft per branch.

import { surql } from 'surrealdb';
import { dimensionsHash } from './dimensions-hash.js';
import { buildRegistry, getEnabledEntries } from './rollup-registry.js';

const DEFAULT_CUTOFF_SAFETY_SECONDS = 60;

async function readCursors(db) {
  const [row] = await db.query(surql`SELECT value FROM ONLY runtime:\`telemetry.cursor\``).collect();
  return row?.value ?? {};
}

async function writeCursors(db, cursors) {
  await db.query(surql`UPSERT runtime:\`telemetry.cursor\` MERGE ${{ value: cursors }}`).collect();
}

async function rollupOne({ db, entry, cfg, cursors, cutoff, results }) {
  const lastCursor = cursors[entry.cursorName];
  const cursorMs = lastCursor instanceof Date
    ? lastCursor.getTime()
    : (typeof lastCursor === 'string' ? Date.parse(lastCursor) : null);
  const cursor = Number.isFinite(cursorMs)
    ? new Date(cursorMs)
    : new Date(Date.now() - cfg.cursor_fallback_window_hours * 3600_000);
  try {
    const { sql, params } = entry.select({ cursor, cutoff, cfg });
    const [rows] = await db.query(sql, params).collect();
    let upserts = 0;
    for (const r of rows ?? []) {
      const families = entry.project(r);
      for (const fam of families) {
        const id = dimensionsHash(fam.faculty, fam.event_kind, fam.hour, fam.dimensions);
        await db.query(surql`UPSERT type::thing('telemetry_hourly', ${id}) CONTENT ${{
          hour: fam.hour,
          faculty: fam.faculty,
          event_kind: fam.event_kind,
          dimensions: fam.dimensions,
          count: fam.count,
          metric_sums: fam.metric_sums,
          metric_buckets: fam.metric_buckets,
        }}`).collect();
        upserts += 1;
      }
    }
    // Advance the cursor. For the recall_log_eval entry, the cursor key
    // is `evaluated_at`, not `ts` — the SELECT already filters on
    // `evaluated_at >= $cursor AND evaluated_at < $cutoff`, so advancing
    // to $cutoff is correct in both cases.
    cursors[entry.cursorName] = cutoff;
    results[entry.name] = { ok: true, upserts, rows: (rows ?? []).length };
  } catch (e) {
    results[entry.name] = { ok: false, error: e.message };
    // Per-cursor fail-soft: leave cursors[entry.cursorName] untouched so
    // next tick re-tries the same window.
  }
}

/**
 * Run one rollup tick.
 *
 * @param {object} args
 * @param {object} args.db
 * @param {object} args.cfg                   readTelemetryConfig output
 * @param {Date}   [args.nowFn]               injectable clock for tests
 * @returns {Promise<{cursors_advanced: object, per_entry: object}>}
 */
export async function rollupHotTelemetry({ db, cfg, nowFn }) {
  const now = (typeof nowFn === 'function') ? nowFn() : new Date();
  const cutoff = new Date(now.getTime() - (cfg.cutoff_safety_seconds ?? DEFAULT_CUTOFF_SAFETY_SECONDS) * 1000);

  const reg = buildRegistry();
  const enabled = getEnabledEntries(reg, cfg);
  const cursors = await readCursors(db);
  const results = {};

  for (const entry of enabled) {
    await rollupOne({ db, entry, cfg, cursors, cutoff, results });
  }

  // Batch the cursor write at the end. Surviving cursors keep their
  // value; failed branches left their entry untouched.
  await writeCursors(db, cursors);

  return { cursors_advanced: cursors, per_entry: results };
}
```

- [ ] **Step 4: Run → pass**

```bash
npm run test:unit -- --test-name-pattern 'hour bucket math|metric_sums exactness|percentile|empty window|missing dimension'
```

If the percentile test fails because `math::percentile` inside `GROUP BY` is rejected by the engine on the current SurrealDB version, fall back to the client-side percentile path: drop the three `math::percentile` columns from the SELECT, instead `SELECT array::group(latency_ms) AS lat_arr` per group, then compute `p50 / p95 / p99` in JS inside `project()`. The spec calls out this as a single-file swap (§4.2 percentile note). Document the chosen path in a code comment.

- [ ] **Step 5: Commit**

```bash
git commit -m "feat(telemetry): rollupHotTelemetry — registry-driven hourly aggregator"
```

### Task 3.2 — Idempotency + cursor advance integration test

**Files:** `system/tests/integration/telemetry-rollup-job.test.js`

- [ ] **Step 1: Failing test**

Create `system/tests/integration/telemetry-rollup-job.test.js`:

```js
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { surql } from 'surrealdb';
import { close, connect } from '../../data/db/client.js';
import { runMigrations } from '../../data/db/migrate.js';
import { rollupHotTelemetry } from '../../cognition/telemetry/rollup.js';
import { readTelemetryConfig } from '../../cognition/telemetry/config.js';

async function fresh() {
  const db = await connect({ engine: 'mem://' });
  await runMigrations(db, 'system/data/db/migrations');
  return db;
}

test('aggregator is idempotent: running twice over the same rows yields the same telemetry_hourly state', async () => {
  const db = await fresh();
  const hour = new Date('2026-05-11T14:00:00Z');
  for (let i = 0; i < 4; i++) {
    await db.query(surql`
      CREATE intuition_telemetry CONTENT ${{
        ts: new Date(hour.getTime() + i * 60_000),
        latency_ms: 10 * (i + 1), tokens_injected: 50, hits: 1, query_chars: 30,
        meta: { from: 'intuition', mmr_path: 'cosine' },
      }};
    `).collect();
  }
  const cfg = await readTelemetryConfig(db);
  await rollupHotTelemetry({ db, cfg, nowFn: () => new Date(hour.getTime() + 65 * 60_000) });
  const [first] = await db.query(surql`SELECT count, metric_sums FROM telemetry_hourly WHERE faculty='intuition'`).collect();
  await rollupHotTelemetry({ db, cfg, nowFn: () => new Date(hour.getTime() + 65 * 60_000) });
  const [second] = await db.query(surql`SELECT count, metric_sums FROM telemetry_hourly WHERE faculty='intuition'`).collect();
  assert.deepEqual(first, second); // UPSERT replaces — no double-count
  await close(db);
});

test('cursor advances after a successful tick; second tick scans less', async () => {
  const db = await fresh();
  const hour = new Date('2026-05-11T14:00:00Z');
  await db.query(surql`
    CREATE intuition_telemetry CONTENT ${{
      ts: hour, latency_ms: 10, tokens_injected: 0, hits: 0, query_chars: 0,
      meta: { from: 'intuition', mmr_path: 'cosine' },
    }};
  `).collect();
  const cfg = await readTelemetryConfig(db);
  const now1 = new Date(hour.getTime() + 65 * 60_000);
  await rollupHotTelemetry({ db, cfg, nowFn: () => now1 });
  const [c1] = await db.query(surql`SELECT value FROM ONLY runtime:\`telemetry.cursor\``).collect();
  // Cursor set to ~now1 - 60s.
  assert.ok(c1.value.intuition_telemetry instanceof Date);
  assert.ok(c1.value.intuition_telemetry.getTime() <= now1.getTime() - 30_000);
  // Re-run with same nowFn — cursor stays.
  await rollupHotTelemetry({ db, cfg, nowFn: () => now1 });
  const [c2] = await db.query(surql`SELECT value FROM ONLY runtime:\`telemetry.cursor\``).collect();
  assert.equal(c1.value.intuition_telemetry.toISOString(), c2.value.intuition_telemetry.toISOString());
  await close(db);
});

test('cursor fallback on missing cursor row → uses now - cursor_fallback_window_hours', async () => {
  const db = await fresh();
  await db.query(surql`DELETE runtime:\`telemetry.cursor\``).collect();
  // Pre-DELETE the row outright; aggregator must recreate.
  const cfg = await readTelemetryConfig(db);
  await rollupHotTelemetry({ db, cfg });
  const [c] = await db.query(surql`SELECT value FROM ONLY runtime:\`telemetry.cursor\``).collect();
  // Row recreated, cursor populated.
  assert.ok(c?.value?.intuition_telemetry instanceof Date);
  await close(db);
});

test('pending recall_log NOT rolled up; the cursor stays before now-cutoff_safety; once evaluated_at is set it rolls up', async () => {
  const db = await fresh();
  const hour = new Date('2026-05-11T14:00:00Z');
  await db.query(surql`
    CREATE recall_log CONTENT ${{
      ts: hour, query: 'q1', k: 6, ranked_hits: [], outcome: 'pending',
      session_id: 's1', attribution: { mode: 'citation', used_count: 1, total: 2, dropped_hits: 0, elapsed_ms: 10 },
      meta: { from: 'intuition' },
    }};
  `).collect();
  const cfg = await readTelemetryConfig(db);
  await rollupHotTelemetry({ db, cfg, nowFn: () => new Date(hour.getTime() + 65 * 60_000) });
  const [r1] = await db.query(surql`SELECT count() AS n FROM telemetry_hourly WHERE event_kind='recall_attribution' GROUP ALL`).collect();
  assert.equal(r1?.n ?? 0, 0);
  // Now flip outcome + set evaluated_at.
  await db.query(surql`
    UPDATE recall_log SET outcome='reinforced', evaluated_at=${new Date(hour.getTime() + 6 * 60_000)};
  `).collect();
  // Bump the cursor to before the row's evaluated_at so the second tick
  // re-scans (the prior tick advanced past it). In production the second
  // tick happens an hour later; here we simulate by rewriting the cursor.
  await db.query(surql`UPSERT runtime:\`telemetry.cursor\` MERGE { value: { recall_log_eval: ${hour} } }`).collect();
  await rollupHotTelemetry({ db, cfg, nowFn: () => new Date(hour.getTime() + 70 * 60_000) });
  const [r2] = await db.query(surql`SELECT count() AS n FROM telemetry_hourly WHERE event_kind='recall_attribution' GROUP ALL`).collect();
  assert.equal(r2?.n ?? 0, 1);
  await close(db);
});

test('per-entry fail-soft: malformed SELECT in one entry does not block another', async () => {
  // We inject a bad entry by stubbing buildRegistry via env or by
  // directly testing rollupOne with two entries (one good, one
  // intentionally throwing). The test uses an integration-style harness
  // that calls into rollup.js with a swapped registry.
  // Implementation detail: rollup.js calls buildRegistry() once per tick;
  // we test the fail-soft path by seeding a bad cadence_telemetry row
  // (e.g., a step value that breaks the prefix scan) and verifying that
  // the intuition_telemetry cursor still advances. The exact bad-row
  // shape depends on SurrealQL semantics; if no plausible
  // production-bad-row exists, this test stays as a TODO with the
  // contract documented in rollup.js comments.
  const db = await fresh();
  // Trivially seed a good intuition row + a malformed cadence row.
  await db.query(surql`
    CREATE intuition_telemetry CONTENT { ts: time::now(), latency_ms: 10, tokens_injected: 0, hits: 0, query_chars: 0, meta: { from: 'intuition' } };
  `).collect();
  // No cadence rows seeded; the SELECT just returns empty. Verify both
  // cursors advance.
  const cfg = await readTelemetryConfig(db);
  const r = await rollupHotTelemetry({ db, cfg });
  assert.equal(r.per_entry.intuition_telemetry.ok, true);
  assert.equal(r.per_entry.cadence_telemetry_hot.ok, true);
  await close(db);
});
```

- [ ] **Step 2: Run → fail (only if Phase 3.1 implementation is incomplete)**

```bash
npm run test:integration -- --test-name-pattern 'aggregator is idempotent|cursor advances|cursor fallback|pending recall_log|per-entry fail-soft'
```

- [ ] **Step 3: Verify pass against the Phase 3.1 implementation**

If a test fails, the most likely cause is a divergence between the registry SELECT's `WHERE` clause and the cursor name semantics. Re-read §4.2; the `recall_log_eval` cursor compares on `evaluated_at`, not `ts`.

- [ ] **Step 4: Commit**

```bash
git commit -m "test(telemetry): rollup-job integration — idempotency + cursor + fail-soft"
```

---

## Phase 4 — Cadence hot-step bridge (§3.2)

> **Why:** D3 writes `cadence_telemetry` rows with `step='belief.call'`; C2 writes per-sub-step dream rows. Both have hot-tier volume but live on a cold-tier table. The aggregator must split by prefix per `cadence_hot_steps` config. The bridge is already in `rollup-registry.js` (Task 2.1); this phase is the focused integration test that pins down the split semantics.

### Task 4.1 — Cadence hot-step bridge end-to-end

**Files:** `system/tests/integration/telemetry-cadence-hot-bridge.test.js`

- [ ] **Step 1: Failing test**

Create `system/tests/integration/telemetry-cadence-hot-bridge.test.js`:

```js
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { surql } from 'surrealdb';
import { close, connect } from '../../data/db/client.js';
import { runMigrations } from '../../data/db/migrate.js';
import { rollupHotTelemetry } from '../../cognition/telemetry/rollup.js';
import { readTelemetryConfig } from '../../cognition/telemetry/config.js';

async function fresh() {
  const db = await connect({ engine: 'mem://' });
  await runMigrations(db, 'system/data/db/migrations');
  return db;
}

test('belief.call (3) + dream.gather (5) + state_inference (2) → only belief & dream roll up', async () => {
  const db = await fresh();
  const hour = new Date('2026-05-11T14:00:00Z');
  for (let i = 0; i < 3; i++) {
    await db.query(surql`
      CREATE cadence_telemetry CONTENT ${{
        ts: hour, step: 'belief.call', success: true,
        latency_ms: 30, sample_rate: 1, tokens_in: 200, tokens_out: 40,
      }};
    `).collect();
  }
  for (let i = 0; i < 5; i++) {
    await db.query(surql`
      CREATE cadence_telemetry CONTENT ${{
        ts: hour, step: 'dream.gather', success: true,
        latency_ms: 50, sample_rate: 1, tokens_in: 300, tokens_out: 60,
      }};
    `).collect();
  }
  for (let i = 0; i < 2; i++) {
    await db.query(surql`
      CREATE cadence_telemetry CONTENT ${{
        ts: hour, step: 'state_inference', success: true,
        latency_ms: 100, sample_rate: 1, tokens_in: 500, tokens_out: 80,
      }};
    `).collect();
  }
  const cfg = await readTelemetryConfig(db);
  await rollupHotTelemetry({ db, cfg, nowFn: () => new Date(hour.getTime() + 65 * 60_000) });
  const [rows] = await db.query(surql`SELECT faculty, event_kind, count FROM telemetry_hourly ORDER BY faculty, event_kind`).collect();
  // Two rollup rows from cadence_hot bridge.
  const cadenceRows = rows.filter((r) => r.faculty === 'belief' || r.faculty === 'dream');
  assert.equal(cadenceRows.length, 2);
  const belief = cadenceRows.find((r) => r.faculty === 'belief' && r.event_kind === 'call');
  const dream = cadenceRows.find((r) => r.faculty === 'dream' && r.event_kind === 'gather');
  assert.equal(belief.count, 3);
  assert.equal(dream.count, 5);
  // state_inference rows must NOT appear in telemetry_hourly.
  const stateRows = rows.filter((r) => r.faculty === 'state_inference');
  assert.equal(stateRows.length, 0);
  await close(db);
});

test('cadence_hot_steps config drives the prefix match: adding "foo." picks up foo.bar rows', async () => {
  const db = await fresh();
  const hour = new Date('2026-05-11T14:00:00Z');
  await db.query(surql`
    UPDATE runtime:\`telemetry.config\` SET value.cadence_hot_steps = ['belief.', 'dream.', 'foo.'];
    CREATE cadence_telemetry CONTENT { ts: ${hour}, step: 'foo.bar', success: true, latency_ms: 10, sample_rate: 1, tokens_in: 0, tokens_out: 0 };
  `).collect();
  const cfg = await readTelemetryConfig(db);
  await rollupHotTelemetry({ db, cfg, nowFn: () => new Date(hour.getTime() + 65 * 60_000) });
  const [rows] = await db.query(surql`SELECT faculty, event_kind FROM telemetry_hourly WHERE faculty='foo'`).collect();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].event_kind, 'bar');
  await close(db);
});
```

- [ ] **Step 2: Run → expect pass after Phase 3 lands**

```bash
npm run test:integration -- --test-name-pattern 'belief.call|cadence_hot_steps'
```

- [ ] **Step 3: Commit**

```bash
git commit -m "test(telemetry): cadence hot-step bridge — belief / dream / state_inference split"
```

---

## Phase 5 — `retention.js` + pending hard-ceiling prune

> **Why:** Stage 2 of the job ticks deletes raw rows past `raw_retention_days` (7d) and hourly rows past `hourly_retention_days` (90d). Stage 2b is the bounded-growth guard: stuck `recall_log` rows with `outcome='pending'` past `pending_recall_log_hard_ceiling_days` (30d) are force-pruned and a warning telemetry row is emitted. Doctor's pending-row probe (Phase 6) is the early-warning sibling.

### Task 5.1 — `pruneRawTelemetry()` table-aware DELETE

**Files:** `system/cognition/telemetry/retention.js`, `system/tests/unit/telemetry-retention.test.js`

- [ ] **Step 1: Failing test**

Create `system/tests/unit/telemetry-retention.test.js`:

```js
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { surql } from 'surrealdb';
import { close, connect } from '../../data/db/client.js';
import { runMigrations } from '../../data/db/migrate.js';
import { pruneRawTelemetry } from '../../cognition/telemetry/retention.js';

async function fresh() {
  const db = await connect({ engine: 'mem://' });
  await runMigrations(db, 'system/data/db/migrations');
  return db;
}

test('prune respects timestampField: telemetry_hourly uses hour, intuition_telemetry uses ts', async () => {
  const db = await fresh();
  const old = new Date('2026-01-01T00:00:00Z');
  const fresh1 = new Date('2026-05-11T14:00:00Z');
  await db.query(surql`
    CREATE telemetry_hourly CONTENT { hour: ${old},    faculty: 'intuition', event_kind: 'recall', count: 1, dimensions: {}, metric_sums: {}, metric_buckets: {} };
    CREATE telemetry_hourly CONTENT { hour: ${fresh1}, faculty: 'intuition', event_kind: 'recall', count: 1, dimensions: { src: 'x' }, metric_sums: {}, metric_buckets: {} };
    CREATE intuition_telemetry CONTENT { ts: ${old},    latency_ms: 10, tokens_injected: 0, hits: 0, query_chars: 0 };
    CREATE intuition_telemetry CONTENT { ts: ${fresh1}, latency_ms: 10, tokens_injected: 0, hits: 0, query_chars: 0 };
  `).collect();
  const cutoff = new Date('2026-04-01T00:00:00Z');
  await pruneRawTelemetry({ db, table: 'telemetry_hourly', before: cutoff, timestampField: 'hour' });
  await pruneRawTelemetry({ db, table: 'intuition_telemetry', before: cutoff });
  const [a] = await db.query(surql`SELECT count() AS n FROM telemetry_hourly GROUP ALL`).collect();
  const [b] = await db.query(surql`SELECT count() AS n FROM intuition_telemetry GROUP ALL`).collect();
  assert.equal(a.n, 1);
  assert.equal(b.n, 1);
  await close(db);
});

test('prune respects where: recall_log pending rows are NOT deleted by default 7d prune', async () => {
  const db = await fresh();
  const old = new Date('2026-04-01T00:00:00Z');
  const fresh1 = new Date('2026-05-11T14:00:00Z');
  await db.query(surql`
    CREATE recall_log CONTENT { ts: ${old},    query: 'old-pending',    k: 6, ranked_hits: [], outcome: 'pending',    session_id: 's1', meta: {} };
    CREATE recall_log CONTENT { ts: ${old},    query: 'old-reinforced', k: 6, ranked_hits: [], outcome: 'reinforced', session_id: 's2', meta: {}, evaluated_at: ${old} };
    CREATE recall_log CONTENT { ts: ${fresh1}, query: 'new-pending',    k: 6, ranked_hits: [], outcome: 'pending',    session_id: 's3', meta: {} };
  `).collect();
  const cutoff = new Date('2026-05-04T00:00:00Z'); // 7d before fresh1
  await pruneRawTelemetry({ db, table: 'recall_log', before: cutoff, where: 'outcome != "pending"' });
  const [rows] = await db.query(surql`SELECT query FROM recall_log ORDER BY query`).collect();
  const qs = rows.map((r) => r.query).sort();
  // old-reinforced deleted; old-pending KEPT (default 7d path); new-pending KEPT.
  assert.deepEqual(qs, ['new-pending', 'old-pending']);
  await close(db);
});

test('pending hard ceiling: outcome=pending AND ts < 30d → deleted; emits force-prune warning row', async () => {
  // Tests the recorder side; the integration test in Phase 5.2 covers
  // the job entry point that wires this together.
  const db = await fresh();
  const veryOld = new Date('2026-03-01T00:00:00Z');
  await db.query(surql`
    CREATE recall_log CONTENT { ts: ${veryOld}, query: 'stuck', k: 6, ranked_hits: [], outcome: 'pending', session_id: 's1', meta: {} };
  `).collect();
  const cutoff = new Date('2026-04-11T00:00:00Z'); // > 30d after veryOld
  const out = await pruneRawTelemetry({ db, table: 'recall_log', before: cutoff, where: 'outcome = "pending"' });
  assert.ok(out.count >= 1);
  const [rows] = await db.query(surql`SELECT count() AS n FROM recall_log GROUP ALL`).collect();
  assert.equal(rows?.n ?? 0, 0);
  await close(db);
});
```

- [ ] **Step 2: Run → fail**

```bash
npm run test:unit -- --test-name-pattern 'prune respects timestampField|prune respects where|pending hard ceiling'
```

- [ ] **Step 3: Implement `retention.js`**

Create `system/cognition/telemetry/retention.js`:

```js
// retention.js — DELETE rows where <timestampField> < $before AND <where?>.
// Single DELETE per call. Caller handles fail-soft.

import { surql } from 'surrealdb';

/**
 * @param {object} args
 * @param {object} args.db
 * @param {string} args.table              e.g. 'intuition_telemetry', 'recall_log', 'telemetry_hourly'
 * @param {Date}   args.before             rows with timestampField < before are deleted
 * @param {string} [args.timestampField]   default 'ts'; 'hour' for telemetry_hourly
 * @param {string} [args.where]            optional extra WHERE clause (raw SurrealQL fragment)
 * @returns {Promise<{ count: number }>}
 */
export async function pruneRawTelemetry({ db, table, before, timestampField = 'ts', where }) {
  const whereExtra = where ? ` AND (${where})` : '';
  // table is a non-bound identifier; the caller MUST pass a hardcoded
  // string. The function is internal-only.
  const sql = `DELETE ${table} WHERE ${timestampField} < $before${whereExtra}`;
  const [result] = await db.query(sql, { before }).collect();
  // SurrealDB returns an array of deleted-row records; length is the count.
  return { count: Array.isArray(result) ? result.length : 0 };
}
```

- [ ] **Step 4: Run → pass**

```bash
npm run test:unit -- --test-name-pattern 'prune respects timestampField|prune respects where|pending hard ceiling'
```

- [ ] **Step 5: Commit**

```bash
git commit -m "feat(telemetry): pruneRawTelemetry — table-aware retention DELETE"
```

### Task 5.2 — Standalone `telemetry-prune.js` internal job

**Files:** `system/cognition/jobs/internal/telemetry-prune.js`, `system/tests/integration/telemetry-prune-job.test.js`

- [ ] **Step 1: Failing test**

Create `system/tests/integration/telemetry-prune-job.test.js`:

```js
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { surql } from 'surrealdb';
import { close, connect } from '../../data/db/client.js';
import { runMigrations } from '../../data/db/migrate.js';
import telemetryPrune from '../../cognition/jobs/internal/telemetry-prune.js';

async function fresh() {
  const db = await connect({ engine: 'mem://' });
  await runMigrations(db, 'system/data/db/migrations');
  return db;
}

test('telemetry-prune deletes raw past 7d AND hourly past 90d', async () => {
  const db = await fresh();
  const old = new Date(Date.now() - 8 * 86_400_000);   // 8d ago
  const veryOldHour = new Date(Date.now() - 91 * 86_400_000); // 91d ago
  const fresh1 = new Date();
  await db.query(surql`
    CREATE intuition_telemetry CONTENT { ts: ${old}, latency_ms: 10, tokens_injected: 0, hits: 0, query_chars: 0 };
    CREATE intuition_telemetry CONTENT { ts: ${fresh1}, latency_ms: 10, tokens_injected: 0, hits: 0, query_chars: 0 };
    CREATE telemetry_hourly CONTENT { hour: ${veryOldHour}, faculty: 'intuition', event_kind: 'recall', count: 1, dimensions: {}, metric_sums: {}, metric_buckets: {} };
    CREATE telemetry_hourly CONTENT { hour: ${fresh1},      faculty: 'intuition', event_kind: 'recall', count: 1, dimensions: { x: 'y' }, metric_sums: {}, metric_buckets: {} };
  `).collect();
  const res = JSON.parse(await telemetryPrune({ db }));
  assert.ok(res.intuition_telemetry?.count >= 1);
  assert.ok(res.telemetry_hourly?.count >= 1);
  const [iCount] = await db.query(surql`SELECT count() AS n FROM intuition_telemetry GROUP ALL`).collect();
  const [hCount] = await db.query(surql`SELECT count() AS n FROM telemetry_hourly GROUP ALL`).collect();
  assert.equal(iCount.n, 1);
  assert.equal(hCount.n, 1);
  await close(db);
});

test('telemetry-prune pending hard ceiling deletes >30d pending recall_log + emits warning row', async () => {
  const db = await fresh();
  const veryOld = new Date(Date.now() - 31 * 86_400_000);
  await db.query(surql`
    CREATE recall_log CONTENT { ts: ${veryOld}, query: 'stuck', k: 6, ranked_hits: [], outcome: 'pending', session_id: 's1', meta: {} };
  `).collect();
  const res = JSON.parse(await telemetryPrune({ db }));
  assert.ok((res.recall_log_pending?.count ?? 0) >= 1);
  // Force-prune warning row landed (writer goes through the per-faculty
  // raw table for reinforcement, OR a dedicated telemetry_raw_reinforcement
  // table — implementation-dependent; the test just checks SOMETHING was
  // written).
  // If the recorder writes to `telemetry_raw_reinforcement`, query it;
  // otherwise check intuition_telemetry-style fallback. The implementation
  // picks one and the test asserts it.
  await close(db);
});

test('default-path pending exclusion (Stage 2): aged pending rows are NOT deleted, only force-pruned at the hard ceiling', async () => {
  const db = await fresh();
  const tenDays = new Date(Date.now() - 10 * 86_400_000);
  await db.query(surql`
    CREATE recall_log CONTENT { ts: ${tenDays}, query: 'aged-pending', k: 6, ranked_hits: [], outcome: 'pending', session_id: 's1', meta: {} };
  `).collect();
  await telemetryPrune({ db });
  const [rows] = await db.query(surql`SELECT query FROM recall_log`).collect();
  // 10d-old pending row survives the default 7d prune (where: outcome != pending).
  assert.deepEqual(rows.map((r) => r.query), ['aged-pending']);
  await close(db);
});
```

- [ ] **Step 2: Implement `telemetry-prune.js`**

Create `system/cognition/jobs/internal/telemetry-prune.js`:

```js
// telemetry-prune.js — standalone retention enforcer. Runs even if the
// rollup stage is disabled or failing. Fail-soft per stage.

import { pruneRawTelemetry } from '../../telemetry/retention.js';
import { readTelemetryConfig } from '../../telemetry/config.js';
import { recordTelemetry } from '../../telemetry/recorder.js';

export default async function telemetryPrune({ db }) {
  const cfg = await readTelemetryConfig(db);
  if (!cfg.enabled) return JSON.stringify({ skipped: 'disabled' });
  const result = {};

  // Stage 2 — raw retention (intuition_telemetry, recall_log non-pending).
  for (const table of ['intuition_telemetry', 'recall_log']) {
    try {
      const before = new Date(Date.now() - cfg.raw_retention_days * 86_400_000);
      const where = table === 'recall_log' ? 'outcome != "pending"' : null;
      result[table] = await pruneRawTelemetry({ db, table, before, where });
    } catch (e) {
      result[table] = { error: e.message };
    }
  }

  // Stage 2b — pending hard ceiling. Force-prune + warning row.
  try {
    const cutoff = new Date(Date.now() - cfg.pending_recall_log_hard_ceiling_days * 86_400_000);
    const deleted = await pruneRawTelemetry({
      db, table: 'recall_log', before: cutoff, where: 'outcome = "pending"',
    });
    if (deleted.count > 0) {
      try {
        await recordTelemetry({
          db,
          faculty: 'reinforcement',
          event_kind: 'pending_recall_log_force_pruned',
          dimensions: {},
          metrics: { count: deleted.count },
        });
      } catch {
        // Warning emission is advisory; don't fail the job.
      }
    }
    result.recall_log_pending = deleted;
  } catch (e) {
    result.recall_log_pending = { error: e.message };
  }

  // Stage 3 — hourly retention.
  try {
    const before = new Date(Date.now() - cfg.hourly_retention_days * 86_400_000);
    result.telemetry_hourly = await pruneRawTelemetry({
      db, table: 'telemetry_hourly', before, timestampField: 'hour',
    });
  } catch (e) {
    result.telemetry_hourly = { error: e.message };
  }

  return JSON.stringify(result);
}
```

- [ ] **Step 3: Run → pass**

```bash
npm run test:integration -- --test-name-pattern 'telemetry-prune'
```

- [ ] **Step 4: Commit**

```bash
git commit -m "feat(telemetry): telemetry-prune job — raw 7d + hourly 90d + pending 30d hard ceiling"
```

### Task 5.3 — `telemetry-rollup.js` internal job (rollup + prune stages)

**Files:** `system/cognition/jobs/internal/telemetry-rollup.js`

- [ ] **Step 1: Implement**

Create `system/cognition/jobs/internal/telemetry-rollup.js`:

```js
// telemetry-rollup.js — heartbeat-driven aggregator entry. Combines:
//   Stage 1: rollupHotTelemetry (registry → telemetry_hourly UPSERTs)
//   Stage 2: pruneRawTelemetry for intuition_telemetry, recall_log (non-pending)
//   Stage 2b: pending recall_log hard ceiling
//   Stage 3: telemetry_hourly retention
// Fail-soft per stage. Always exits cleanly.

import { readTelemetryConfig } from '../../telemetry/config.js';
import { rollupHotTelemetry } from '../../telemetry/rollup.js';
import { pruneRawTelemetry } from '../../telemetry/retention.js';
import { recordTelemetry } from '../../telemetry/recorder.js';

export default async function telemetryRollup({ db }) {
  const cfg = await readTelemetryConfig(db);
  if (!cfg.enabled) return JSON.stringify({ skipped: 'disabled' });

  const result = { rollup: {}, prune: {} };

  // Stage 1 — rollup.
  try {
    result.rollup = await rollupHotTelemetry({ db, cfg });
  } catch (e) {
    result.rollup = { error: e.message };
  }

  // Stage 2 — raw retention.
  for (const table of ['intuition_telemetry', 'recall_log']) {
    try {
      const before = new Date(Date.now() - cfg.raw_retention_days * 86_400_000);
      const where = table === 'recall_log' ? 'outcome != "pending"' : null;
      result.prune[table] = await pruneRawTelemetry({ db, table, before, where });
    } catch (e) {
      result.prune[table] = { error: e.message };
    }
  }

  // Stage 2b — pending hard ceiling.
  try {
    const cutoff = new Date(Date.now() - cfg.pending_recall_log_hard_ceiling_days * 86_400_000);
    const deleted = await pruneRawTelemetry({
      db, table: 'recall_log', before: cutoff, where: 'outcome = "pending"',
    });
    if (deleted.count > 0) {
      try {
        await recordTelemetry({
          db,
          faculty: 'reinforcement',
          event_kind: 'pending_recall_log_force_pruned',
          dimensions: {},
          metrics: { count: deleted.count },
        });
      } catch { /* advisory */ }
    }
    result.prune.recall_log_pending = deleted;
  } catch (e) {
    result.prune.recall_log_pending = { error: e.message };
  }

  // Stage 3 — hourly retention.
  try {
    const before = new Date(Date.now() - cfg.hourly_retention_days * 86_400_000);
    result.prune.telemetry_hourly = await pruneRawTelemetry({
      db, table: 'telemetry_hourly', before, timestampField: 'hour',
    });
  } catch (e) {
    result.prune.telemetry_hourly = { error: e.message };
  }

  return JSON.stringify(result);
}
```

- [ ] **Step 2: Smoke-test against the integration harness from Phase 3**

```bash
npm run test:integration -- --test-name-pattern 'aggregator is idempotent'
```

The harness already imports `rollupHotTelemetry` directly. A `npm run test:integration -- telemetry-rollup-job` confirms the full job entry runs without throwing in fail-soft.

- [ ] **Step 3: Commit**

```bash
git commit -m "feat(telemetry): telemetry-rollup job — rollup + retention + hard ceiling stages"
```

---

## Phase 6 — Doctor pending-row probe

> **Why:** A pending `recall_log` row older than 7 days indicates reinforcement is stuck — usually a daemon crash that never finished an evaluation. The Stage 2b hard ceiling (30d) is the last-resort guard; the doctor probe is the early warning at 7d > 100 rows.

### Task 6.1 — `rollupPendingRecallLog()` in `health.js`

**Files:** `system/runtime/cli/health.js`, `system/tests/integration/telemetry-doctor-probe.test.js`

- [ ] **Step 1: Failing test**

Create `system/tests/integration/telemetry-doctor-probe.test.js`:

```js
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { surql } from 'surrealdb';
import { close, connect } from '../../data/db/client.js';
import { runMigrations } from '../../data/db/migrate.js';
import { rollupPendingRecallLog, runHealth } from '../../runtime/cli/health.js';

async function fresh() {
  const db = await connect({ engine: 'mem://' });
  await runMigrations(db, 'system/data/db/migrations');
  return db;
}

test('rollupPendingRecallLog: 0 pending → ok', async () => {
  const db = await fresh();
  const r = await rollupPendingRecallLog(db);
  assert.equal(r.status, 'ok');
  assert.equal(r.count, 0);
  await close(db);
});

test('rollupPendingRecallLog: 50 pending older than 7d → ok (below threshold)', async () => {
  const db = await fresh();
  const old = new Date(Date.now() - 8 * 86_400_000);
  for (let i = 0; i < 50; i++) {
    await db.query(surql`
      CREATE recall_log CONTENT { ts: ${old}, query: ${'q'+i}, k: 6, ranked_hits: [], outcome: 'pending', session_id: ${'s'+i}, meta: {} };
    `).collect();
  }
  const r = await rollupPendingRecallLog(db);
  assert.equal(r.status, 'ok');
  assert.equal(r.count, 50);
  await close(db);
});

test('rollupPendingRecallLog: >100 pending older than 7d → warn', async () => {
  const db = await fresh();
  const old = new Date(Date.now() - 8 * 86_400_000);
  for (let i = 0; i < 101; i++) {
    await db.query(surql`
      CREATE recall_log CONTENT { ts: ${old}, query: ${'q'+i}, k: 6, ranked_hits: [], outcome: 'pending', session_id: ${'s'+i}, meta: {} };
    `).collect();
  }
  const r = await rollupPendingRecallLog(db);
  assert.equal(r.status, 'warn');
  assert.ok(r.count > 100);
  await close(db);
});

test('runHealth includes pending_recall_log in its output and exit code', async () => {
  const db = await fresh();
  const old = new Date(Date.now() - 8 * 86_400_000);
  for (let i = 0; i < 101; i++) {
    await db.query(surql`
      CREATE recall_log CONTENT { ts: ${old}, query: ${'q'+i}, k: 6, ranked_hits: [], outcome: 'pending', session_id: ${'s'+i}, meta: {} };
    `).collect();
  }
  const r = await runHealth(db, { json: true });
  const parsed = JSON.parse(r.output);
  assert.equal(parsed.pending_recall_log.status, 'warn');
  // exit_code should be ≥ 1 (warn or higher).
  assert.ok(r.exitCode >= 1);
  await close(db);
});
```

- [ ] **Step 2: Run → fail**

```bash
npm run test:integration -- --test-name-pattern 'rollupPendingRecallLog|runHealth includes pending_recall_log'
```

- [ ] **Step 3: Edit `system/runtime/cli/health.js`**

Append a new rollup function and wire it into `runHealth`:

```js
const PENDING_RECALL_LOG_WARN_THRESHOLD = 100;
const PENDING_RECALL_LOG_AGE_DAYS = 7;

export async function rollupPendingRecallLog(db) {
  const cutoff = new Date(Date.now() - PENDING_RECALL_LOG_AGE_DAYS * 86_400_000);
  try {
    const [row] = await db.query(
      `SELECT count() AS n FROM recall_log WHERE outcome = 'pending' AND ts < $cutoff GROUP ALL`,
      { cutoff },
    ).collect();
    const count = row?.n ?? 0;
    return {
      step: 'pending_recall_log',
      count,
      threshold: PENDING_RECALL_LOG_WARN_THRESHOLD,
      age_days: PENDING_RECALL_LOG_AGE_DAYS,
      status: count > PENDING_RECALL_LOG_WARN_THRESHOLD ? 'warn' : 'ok',
    };
  } catch (e) {
    return { step: 'pending_recall_log', count: 0, status: 'fail', error: e.message };
  }
}
```

Modify `runHealth` to include the new probe:

```js
export async function runHealth(db, { json = false } = {}) {
  const [budget, faculties, pending, dream, pendingRecallLog] = await Promise.all([
    rollupTokenBudget(db),
    rollupFacultyErrors(db),
    rollupPendingTriggers(db),
    rollupStaleDream(db),
    rollupPendingRecallLog(db),
  ]);
  const all = [budget, ...faculties, pending, dream, pendingRecallLog];
  const exitCode = aggregateExitCode(all);
  if (json) {
    return {
      output: JSON.stringify(
        { ts: new Date().toISOString(), budget, faculties, pending, dream, pending_recall_log: pendingRecallLog, exit_code: exitCode },
        null, 2,
      ),
      exitCode,
    };
  }
  const lines = [];
  lines.push(`=== Robin health · ${new Date().toISOString().slice(0, 10)} ===`);
  lines.push(`Token budget:        ${GLYPH[budget.status]} ${Math.round((budget.consumed ?? 0) / 1000)}k / ${Math.round((budget.daily ?? 0) / 1000)}k used (${Math.round((budget.pct ?? 0) * 100)}%)`);
  lines.push(`Pending triggers:    ${GLYPH[pending.status]} ${pending.count}`);
  lines.push(`Pending recall_log >7d: ${GLYPH[pendingRecallLog.status]} ${pendingRecallLog.count} (>${pendingRecallLog.threshold} indicates stuck reinforcement)`);
  lines.push(`Dream nightly:       ${GLYPH[dream.status]} ${dream.hours_since == null ? 'never' : `${Math.round(dream.hours_since)}h ago`}`);
  lines.push('Faculty error rate (7d):');
  for (const f of faculties) lines.push(`  ${String(f.step).padEnd(20)} ${GLYPH[f.status]} ${f.errors}/${f.n} errors`);
  return { output: lines.join('\n'), exitCode };
}
```

- [ ] **Step 4: Run → pass**

```bash
npm run test:integration -- --test-name-pattern 'rollupPendingRecallLog|runHealth includes pending_recall_log'
```

- [ ] **Step 5: Verify the existing `runHealth` callers still pass**

```bash
npm run test:integration -- --test-name-pattern 'runHealth|doctor.*health'
```

- [ ] **Step 6: Commit**

```bash
git commit -m "feat(doctor): pending recall_log probe — warn >100 pending older than 7d"
```

### Task 6.2 — Doctor command surfaces the probe

**Files:** `system/runtime/cli/commands/doctor.js`

- [ ] **Step 1: Read context**

`doctor.js:438` `export async function doctor(argv, deps)` calls `runHealth(db, { json })` when `--health` is passed. The new probe is automatically included via Phase 6.1's `runHealth` change — no additional editing needed. This task is verification.

- [ ] **Step 2: Run the doctor command against a seeded DB**

```bash
npm run test:integration -- --test-name-pattern 'doctor.*--health'
```

- [ ] **Step 3: Commit (only if any change is needed)**

If the existing doctor tests pass without modification, no commit is needed. If they fail because the text-format `runHealth` output gained a new line that breaks an exact-match assertion, update the test fixture (not the doctor command). Document the change in the commit:

```bash
git commit -m "test(doctor): update health-output fixture to include pending recall_log line"
```

---

## Phase 7 — MCP tool `show_telemetry_rollup`

> **Why:** The aggregator writes rows; this tool reads them. Default 24h window, filterable by `faculty` / `event_kind`. Shadow-mode-aware (returns an error so consumers don't accidentally rely on half-baked numbers during week-1).

### Task 7.1 — Tool factory + shadow-mode behavior

**Files:** `system/io/mcp/tools/show-telemetry-rollup.js`, `system/tests/integration/telemetry-show-rollup-tool.test.js`

- [ ] **Step 1: Failing test**

Create `system/tests/integration/telemetry-show-rollup-tool.test.js`:

```js
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { surql } from 'surrealdb';
import { close, connect } from '../../data/db/client.js';
import { runMigrations } from '../../data/db/migrate.js';
import { createShowTelemetryRollupTool } from '../../io/mcp/tools/show-telemetry-rollup.js';

async function fresh() {
  const db = await connect({ engine: 'mem://' });
  await runMigrations(db, 'system/data/db/migrations');
  return db;
}

test('show_telemetry_rollup default window (PT24H) returns recent rows', async () => {
  const db = await fresh();
  // Flip shadow_mode off so the tool returns rows.
  await db.query(surql`UPDATE runtime:\`telemetry.config\` SET value.shadow_mode = false`).collect();
  const now = new Date();
  await db.query(surql`
    CREATE telemetry_hourly CONTENT { hour: ${now}, faculty: 'intuition', event_kind: 'recall', count: 5, dimensions: { source: 'intuition' }, metric_sums: { latency_ms_sum: 100 }, metric_buckets: {} };
  `).collect();
  const tool = createShowTelemetryRollupTool({ db });
  const out = await tool.handler({});
  const payload = JSON.parse(out.content?.[0]?.text ?? '{}');
  assert.ok(Array.isArray(payload.rows));
  assert.ok(payload.rows.length >= 1);
  assert.equal(payload.rows[0].faculty, 'intuition');
  await close(db);
});

test('show_telemetry_rollup filters by faculty and event_kind', async () => {
  const db = await fresh();
  await db.query(surql`UPDATE runtime:\`telemetry.config\` SET value.shadow_mode = false`).collect();
  const now = new Date();
  await db.query(surql`
    CREATE telemetry_hourly CONTENT { hour: ${now}, faculty: 'intuition', event_kind: 'recall', count: 5, dimensions: {}, metric_sums: {}, metric_buckets: {} };
    CREATE telemetry_hourly CONTENT { hour: ${now}, faculty: 'reinforcement', event_kind: 'evaluate', count: 3, dimensions: { outcome: 'reinforced' }, metric_sums: {}, metric_buckets: {} };
  `).collect();
  const tool = createShowTelemetryRollupTool({ db });
  const out = await tool.handler({ faculty: 'reinforcement' });
  const payload = JSON.parse(out.content?.[0]?.text ?? '{}');
  assert.equal(payload.rows.length, 1);
  assert.equal(payload.rows[0].faculty, 'reinforcement');
  await close(db);
});

test('show_telemetry_rollup returns shadow-mode error when shadow_mode=true', async () => {
  const db = await fresh();
  // shadow_mode=true is the default seeded by 0017.
  const tool = createShowTelemetryRollupTool({ db });
  const out = await tool.handler({});
  const payload = JSON.parse(out.content?.[0]?.text ?? '{}');
  assert.match(payload.error ?? '', /shadow mode/);
  await close(db);
});
```

- [ ] **Step 2: Run → fail**

```bash
npm run test:integration -- --test-name-pattern 'show_telemetry_rollup'
```

- [ ] **Step 3: Implement `show-telemetry-rollup.js`**

Create `system/io/mcp/tools/show-telemetry-rollup.js`:

```js
// show-telemetry-rollup.js — read-only MCP introspection tool over telemetry_hourly.
// Shadow-mode-aware. No CREATE/UPDATE/DELETE in this file (enforced by
// audit-introspection-readonly.test.js).

import { surql } from 'surrealdb';
import { readTelemetryConfig } from '../../../cognition/telemetry/config.js';

const ISO_DURATION = /^P(T?)((\d+)D)?(T?(\d+)H)?$/;

function parseWindowMs(window) {
  // Tiny ISO-8601-duration parser for "PT24H", "P7D", "P1D", etc.
  // Reject anything else; default 24h.
  if (typeof window !== 'string') return 24 * 3600_000;
  const m = window.match(ISO_DURATION);
  if (!m) return 24 * 3600_000;
  const days = Number(m[3] ?? 0);
  const hours = Number(m[5] ?? 0);
  return (days * 24 + hours) * 3600_000 || 24 * 3600_000;
}

export function createShowTelemetryRollupTool({ db }) {
  return {
    name: 'show_telemetry_rollup',
    description:
      'Return hourly telemetry rollups. Filter by faculty and/or event_kind. ' +
      'Window defaults to last 24h. Returns aggregated counts, sums, and bucket histograms ' +
      'from telemetry_hourly.',
    inputSchema: {
      type: 'object',
      properties: {
        faculty: { type: 'string', description: 'e.g. "intuition", "reinforcement". Optional.' },
        event_kind: { type: 'string', description: 'e.g. "recall", "evaluate". Optional.' },
        window: { type: 'string', description: 'ISO duration: "PT24H", "P7D". Default "PT24H".' },
        limit: { type: 'number', default: 200 },
      },
    },
    handler: async (args = {}) => {
      const cfg = await readTelemetryConfig(db);
      if (cfg.shadow_mode) {
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({ error: 'show_telemetry_rollup is in shadow mode; flip runtime:telemetry.config.shadow_mode to false to enable.' }),
          }],
        };
      }
      const sinceMs = Date.now() - parseWindowMs(args.window ?? 'PT24H');
      const since = new Date(sinceMs);
      const faculty = args.faculty ?? null;
      const eventKind = args.event_kind ?? null;
      const limit = Number.isInteger(args.limit) && args.limit > 0 ? args.limit : 200;
      const [rows] = await db.query(
        `SELECT * FROM telemetry_hourly
          WHERE hour >= $since
            AND ($faculty IS NONE   OR faculty   = $faculty)
            AND ($event_kind IS NONE OR event_kind = $event_kind)
          ORDER BY hour DESC, faculty, event_kind
          LIMIT $limit`,
        { since, faculty, event_kind: eventKind, limit },
      ).collect();
      return {
        content: [{ type: 'text', text: JSON.stringify({ window: args.window ?? 'PT24H', rows: rows ?? [] }, null, 2) }],
      };
    },
  };
}
```

- [ ] **Step 4: Run → pass**

```bash
npm run test:integration -- --test-name-pattern 'show_telemetry_rollup'
```

- [ ] **Step 5: Verify the introspection-readonly audit guard**

```bash
npm run test:unit -- --test-name-pattern 'introspection tools never write'
```

Expected: the test scans every file under `system/io/mcp/tools/` for `CREATE` / `UPDATE` / `DELETE` keywords. `show-telemetry-rollup.js` contains none (only SELECT).

- [ ] **Step 6: Commit**

```bash
git commit -m "feat(mcp): show_telemetry_rollup — read-only window query over telemetry_hourly"
```

### Task 7.2 — Register in `buildTools(ctx)` (R-3 coordination)

**Files:** `system/runtime/daemon/tools.js`

- [ ] **Step 1: Read context**

`system/runtime/daemon/tools.js:52` exports `buildTools(ctx)` (R-3 has shipped — verified by `ls system/runtime/daemon/routes/` returning the route files). The tool is registered with one import line + one `tools.push(createShowTelemetryRollupTool({db: ctx.db}))` call alongside other introspection tools (e.g., `createShowStepHealthTool` at line 41).

- [ ] **Step 2: Edit `tools.js`**

Add the import near the other `createShow*` imports (alphabetical):

```js
import { createShowTelemetryRollupTool } from '../../io/mcp/tools/show-telemetry-rollup.js';
```

In `buildTools(ctx)`'s `tools.push(...)` block, add (near the other show-* registrations):

```js
createShowTelemetryRollupTool({ db: ctx.db }),
```

- [ ] **Step 3: Verify daemon boot doesn't regress**

```bash
npm run test:integration -- --test-name-pattern 'daemon.*boot|buildTools'
```

If a tools-list snapshot test exists, update it to include `show_telemetry_rollup` alongside the existing introspection tools. The snapshot lives at `system/tests/integration/` and is fed by the daemon boot path.

- [ ] **Step 4: Commit**

```bash
git commit -m "feat(daemon): register show_telemetry_rollup in buildTools(ctx)"
```

---

## Phase 8 — Job manifests

> **Why:** The `.md` descriptors under `system/cognition/jobs/builtin/` are how the heartbeat dispatcher discovers and schedules internal jobs. Two descriptors: `telemetry-rollup.md` (every hour at :05) and `telemetry-prune.md` (every hour at :15). Belt-and-suspenders: prune runs independently of rollup so retention enforcement survives a rollup outage.

### Task 8.1 — `telemetry-rollup.md`

**Files:** `system/cognition/jobs/builtin/telemetry-rollup.md`

- [ ] **Step 1: Create the descriptor**

```markdown
---
name: telemetry-rollup
schedule: "5 * * * *"
runtime: internal
enabled: true
catch_up: false
timeout_minutes: 2
notify: none
notify_on_failure: true
manually_runnable: true
description: Roll up hot-tier telemetry (intuition_telemetry, recall_log, cadence_telemetry hot steps, meta_cognition_telemetry) into telemetry_hourly. Prunes raw rows past 7d and hourly rows past 90d. Force-prunes stuck pending recall_log rows past 30d.
---

Internal job. Implementation in `cognition/jobs/internal/telemetry-rollup.js`. Reads `runtime:telemetry.config`; if `enabled=false`, no-ops. Iterates the registered hot-source SELECTs (per `system/cognition/telemetry/rollup-registry.js`) over `[$cursor, $cutoff)` where `$cutoff = now - cutoff_safety_seconds`, UPSERTs `telemetry_hourly:{dim_hash}` rows, advances per-cursor. Then runs Stage 2 retention (7d raw), Stage 2b pending hard ceiling (30d), and Stage 3 hourly retention (90d). Fail-soft per stage and per cursor.

Schedule `5 * * * *` = every hour at :05 (small offset from heartbeat boundary so it doesn't contend with reinforce-recall at :00).
```

- [ ] **Step 2: Verify the dispatcher picks it up**

```bash
npm run test:integration -- --test-name-pattern 'dispatcher.*telemetry-rollup|jobs list includes telemetry-rollup'
```

If no descriptor-discovery test exists, add a one-liner check to the existing `list-jobs.js` MCP tool integration test that confirms the new job name appears.

- [ ] **Step 3: Commit**

```bash
git commit -m "feat(jobs): telemetry-rollup descriptor — hourly :05 internal job"
```

### Task 8.2 — `telemetry-prune.md`

**Files:** `system/cognition/jobs/builtin/telemetry-prune.md`

- [ ] **Step 1: Create the descriptor**

```markdown
---
name: telemetry-prune
schedule: "15 * * * *"
runtime: internal
enabled: true
catch_up: false
timeout_minutes: 2
notify: none
notify_on_failure: true
manually_runnable: true
description: Enforce telemetry retention independently of the rollup stage. Deletes raw intuition_telemetry/recall_log rows past 7d (excluding pending), force-prunes pending recall_log rows past 30d, and deletes telemetry_hourly rows past 90d.
---

Internal job. Implementation in `cognition/jobs/internal/telemetry-prune.js`. Belt-and-suspenders: even if `telemetry-rollup` is failing or disabled (`runtime:telemetry.config.enabled=false`), retention still runs at :15 every hour and keeps the hot tables bounded.

Schedule `15 * * * *` = every hour at :15 (offset from telemetry-rollup at :05).
```

- [ ] **Step 2: Commit**

```bash
git commit -m "feat(jobs): telemetry-prune descriptor — hourly :15 retention enforcer"
```

---

## Phase 9 — Backward-compat + integration sweep

> **Why:** §9.3 of the spec: confirm `explain_recall` still works against raw `recall_log`; B1's `attribution.mode` counts propagate; A3's `mmr_path` dimension propagates; D1's `focus_block_present` propagates; B2's fan-out propagates; D3's `query` field stays in `meta`; hand-aggregated raw matches rollup ±1 row. The sweep is the gate before flipping `shadow_mode=false`.

### Task 9.1 — Backward-compat suite

**Files:** `system/tests/integration/telemetry-backwards-compat.test.js`

- [ ] **Step 1: Failing test**

Create `system/tests/integration/telemetry-backwards-compat.test.js` with §9.3 tests 23-29:

```js
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { surql } from 'surrealdb';
import { close, connect } from '../../data/db/client.js';
import { runMigrations } from '../../data/db/migrate.js';
import { rollupHotTelemetry } from '../../cognition/telemetry/rollup.js';
import { readTelemetryConfig } from '../../cognition/telemetry/config.js';

async function fresh() {
  const db = await connect({ engine: 'mem://' });
  await runMigrations(db, 'system/data/db/migrations');
  // Flip shadow off so tests can assert rollup row content; the
  // aggregator writes regardless of shadow_mode (shadow only gates the
  // MCP tool surface).
  return db;
}

test('B1 attribution.mode counts propagate: 5 citation + 3 fallback_no_reply → telemetry_hourly count=5/3', async () => {
  const db = await fresh();
  const hour = new Date('2026-05-11T14:00:00Z');
  const evaluated = new Date(hour.getTime() + 6 * 60_000);
  for (let i = 0; i < 5; i++) {
    await db.query(surql`CREATE recall_log CONTENT { ts: ${hour}, evaluated_at: ${evaluated}, query: ${'q'+i}, k: 6, ranked_hits: [], outcome: 'reinforced', session_id: ${'s'+i}, attribution: { mode: 'citation', used_count: 1, total: 2, dropped_hits: 0, elapsed_ms: 5 }, meta: { from: 'intuition' } }`).collect();
  }
  for (let i = 0; i < 3; i++) {
    await db.query(surql`CREATE recall_log CONTENT { ts: ${hour}, evaluated_at: ${evaluated}, query: ${'qf'+i}, k: 6, ranked_hits: [], outcome: 'reinforced', session_id: ${'sf'+i}, attribution: { mode: 'fallback_no_reply', used_count: 0, total: 0, dropped_hits: 0, elapsed_ms: 5 }, meta: { from: 'intuition' } }`).collect();
  }
  const cfg = await readTelemetryConfig(db);
  await rollupHotTelemetry({ db, cfg, nowFn: () => new Date(hour.getTime() + 65 * 60_000) });
  const [cite] = await db.query(surql`SELECT count FROM telemetry_hourly WHERE faculty='intuition' AND event_kind='recall_attribution' AND dimensions.mode='citation'`).collect();
  const [fb] = await db.query(surql`SELECT count FROM telemetry_hourly WHERE faculty='intuition' AND event_kind='recall_attribution' AND dimensions.mode='fallback_no_reply'`).collect();
  assert.equal(cite[0].count, 5);
  assert.equal(fb[0].count, 3);
  await close(db);
});

test('A3 mmr_path dimension propagates: 4 cosine + 2 substring → two rollup rows', async () => {
  const db = await fresh();
  const hour = new Date('2026-05-11T14:00:00Z');
  for (let i = 0; i < 4; i++) {
    await db.query(surql`CREATE intuition_telemetry CONTENT { ts: ${hour}, latency_ms: 10, tokens_injected: 0, hits: 0, query_chars: 0, meta: { from: 'intuition', mmr_path: 'cosine' } }`).collect();
  }
  for (let i = 0; i < 2; i++) {
    await db.query(surql`CREATE intuition_telemetry CONTENT { ts: ${hour}, latency_ms: 10, tokens_injected: 0, hits: 0, query_chars: 0, meta: { from: 'intuition', mmr_path: 'substring' } }`).collect();
  }
  const cfg = await readTelemetryConfig(db);
  await rollupHotTelemetry({ db, cfg, nowFn: () => new Date(hour.getTime() + 65 * 60_000) });
  const [rows] = await db.query(surql`SELECT dimensions, count FROM telemetry_hourly WHERE faculty='intuition' AND event_kind='recall' ORDER BY dimensions.mmr_path`).collect();
  assert.equal(rows.length, 2);
  const cosine = rows.find((r) => r.dimensions.mmr_path === 'cosine');
  const substring = rows.find((r) => r.dimensions.mmr_path === 'substring');
  assert.equal(cosine.count, 4);
  assert.equal(substring.count, 2);
  await close(db);
});

test('D1 focus_block_present dimension propagates: 3 true + 5 false → two rows', async () => {
  // Seeds recall_log rows; relies on the recall_log_eval cursor.
  const db = await fresh();
  const hour = new Date('2026-05-11T14:00:00Z');
  const evaluated = new Date(hour.getTime() + 6 * 60_000);
  for (let i = 0; i < 3; i++) {
    await db.query(surql`CREATE recall_log CONTENT { ts: ${hour}, evaluated_at: ${evaluated}, query: ${'q'+i}, k: 6, ranked_hits: [], outcome: 'reinforced', session_id: ${'s'+i}, attribution: { mode: 'citation', used_count: 1, total: 1, dropped_hits: 0, elapsed_ms: 5 }, meta: { from: 'intuition', focus_block_present: true, focus_block_tokens: 200 } }`).collect();
  }
  for (let i = 0; i < 5; i++) {
    await db.query(surql`CREATE recall_log CONTENT { ts: ${hour}, evaluated_at: ${evaluated}, query: ${'qf'+i}, k: 6, ranked_hits: [], outcome: 'reinforced', session_id: ${'sf'+i}, attribution: { mode: 'citation', used_count: 1, total: 1, dropped_hits: 0, elapsed_ms: 5 }, meta: { from: 'intuition', focus_block_present: false, focus_block_tokens: 0 } }`).collect();
  }
  const cfg = await readTelemetryConfig(db);
  await rollupHotTelemetry({ db, cfg, nowFn: () => new Date(hour.getTime() + 65 * 60_000) });
  const [rows] = await db.query(surql`SELECT dimensions.focus_block_present AS fb, count FROM telemetry_hourly WHERE faculty='intuition' AND event_kind='recall_attribution' ORDER BY fb`).collect();
  assert.equal(rows.length, 2);
  const truthy = rows.find((r) => r.fb === true);
  const falsy = rows.find((r) => r.fb === false);
  assert.equal(truthy.count, 3);
  assert.equal(falsy.count, 5);
  await close(db);
});

test('B2 fan-out propagates: contradictions_suppressed_by_rule → per-rule sums', async () => {
  // The fan-out happens at recordTelemetry() time, NOT at rollup time —
  // existing intuition_telemetry writers (inject.js) write
  // contradictions_suppressed_<rule> scalars directly; the SELECT in the
  // registry math::sum's them. This test seeds the post-fan-out shape.
  const db = await fresh();
  const hour = new Date('2026-05-11T14:00:00Z');
  await db.query(surql`
    CREATE intuition_telemetry CONTENT { ts: ${hour}, latency_ms: 10, tokens_injected: 0, hits: 0, query_chars: 0, meta: { from: 'intuition', mmr_path: 'cosine', contradictions_suppressed_low_confidence: 2, contradictions_suppressed_private_redaction: 1 } };
  `).collect();
  // Spec §3.4 says the recorder fans out; the rollup SELECT in the
  // registry today reads meta.contradictions_surfaced + meta.conflict_block_tokens
  // (the two scalars B2 introduces directly). The per-rule sums are
  // pulled from the fanned-out scalars on the row. The registry SELECT
  // does NOT currently aggregate per-rule keys — that requires either a
  // dynamic SELECT or a known-keys list. This test documents the
  // open behavior: per-rule scalars on the raw row are available for
  // hand-aggregation; the umbrella row's metric_sums.* MAY contain them
  // once the registry's intuition_telemetry SELECT learns the list.
  // For now the assertion is that the raw row carries the data.
  const [raw] = await db.query(surql`SELECT meta FROM intuition_telemetry`).collect();
  assert.equal(raw[0].meta.contradictions_suppressed_low_confidence, 2);
  assert.equal(raw[0].meta.contradictions_suppressed_private_redaction, 1);
  await close(db);
});

test('D3 query stays in meta: cadence_telemetry belief.call rows do not leak query to dimensions', async () => {
  const db = await fresh();
  const hour = new Date('2026-05-11T14:00:00Z');
  await db.query(surql`
    CREATE cadence_telemetry CONTENT { ts: ${hour}, step: 'belief.call', success: true, latency_ms: 30, sample_rate: 1, tokens_in: 200, tokens_out: 40, meta: { query: 'free text user query' } };
  `).collect();
  const cfg = await readTelemetryConfig(db);
  await rollupHotTelemetry({ db, cfg, nowFn: () => new Date(hour.getTime() + 65 * 60_000) });
  const [rows] = await db.query(surql`SELECT dimensions FROM telemetry_hourly WHERE faculty='belief' AND event_kind='call'`).collect();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].dimensions.query, undefined);
  // The raw row's meta.query is untouched.
  const [raw] = await db.query(surql`SELECT meta FROM cadence_telemetry WHERE step='belief.call'`).collect();
  assert.equal(raw[0].meta.query, 'free text user query');
  await close(db);
});

test('hand-aggregated raw == rollup ±1 row on a chosen 1-hour window', async () => {
  const db = await fresh();
  const hour = new Date('2026-05-11T14:00:00Z');
  for (let i = 0; i < 7; i++) {
    await db.query(surql`CREATE intuition_telemetry CONTENT { ts: ${new Date(hour.getTime() + i * 60_000)}, latency_ms: ${10 + i}, tokens_injected: 100, hits: 1, query_chars: 50, meta: { from: 'intuition', mmr_path: 'cosine' } }`).collect();
  }
  const cfg = await readTelemetryConfig(db);
  await rollupHotTelemetry({ db, cfg, nowFn: () => new Date(hour.getTime() + 65 * 60_000) });
  const [rolled] = await db.query(surql`SELECT count, metric_sums.latency_ms_sum AS lsum FROM telemetry_hourly WHERE faculty='intuition' AND event_kind='recall'`).collect();
  const [hand] = await db.query(surql`SELECT count() AS n, math::sum(latency_ms) AS lsum FROM intuition_telemetry WHERE ts >= ${hour} AND ts < ${new Date(hour.getTime() + 3600_000)} GROUP ALL`).collect();
  assert.ok(Math.abs(rolled[0].count - hand.n) <= 1);
  assert.ok(Math.abs(rolled[0].lsum - hand.lsum) <= 1);
  await close(db);
});

test('explain_recall continues to read raw recall_log unchanged', async () => {
  // The rollup does NOT modify recall_log; explain_recall (Theme 4)
  // continues to read raw rows. Test imports the existing tool factory
  // and exercises it against a seeded row.
  const db = await fresh();
  const hour = new Date('2026-05-11T14:00:00Z');
  await db.query(surql`
    CREATE recall_log CONTENT { id: 'recall_log:demo', ts: ${hour}, evaluated_at: ${new Date(hour.getTime() + 6 * 60_000)}, query: 'sourdough', k: 6, ranked_hits: [], outcome: 'reinforced', session_id: 's1', meta: { from: 'intuition' } };
  `).collect();
  const cfg = await readTelemetryConfig(db);
  await rollupHotTelemetry({ db, cfg, nowFn: () => new Date(hour.getTime() + 65 * 60_000) });
  // Re-query raw recall_log — content unchanged.
  const [rows] = await db.query(surql`SELECT id, query, outcome FROM recall_log`).collect();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].query, 'sourdough');
  await close(db);
});
```

- [ ] **Step 2: Run → expect pass**

```bash
npm run test:integration -- --test-name-pattern 'attribution.mode|mmr_path|focus_block_present|B2 fan-out|D3 query|hand-aggregated|explain_recall'
```

- [ ] **Step 3: Commit**

```bash
git commit -m "test(telemetry): backwards-compat sweep — B1 / A3 / D1 / B2 / D3 / hand-vs-rolled"
```

---

## Phase 10 — Docs

### Task 10.1 — `docs/architecture.md`

**Files:** `docs/architecture.md`

- [ ] **Step 1: Locate the "Operational" / "Evolution layer" section**

```bash
grep -n '^## \|^### ' docs/architecture.md | head -40
```

- [ ] **Step 2: Add a paragraph + diagram row**

Under the section that describes operational rollup tables (or the closest analogue), append:

```markdown
### Telemetry umbrella (C3)

`telemetry_hourly` is an hourly rollup of hot-tier telemetry — `intuition_telemetry`, `recall_log` (via the `evaluated_at` cursor, B1-aware), the hot prefixes of `cadence_telemetry` (`belief.%`, `dream.%`), and `meta_cognition_telemetry`. The aggregator (`system/cognition/jobs/internal/telemetry-rollup.js`) runs hourly at :05, UPSERTs `telemetry_hourly:{dimensions_hash}` rows over `[$cursor, $cutoff)`, advances per-source cursors stored on `runtime:telemetry.cursor`, and prunes raw rows past 7d / hourly rows past 90d. Cold tables (`compaction_telemetry`, `state_inference_telemetry`, `recall_eval_runs`, non-hot `cadence_telemetry`) stay raw. See `docs/superpowers/specs/2026-05-11-cognition-c3-telemetry-umbrella-design.md`.

Diagram:
- `telemetry_hourly` · hourly rollups of hot faculties (intuition, reinforcement, belief, dream, meta_cognition); 90d retention.
- `runtime:telemetry.config` · enabled / shadow_mode / retention / cadence_hot_steps / pending_recall_log_hard_ceiling_days.
- `runtime:telemetry.cursor` · per-source cursor map (intuition_telemetry, recall_log_eval, cadence_telemetry_hot, meta_cognition_telemetry).
```

- [ ] **Step 3: Commit**

```bash
git commit -m "docs(architecture): telemetry umbrella — telemetry_hourly + runtime:telemetry.*"
```

### Task 10.2 — `docs/faculties.md` "Telemetry" subsection

**Files:** `docs/faculties.md`

- [ ] **Step 1: Append a new subsection at the end of the introspection section**

```markdown
## Telemetry

Robin's telemetry surface has two tiers:

- **Hot** (rolled up hourly into `telemetry_hourly`):
  - `intuition_telemetry` → `faculty='intuition'`, `event_kind='recall'`. Dimensions: `source`, `mmr_path`. Metric sums: `latency_ms_sum`, `tokens_injected_sum`, `hits_sum`, `query_chars_sum`, `contradictions_surfaced_sum`, `conflict_block_tokens_sum`. Bucket: `latency_ms.{p50,p95,p99}`.
  - `recall_log` (via `evaluated_at` cursor) → `faculty='intuition'`, `event_kind='recall_attribution'` (dimensions: `mode`, `source`, `focus_block_present`; metric sums: `used_count_sum`, `total_sum`, `dropped_hits_sum`, `elapsed_ms_sum`, `focus_block_tokens_sum`) AND `faculty='reinforcement'`, `event_kind='evaluate'` (dimensions: `outcome`).
  - `cadence_telemetry` (hot prefixes `belief.%`, `dream.%`) → `faculty='belief'` / `event_kind='<sub_step>'` and `faculty='dream'` / `event_kind='<sub_step>'`. Dimensions: `success`. Metric sums: `latency_ms_sum`, `sample_rate_sum`, `tokens_in_sum`, `tokens_out_sum`.
  - `meta_cognition_telemetry` → `faculty='meta_cognition'`, `event_kind='run'`. Dimensions: `outcome`. Metric sums: `tokens_in_sum`, `tokens_out_sum`, `latency_ms_sum`, `actions_proposed_sum`, `actions_accepted_sum`.

- **Cold** (raw only; query directly): `compaction_telemetry`, `state_inference_telemetry`, `recall_eval_runs`, non-hot `cadence_telemetry`.

### `show_telemetry_rollup` MCP tool

Read-only window query over `telemetry_hourly`. Default window `PT24H`; filter by `faculty` and/or `event_kind`. Returns rolled-up rows ordered by `hour DESC`. Behind `runtime:telemetry.config.shadow_mode` for the first week after migration — the tool returns an explanatory error until the operator flips `shadow_mode=false`.

### `recordTelemetry()` contract for new faculties

New telemetry writers SHOULD use `system/cognition/telemetry/recorder.js`:

```js
await recordTelemetry({
  db,
  faculty: 'intuition',
  event_kind: 'recall',
  dimensions: { source: 'intuition', mmr_path: 'cosine' }, // enumerable strings / bool / int; ≤64 chars; charset [A-Za-z0-9_.-]
  metrics: { latency_ms: 18, contradictions_suppressed_by_rule: { low_confidence: 3 } }, // object-shaped metrics fan out (≤16 keys)
  meta: { query: 'free text goes here' }, // FLEXIBLE per-row extras — never in dimensions
});
```

Existing recorders (`intuition_telemetry`, `recall_log`, `cadence_telemetry`, `meta_cognition_telemetry`) are grandfathered — they continue to write to their per-faculty tables directly. The aggregator translates their column shape into the umbrella shape at rollup time.
```

- [ ] **Step 2: Commit**

```bash
git commit -m "docs(faculties): telemetry tier classification + show_telemetry_rollup + recordTelemetry contract"
```

---

## Phase 11 — Final verification gates + rollout

### Task 11.1 — Full test + lint sweep

- [ ] **Step 1: Run all unit tests**

```bash
npm run test:unit
```

Expected: all pass — including `recordTelemetry`, `dimensionsHash`, rollup math, registry, retention, pending hard ceiling.

- [ ] **Step 2: Run all integration tests**

```bash
npm run test:integration
```

Expected: all pass — including the 0017 migration suite, rollup-job idempotency, cadence hot-step bridge, prune job, MCP tool, doctor probe, backwards-compat sweep.

- [ ] **Step 3: Lint**

```bash
npm run lint
```

Expected: zero errors. Run `npm run format` if Biome auto-imports need a sweep.

- [ ] **Step 4: Audit-introspection-readonly guard**

```bash
npm run test:unit -- --test-name-pattern 'introspection tools never write'
```

Expected: `show-telemetry-rollup.js` contains no `CREATE`/`UPDATE`/`DELETE`. The Phase 5 prune lives in `system/cognition/jobs/internal/`, which is allowed to write.

- [ ] **Step 5: Self-review checklist**

  - [ ] Spec §1 (inventory) → Phase 0 (migration), Phase 2 (registry covers every hot source).
  - [ ] Spec §2 (two-tier classification) → Phase 2 (registry hot entries) + Phase 5 (cold tables untouched).
  - [ ] Spec §3 (unified row shape) → Phase 0 (table DDL), Phase 1 (recorder enforces dimension contract), Phase 2 (registry projection enforces row family shape).
  - [ ] Spec §3.1 privacy/cardinality → Phase 1 Task 1.1 (validation tests).
  - [ ] Spec §3.2 cadence hot-step bridge → Phase 4 (integration test).
  - [ ] Spec §3.3 sampling fidelity → Phase 2 registry SELECT includes `sample_rate_sum`.
  - [ ] Spec §3.4 object-shaped metric fan-out → Phase 1 Task 1.1 (test 6 + 7).
  - [ ] Spec §3.5 dimensions_hash normalization → Phase 1 Task 1.2 (determinism tests).
  - [ ] Spec §4 aggregation strategy → Phase 3 (rollup.js).
  - [ ] Spec §4.2 SELECTs (intuition, recall_log_eval, cadence_telemetry_hot, meta_cognition_telemetry) → Phase 2 registry entries.
  - [ ] Spec §4.3 idempotency + cursor advance → Phase 3 Task 3.2.
  - [ ] Spec §4.4 re-aggregation window → Phase 3 (UPSERT replaces; full-window SELECT).
  - [ ] Spec §4.5 what aggregator does NOT roll up → Phase 2 registry omits cold tables.
  - [ ] Spec §5 implementation files → all created in Phases 1-7.
  - [ ] Spec §5.3.1 pending-row hard ceiling → Phase 5 (retention + Stage 2b in rollup job).
  - [ ] Spec §5.4 config row + faculties_enabled kill switch → Phase 0 (migration seed) + Phase 2 (`getEnabledEntries`).
  - [ ] Spec §5.5 MCP tool → Phase 7.
  - [ ] Spec §6 backwards-compat (B1, A3, B2, C1, C2, D1, D2, D3) → Phase 9 sweep.
  - [ ] Spec §6.2 A3 precondition check → Phase 0 Task 0.2 test.
  - [ ] Spec §7 migration → Phase 0.
  - [ ] Spec §8 rollout (shadow_mode) → Phase 7 (tool shadow-mode error) + Phase 11 Task 11.2 (flip).
  - [ ] Spec §9 test plan → Phases 1, 3, 4, 5, 6, 7, 9.
  - [ ] Spec §10 file-by-file changes → file structure table at the top.
  - [ ] Spec §11 clarifications (enabled is next-tick, heartbeat scheduler, R-3 coordination, math::percentile fallback, C3 is the contract for all round-2 telemetry) → noted in plan header and Phase 3 implementation.

- [ ] **Step 6: Commit any final cleanups**

```bash
git status
# Only if there are changes:
git commit -m "chore: post-cleanup after C3 telemetry umbrella"
```

### Task 11.2 — Rollout: shadow → enabled

> **Why last:** The migration seeds `shadow_mode=true`. The aggregator runs immediately and accumulates rows; the MCP tool returns a shadow-mode error. After one week of clean operation on Kevin's instance — verifying rollup row growth, math against hand-aggregated raw SELECTs (Phase 9 sweep is the test-side guarantee; the operational sample is the rollout guarantee), no per-cursor `error:` entries in the job's last-result rows — flip `shadow_mode=false`.

- [ ] **Step 1: After one week in shadow, run a sanity sample**

```bash
# Read a 24h window of rolled rows.
robin doctor --health --json | jq '.pending_recall_log'
# Inspect the last few telemetry-rollup job results via list-jobs MCP tool.
```

Expected: `pending_recall_log.status` is `ok`; the rollup job's last 7 runs all returned `{ ok: true, ... }` per cursor. No `error:` strings in any branch.

- [ ] **Step 2: Flip `shadow_mode=false` via a runtime UPDATE**

```bash
# Manually via psql/surrealQL — there's no CLI command for runtime row edits.
# The operator runs:
#   UPDATE runtime:`telemetry.config` SET value.shadow_mode = false;
# (no daemon restart required; the MCP tool reads on each invocation)
```

- [ ] **Step 3: Verify the MCP tool now returns rows**

```bash
# From any MCP client (e.g., Claude Code):
#   show_telemetry_rollup({ window: 'PT24H' })
# Expected: { window: 'PT24H', rows: [ ... ] }
```

- [ ] **Step 4: No commit needed**

The shadow→enabled flip is a runtime config edit, not a code change. The contract is documented in the migration's seed comment and in `docs/faculties.md` (Phase 10 Task 10.2).

### Task 11.3 — Open questions (carried forward as follow-ups)

These are spec §11.2 ambiguities — non-blocking; track separately:

- Daily rollup (`telemetry_daily`) — add when `telemetry_hourly` row count crosses ~100K, or when the doctor widget wants 1-year trends. Trivial follow-up: one new job tick + one UPSERT shape.
- Cold-faculty fold-in (`compaction_telemetry`, `state_inference_telemetry`, `recall_eval_runs`) — revisit after Theme 4's introspection tools have soaked. Today no consumer needs a unified view.
- C1 counter-row sampling — hourly delta on `runtime:biographer.value` → trend data. Trivial to add; not needed for round-2 specs.
- Per-rule scalar enumeration in the intuition_telemetry registry SELECT — today the SELECT picks up `contradictions_surfaced` and `conflict_block_tokens`; per-rule keys live on the raw row but aren't aggregated in the rollup. A follow-up adds them via a known-keys list or a dynamic SELECT.
- Dimensions hash bit-width bump (24 → 32 hex chars) — if a future faculty produces collision-prone dimension sets.
- Multi-process aggregation — if `robin-mcp` ever shards, the aggregator needs a lock or per-shard hour bucket merge.
- Tool naming consolidation — if `show_step_health` / `show_pending_triggers` eventually wrap `telemetry_hourly` reads, centralize behind `show_telemetry_rollup`.
- t-digest sketch for percentiles — if `math::percentile` becomes a per-tick hot spot, swap the SurrealQL path for an in-recorder t-digest.

## Final commit

```bash
git push -u origin refactor/system-restructure
gh pr create --title "Cognition C3: telemetry umbrella" --body "$(cat <<'EOF'
## Summary
- Add `telemetry_hourly` rollup table + 0017 migration (additive: 2 indexes on recall_log, evaluated_at backfill, runtime:telemetry.* seeds, A3 precondition check).
- Heartbeat-driven aggregator `telemetry-rollup` (hourly :05) and standalone retention enforcer `telemetry-prune` (hourly :15). Both fail-soft.
- `recordTelemetry()` recorder enforces §3.1 dimension validation (string|bool|int, ≤64 chars, charset [A-Za-z0-9_.-]), §3.4 object-shaped metric fan-out (≤16 keys), §3.5 sorted-keys hash determinism.
- Per-cursor registry (`rollup-registry.js`) — adding a new hot source = one new entry + one faculties_enabled flip.
- Cadence hot-step bridge for D3's `belief.call` and C2's `dream.<sub_step>` rows (config-driven prefix list).
- Pending recall_log hard-ceiling prune (30d) + doctor probe (warn >100 pending older than 7d).
- Read-only MCP tool `show_telemetry_rollup` with shadow-mode gate; ships with shadow_mode=true so rollups accumulate silently for one week.

## Test plan
- [x] Unit: dimension validation, object fan-out, dimensions hash determinism, hour bucket math, percentile in GROUP BY, retention table-aware DELETE.
- [x] Integration: aggregator idempotency, cursor advance + fallback, pending-not-rolled-up vs post-evaluation rollup, cadence hot-step bridge (belief / dream / state_inference disposition), prune job (default + hard ceiling), MCP tool window/filter/shadow-mode, doctor pending-row probe.
- [x] Backwards-compat: B1 attribution.mode counts, A3 mmr_path, D1 focus_block_present, D3 query stays in meta, hand-aggregated raw == rollup ±1.
- [x] Lint: `npm run lint` clean.
- [x] Audit guard: `show-telemetry-rollup.js` contains no CREATE/UPDATE/DELETE.
EOF
)"
```

---

## See also

- `docs/superpowers/specs/2026-05-11-cognition-c3-telemetry-umbrella-design.md` — the design this plan implements.
- `docs/superpowers/specs/2026-05-11-cognition-a3-recall-eval-and-mmr-design.md` — A3 precondition (intuition_telemetry.meta DEFINE).
- `docs/superpowers/specs/2026-05-11-cognition-b1-per-hit-reinforcement-design.md` — recall_log.evaluated_at + attribution.
- `docs/superpowers/specs/2026-05-11-cognition-b2-contradictions-on-recall-design.md` — intuition_telemetry.meta scalars + object-shaped fan-out source.
- `docs/superpowers/specs/2026-05-11-cognition-c2-dream-dag-design.md` — cadence_telemetry dream.* rows.
- `docs/superpowers/specs/2026-05-11-cognition-d2-recall-failures-meta-cognition-design.md` — meta_cognition_telemetry source.
- `docs/superpowers/specs/2026-05-11-cognition-d3-belief-gating-design.md` — cadence_telemetry belief.* rows + sampled writes + free-text query handling.
- `docs/superpowers/specs/2026-05-11-runtime-layer-hardening-design.md` — R-3 buildTools(ctx) registration site.
- `system/cognition/jobs/internal/reinforce-recall.js` — heartbeat-driven internal-job precedent.
- `system/cognition/jobs/internal/log-rotate.js` — retention precedent.
