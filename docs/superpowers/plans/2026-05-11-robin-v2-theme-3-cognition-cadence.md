# Theme 3 — Cognition cadence · Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Trigger-driven cognition for three dream steps (`reflection`, `comm-style`, `calibration`) with cost-budget enforcement. Cursor-aware nightly pipeline avoids double-processing. Bring correction-to-rule-update p50 latency from ~12h to ≤10min while staying within ±20% of today's token envelope.

**Architecture:** Trigger queue (`dream_triggers`) + heartbeat consumer + per-step cursor + rolling 24h token budget. Producers: reinforcement loop, biographer, foresight, manual MCP. Only the three trigger-eligible steps run on triggers; others stay nightly.

**Tech Stack:** Node.js 18+, SurrealDB 3.0.5.

**Spec:** `docs/superpowers/specs/2026-05-11-robin-v2-theme-3-cognition-cadence-design.md`

**Dependencies:** `feat/surrealdb-improvements`. Co-located producer with Theme 2a in `reinforcement.js`.

---

## File structure

| File | Responsibility |
|---|---|
| `src/schema/migrations/0001-init.surql` | `dream_triggers`, `cadence_telemetry`, seed configs |
| `src/dream/cursors.js` (new) | `getCursor`, `advanceCursor`, `peekCursor` |
| `src/dream/dispatch.js` (new) | `dispatchStep(db, host, stepName, opts)` — single entry per step |
| `src/dream/budget.js` (new) | `currentBudget`, `deriveBaselineBudget`, `estimateStepCost` |
| `src/daemon/cadence-consumer.js` (new) | Heartbeat phase impl |
| `src/recall/reinforcement.js` (modify) | Write trigger on `outcome='corrected'` |
| `src/capture/biographer.js` (modify) | Trigger on correction event + tone-shift |
| `src/memory/foresight.js` (modify) | Trigger on prediction resolution |
| `src/dream/pipeline.js` (modify) | Read cursors; pass `since`; advance |
| `src/dream/{step-reflection,step-comm-style,step-calibration}.js` (modify) | Accept `since`; report tokens + processed_until |
| `src/daemon/server.js` (modify) | Register cadence-consumer heartbeat phase |
| `src/mcp/tools/run-dream.js` (modify) | Write trigger row |

---

## Phase 1 — Schema + utilities

### Task 1: Schema additions

**Files:** `src/schema/migrations/0001-init.surql`

- [ ] **Step 1: Append**

```surql
DEFINE TABLE dream_triggers SCHEMAFULL TYPE NORMAL;
DEFINE FIELD step         ON dream_triggers TYPE string;
DEFINE FIELD reason       ON dream_triggers TYPE string;
DEFINE FIELD source_id    ON dream_triggers TYPE option<record>;
DEFINE FIELD requested_at ON dream_triggers TYPE datetime DEFAULT time::now() READONLY;
DEFINE FIELD processed_at ON dream_triggers TYPE option<datetime>;
DEFINE FIELD outcome      ON dream_triggers TYPE option<string>;
DEFINE FIELD meta         ON dream_triggers TYPE option<object> FLEXIBLE;
DEFINE INDEX dt_pending   ON dream_triggers FIELDS processed_at, requested_at;
DEFINE INDEX dt_step      ON dream_triggers FIELDS step, requested_at;

DEFINE TABLE cadence_telemetry SCHEMAFULL TYPE NORMAL;
DEFINE FIELD step         ON cadence_telemetry TYPE string;
DEFINE FIELD trigger_id   ON cadence_telemetry TYPE option<record<dream_triggers>>;
DEFINE FIELD ts           ON cadence_telemetry TYPE datetime DEFAULT time::now() READONLY;
DEFINE FIELD tokens_in    ON cadence_telemetry TYPE int DEFAULT 0;
DEFINE FIELD tokens_out   ON cadence_telemetry TYPE int DEFAULT 0;
DEFINE FIELD duration_ms  ON cadence_telemetry TYPE int;
DEFINE FIELD success      ON cadence_telemetry TYPE bool;
DEFINE FIELD error        ON cadence_telemetry TYPE option<string>;
DEFINE INDEX ct_step_ts   ON cadence_telemetry FIELDS step, ts;
DEFINE INDEX ct_ts        ON cadence_telemetry FIELDS ts;

UPSERT runtime:cadence.config CONTENT {
  value: {
    daily_token_budget: null,
    budget_safety_margin: 0.20,
    trigger_consumer_enabled: true,
    trigger_ttl_days: 7,
    consume_batch_size: 20,
    steps: {
      reflection:   { trigger_eligible: true,  debounce_minutes: 5,  max_per_hour: 4, max_per_day: 12 },
      'comm-style': { trigger_eligible: true,  debounce_minutes: 30, max_per_hour: 2, max_per_day: 6 },
      calibration:  { trigger_eligible: true,  debounce_minutes: 60, max_per_hour: 1, max_per_day: 4 },
      knowledge:    { trigger_eligible: false },
      patterns:     { trigger_eligible: false },
      threads:      { trigger_eligible: false },
      profile:      { trigger_eligible: false },
      'scope-cleanup': { trigger_eligible: false },
      compaction:   { trigger_eligible: false }
    }
  }
};

UPSERT runtime:cadence.cursors CONTENT { value: {} };
```

- [ ] **Step 2: Run migration → clean; commit**

```bash
git commit -m "feat(schema): dream_triggers + cadence_telemetry + configs"
```

### Task 2: cursors.js

**Files:** `src/dream/cursors.js`, `tests/unit/cadence-cursor.test.js`

- [ ] **Step 1: Failing test**

```js
test('cursors: get returns null initially; advance sets; get returns set value', async () => {
  const db = await openMemDb();
  assert.equal(await getCursor(db, 'reflection'), null);
  const t = new Date();
  await advanceCursor(db, 'reflection', t);
  const got = await getCursor(db, 'reflection');
  assert.equal(got.getTime(), t.getTime());
});
```

- [ ] **Step 2: Implement**

```js
// src/dream/cursors.js
import { surql } from 'surrealdb';

export async function getCursor(db, step) {
  const [rows] = await db.query(surql`SELECT VALUE value.${step} FROM runtime:cadence.cursors`).collect();
  const v = rows?.[0];
  return v ? new Date(v) : null;
}

export async function advanceCursor(db, step, ts) {
  await db.query(surql`
    UPDATE runtime:cadence.cursors SET value.${step} = ${ts.toISOString()}
  `).collect();
}
```

(The `value.${step}` interpolation may need adjustment for SurrealDB's set-by-key syntax — alternative: read full value, modify, write back. Test pins behavior.)

- [ ] **Step 3: Run → pass; commit**

```bash
git commit -m "feat(dream): cursors.js get/advance"
```

### Task 3: budget.js

**Files:** `src/dream/budget.js`, `tests/unit/cadence-budget.test.js`

- [ ] **Step 1: Failing test**

```js
test('estimateStepCost returns median of recent successful runs', async () => {
  const db = await openMemDb();
  // seed 5 successful runs with tokens
  for (const t of [1000, 2000, 3000, 4000, 5000]) {
    await db.query(surql`CREATE cadence_telemetry CONTENT ${{ step: 'reflection', tokens_in: t/2, tokens_out: t/2, duration_ms: 100, success: true }}`).collect();
  }
  const est = await estimateStepCost(db, 'reflection');
  assert.equal(est, 3000);
});

test('currentBudget computes remaining = safe - consumed', async () => {
  // seed runs; assert remaining
});
```

- [ ] **Step 2: Implement**

```js
// src/dream/budget.js
import { surql } from 'surrealdb';

export async function currentBudget(db, cfg) {
  const daily = cfg.daily_token_budget ?? await deriveBaselineBudget(db);
  const safe = daily * (1 - cfg.budget_safety_margin);
  const [used] = await db.query(surql`
    SELECT VALUE math::sum(tokens_in + tokens_out) FROM cadence_telemetry
    WHERE ts > time::now() - 24h GROUP ALL
  `).collect();
  const consumed = used?.[0] ?? 0;
  return { daily: safe, consumed, remaining: safe - consumed };
}

export async function estimateStepCost(db, step) {
  const [rows] = await db.query(surql`
    SELECT VALUE (tokens_in + tokens_out) FROM cadence_telemetry
    WHERE step = ${step} AND success = true
    ORDER BY ts DESC LIMIT 10
  `).collect();
  const list = rows?.[0] ?? [];
  if (!list.length) return 2000;
  const sorted = [...list].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

export async function deriveBaselineBudget(db) {
  const [rows] = await db.query(surql`
    SELECT time::group(ts, 'day') AS day, math::sum(tokens_in + tokens_out) AS daily_total
    FROM cadence_telemetry WHERE ts > time::now() - 7d GROUP BY day
  `).collect();
  const list = rows?.[0] ?? [];
  if (!list.length) return 100_000;
  const totals = list.map(r => r.daily_total ?? 0).sort((a, b) => a - b);
  return totals[Math.floor(totals.length / 2)];
}
```

- [ ] **Step 3: Run → pass; commit**

```bash
git commit -m "feat(dream): budget.js currentBudget + estimateStepCost"
```

### Task 4: dispatch.js

**Files:** `src/dream/dispatch.js`, `tests/unit/dispatch.test.js`

- [ ] **Step 1: Failing test**

```js
test('dispatchStep routes to right step + passes since cursor', async () => {
  // stub each step impl; assert correct one called with since
});
```

- [ ] **Step 2: Implement**

```js
// src/dream/dispatch.js
import { dreamStepReflection } from './step-reflection.js';
import { dreamStepCommStyle } from './step-comm-style.js';
import { dreamStepCalibration } from './step-calibration.js';

const REGISTRY = {
  reflection: dreamStepReflection,
  'comm-style': dreamStepCommStyle,
  calibration: dreamStepCalibration,
};

export async function dispatchStep(db, host, stepName, opts = {}) {
  const fn = REGISTRY[stepName];
  if (!fn) throw new Error(`unknown step: ${stepName}`);
  return await fn(db, host, opts);
}
```

- [ ] **Step 3: Run → pass; commit**

```bash
git commit -m "feat(dream): dispatch.js entry point"
```

---

## Phase 2 — Step refactor (accept `since`, return tokens + processed_until)

### Task 5: step-reflection accepts `since`, returns shape

**Files:** `src/dream/step-reflection.js`, `tests/unit/step-reflection-cursor.test.js`

- [ ] **Step 1: Failing test**

```js
test('step-reflection with since processes only newer events', async () => {
  // seed 5 correction events: 3 before, 2 after `since`
  // call with since=t; assert only 2 LLM calls
});
test('step-reflection returns { tokens_in, tokens_out, processed_until }', async () => {
  // stub host.invokeLLM to return token counts
  // assert return shape
});
```

- [ ] **Step 2: Modify step-reflection.js**

Add a `since` filter to the source-query; ensure return value includes:

```js
return {
  candidates_created: ...,
  tokens_in: totalTokensIn,
  tokens_out: totalTokensOut,
  processed_until: latestTsProcessed,
};
```

- [ ] **Step 3: Run → pass; commit**

```bash
git commit -m "feat(dream): step-reflection accepts since cursor"
```

### Task 6: step-comm-style + step-calibration analogous

Same pattern as Task 5. Two tasks, one commit each.

```bash
git commit -m "feat(dream): step-comm-style accepts since cursor"
git commit -m "feat(dream): step-calibration accepts since cursor"
```

---

## Phase 3 — Cursor-aware nightly

### Task 7: pipeline.js reads/advances cursors

**Files:** `src/dream/pipeline.js`, `tests/integration/cursor-aware-nightly.test.js`

- [ ] **Step 1: Failing test**

```js
test('cursor-aware nightly: pre-set cursor → step processes only newer items', async () => {
  // …
});
```

- [ ] **Step 2: Wire cursors into pipeline**

```js
import { getCursor, advanceCursor } from './cursors.js';

const TRIGGER_ELIGIBLE = ['reflection', 'comm-style', 'calibration'];

export async function dreamProcess(db, host, embedder, opts = {}) {
  const summary = {};
  for (const step of ['knowledge', 'patterns', 'reflection', 'profile', 'threads', 'comm-style', 'calibration', 'scope-cleanup', 'compaction']) {
    try {
      const since = TRIGGER_ELIGIBLE.includes(step) ? await getCursor(db, step) : null;
      const result = await invokeStep(step, db, host, embedder, { ...(opts[step] ?? {}), since });
      summary[step] = result;
      if (since !== undefined && result?.processed_until) {
        await advanceCursor(db, step, new Date(result.processed_until));
      }
    } catch (e) {
      summary[step] = { error: e.message };
    }
  }
  // existing dreamed_at sweep + runtime:dream update
  return summary;
}
```

(`invokeStep` is a thin switch over step name; existing per-step calls inline this today.)

- [ ] **Step 3: Run → pass; commit**

```bash
git commit -m "feat(dream): cursor-aware nightly pipeline"
```

---

## Phase 4 — Producers

### Task 8: reinforcement.js writes trigger row on correction

**Files:** `src/recall/reinforcement.js`, `tests/unit/reinforcement-emits-trigger.test.js`

- [ ] **Step 1: Failing test**

```js
test("outcome='corrected' creates a dream_triggers row for reflection", async () => {
  // seed pending recall_log + correction event in window
  await evaluatePending(db);
  const [trigs] = await db.query(`SELECT * FROM dream_triggers WHERE step='reflection'`).collect();
  assert.equal(trigs.length, 1);
  assert.equal(trigs[0].reason, 'correction_landed');
});
```

- [ ] **Step 2: Modify reinforcement.js**

In the `corrected` branch:

```js
await db.query(surql`
  CREATE dream_triggers CONTENT { step: 'reflection', reason: 'correction_landed', source_id: ${row.id} }
`).collect();
```

(Co-located with Theme 2a's `evidence_ledger` refute write — both can batch.)

- [ ] **Step 3: Run → pass; commit**

```bash
git commit -m "feat(reinforcement): emit reflection trigger on corrected"
```

### Task 9: biographer triggers (correction event + tone-shift)

**Files:** `src/capture/biographer.js`

- [ ] **Step 1: Failing tests**

```js
test('biographer writes reflection trigger when event.meta.kind=correction', async () => { … });
test('biographer writes comm-style trigger when tone-shift threshold crossed', async () => { … });
```

- [ ] **Step 2: Implement triggers in biographer body**

```js
if (event.meta?.kind === 'correction') {
  await db.query(surql`CREATE dream_triggers CONTENT { step:'reflection', reason:'correction_event', source_id: ${event.id} }`).collect();
}
const toneShift = detectToneShift(output);   // existing or new helper
if (toneShift) {
  await db.query(surql`CREATE dream_triggers CONTENT { step:'comm-style', reason:'tone_shift_detected', source_id: ${event.id} }`).collect();
}
```

- [ ] **Step 3: Run → pass; commit**

```bash
git commit -m "feat(biographer): emit reflection + comm-style triggers"
```

### Task 10: foresight triggers calibration on resolution

**Files:** `src/memory/foresight.js`

- [ ] **Step 1: Failing test**

```js
test('foresight.resolve writes calibration trigger', async () => { … });
```

- [ ] **Step 2: Modify**

```js
export async function resolve(db, id, { correct, actual_outcome }) {
  await store.updateMemoMeta(db, id, { resolved_at: new Date(), correct, actual_outcome });
  await db.query(surql`
    CREATE dream_triggers CONTENT { step:'calibration', reason:'prediction_resolved', source_id: ${id} }
  `).collect();
}
```

- [ ] **Step 3: Run → pass; commit**

```bash
git commit -m "feat(foresight): emit calibration trigger on resolve"
```

### Task 11: run_dream MCP writes trigger

**Files:** `src/mcp/tools/run-dream.js`

- [ ] **Step 1: Test**

```js
test('run_dream({step}) writes a manual trigger row', async () => { … });
```

- [ ] **Step 2: Implement (or extend existing tool)**

```js
async handler({ step }) {
  await db.query(surql`CREATE dream_triggers CONTENT { step: ${step}, reason: 'manual' }`).collect();
  return { ok: true };
}
```

- [ ] **Step 3: Commit**

```bash
git commit -m "feat(mcp): run_dream writes manual trigger row"
```

---

## Phase 5 — Heartbeat consumer

### Task 12: cadence-consumer.js

**Files:** `src/daemon/cadence-consumer.js`, `tests/unit/cadence-consumer.test.js`

- [ ] **Step 1: Failing test (debounce + cap + budget)**

```js
test('consumer processes pending, marks outcomes correctly', async () => {
  // seed 5 pending triggers (mix of eligible/not, cap-hit/budget-ok/error)
  // call consumer
  // assert each marked appropriately
});

test('consumer decrements budget live; remaining triggers see updated budget', async () => {
  // …
});
```

- [ ] **Step 2: Implement (from spec §5)**

```js
// src/daemon/cadence-consumer.js
import { surql } from 'surrealdb';
import { dispatchStep } from '../dream/dispatch.js';
import { currentBudget, estimateStepCost } from '../dream/budget.js';
import { getCursor, advanceCursor } from '../dream/cursors.js';

async function readCadenceConfig(db) {
  const [r] = await db.query(`SELECT VALUE value FROM runtime:cadence.config`).collect();
  return r?.[0];
}

async function mark(db, id, outcome, reason) {
  await db.query(surql`
    UPDATE ${id} SET processed_at = time::now(), outcome = ${outcome}
    ${reason ? `, meta.cap_reason = '${reason}'` : ''}
  `).collect();
}

async function isDebounced(db, step, mins) {
  const [r] = await db.query(surql`
    SELECT count() AS n FROM cadence_telemetry
    WHERE step = ${step} AND success = true AND ts > time::now() - ${mins}m
    GROUP ALL
  `).collect();
  return (r?.[0]?.n ?? 0) > 0;
}

async function countWindow(db, step, windowSql) {
  const [r] = await db.query(surql`
    SELECT count() AS n FROM cadence_telemetry
    WHERE step = ${step} AND success = true AND ts > ${windowSql}
    GROUP ALL
  `).collect();
  return r?.[0]?.n ?? 0;
}

export async function consumePendingTriggers(db, host) {
  const cfg = await readCadenceConfig(db);
  if (!cfg?.trigger_consumer_enabled) return { skipped: 'disabled' };

  let budget = await currentBudget(db, cfg);
  if (budget.remaining <= 0) return { skipped: 'budget_exceeded' };

  // Expire stale pending
  await db.query(surql`
    UPDATE dream_triggers SET processed_at = time::now(), outcome = 'expired'
    WHERE processed_at IS NONE AND requested_at < time::now() - ${cfg.trigger_ttl_days}d
  `).collect();

  const [pending] = await db.query(surql`
    SELECT * FROM dream_triggers WHERE processed_at IS NONE
    ORDER BY requested_at ASC LIMIT ${cfg.consume_batch_size}
  `).collect();

  for (const trig of pending ?? []) {
    const stepCfg = cfg.steps[trig.step];
    if (!stepCfg?.trigger_eligible) { await mark(db, trig.id, 'capped', 'not_trigger_eligible'); continue; }
    if (await isDebounced(db, trig.step, stepCfg.debounce_minutes)) { await mark(db, trig.id, 'debounced'); continue; }
    if (await countWindow(db, trig.step, 'time::now() - 1h') >= stepCfg.max_per_hour) { await mark(db, trig.id, 'capped', 'hourly'); continue; }
    if (await countWindow(db, trig.step, 'time::now() - 1d') >= stepCfg.max_per_day)  { await mark(db, trig.id, 'capped', 'daily');  continue; }
    const estCost = await estimateStepCost(db, trig.step);
    if (estCost > budget.remaining) { await mark(db, trig.id, 'budget_exceeded'); continue; }

    const cursor = await getCursor(db, trig.step);
    const start = Date.now();
    try {
      const result = await dispatchStep(db, host, trig.step, { since: cursor });
      if (result?.processed_until) await advanceCursor(db, trig.step, new Date(result.processed_until));
      const used = (result.tokens_in ?? 0) + (result.tokens_out ?? 0);
      await db.query(surql`
        CREATE cadence_telemetry CONTENT ${{
          step: trig.step, trigger_id: trig.id,
          tokens_in: result.tokens_in ?? 0, tokens_out: result.tokens_out ?? 0,
          duration_ms: Date.now() - start, success: true,
        }}
      `).collect();
      await mark(db, trig.id, 'ran');
      budget.remaining -= used;
      if (budget.remaining <= 0) break;
    } catch (e) {
      await db.query(surql`
        CREATE cadence_telemetry CONTENT ${{
          step: trig.step, trigger_id: trig.id, duration_ms: Date.now() - start, success: false, error: e.message,
        }}
      `).collect();
      await mark(db, trig.id, 'error');
    }
  }
  return { processed: (pending ?? []).length };
}
```

- [ ] **Step 3: Run → pass; commit**

```bash
git commit -m "feat(daemon): cadence-consumer heartbeat phase"
```

### Task 13: Register consumer in daemon heartbeat

**Files:** `src/daemon/server.js`

- [ ] **Step 1: Add to heartbeat loop**

```js
import { consumePendingTriggers } from './cadence-consumer.js';

// inside the 60s heartbeat:
try { await consumePendingTriggers(db, host); } catch (e) { console.warn('[cadence-consumer]', e.message); }
```

- [ ] **Step 2: Integration test (end-to-end latency)**

```js
test('correction-to-reflection latency ≤ 60s', async () => {
  // start daemon with fake host
  // write correction event
  // wait ≤ 60s
  // assert cadence_telemetry row for reflection exists
});
```

- [ ] **Step 3: Commit**

```bash
git commit -m "feat(daemon): register cadence-consumer in heartbeat"
```

---

## Phase 6 — Gates + docs

### Task 14: Verification gates 1–14 from spec §9

1. Correction emits trigger (Task 8)
2. Consumer processes pending (Task 12)
3. Debounce works (Task 12)
4. Hourly cap (Task 12)
5. Daily cap (Task 12)
6. Budget cap (Task 12 + budget test)
7. Cursor advances correctly (Task 5)
8. Nightly cursor-aware (Task 7)
9. Failed step writes telemetry (Task 12)
10. Manual MCP trigger (Task 11)
11. Non-eligible step never dispatched (Task 12)
12. Baseline derivation accurate (Task 3)
13. TTL expiry (Task 12)
14. Correction-to-reflection latency (Task 13)

One commit per gate test.

### Task 15: Docs

- [ ] Update `docs/architecture.md` cadence section.
- [ ] Update `docs/faculties.md` dream section (triggered vs nightly subset, budget mechanics).

```bash
git commit -m "docs(cadence): triggered cognition + budget envelope"
```

## Self-review

- [ ] 14 spec gates covered.
- [ ] No placeholders.
- [ ] `dispatchStep`, `consumePendingTriggers`, `getCursor`, `advanceCursor`, `currentBudget`, `estimateStepCost` consistently named.
- [ ] Trigger-eligible step list (`reflection`, `comm-style`, `calibration`) matches spec.
- [ ] Daily caps × estimated cost ≤ baseline_budget × (1 - safety_margin).

## Final commit

```bash
git push -u origin feat/theme-3-cognition-cadence
gh pr create --title "Theme 3: Triggered cognition with cost budget"
```
