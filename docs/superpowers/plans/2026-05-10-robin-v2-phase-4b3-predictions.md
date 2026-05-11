# Phase 4b.3 — Predictions + Calibration — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development.

**Spec:** `docs/superpowers/specs/2026-05-10-robin-v2-phase-4b3-predictions-design.md` (commit `9adc8f4`).

**Coordination:** Avoid 4f territory. Stage by explicit path ONLY. Rename pass in working tree — don't touch files you didn't author.

---

## File map

**New:**
```
src/schema/migrations/0014-predictions.surql
src/jobs/predictions.js                     # all helpers (record/resolve/list/calibration)
src/dream/step-calibration.js
src/mcp/tools/predict.js
src/mcp/tools/resolve-prediction.js
src/mcp/tools/list-open-predictions.js
src/cli/commands/predictions-list.js
src/cli/commands/predictions-resolve.js
src/cli/commands/calibration-show.js
tests/unit/predictions-helpers.test.js
tests/unit/predict-tool.test.js
tests/unit/resolve-prediction-tool.test.js
tests/unit/list-open-predictions-tool.test.js
tests/unit/predictions-cli.test.js
tests/unit/calibration-cli.test.js
tests/unit/agents-md-calibration.test.js
tests/integration/predictions-roundtrip.test.js
```

**Modified (additive only):**
```
src/dream/pipeline.js          # invoke stepCalibration at end
src/daemon/server.js           # register 3 MCP tools + 2 /internal endpoints
src/cli/index.js               # predictions/calibration dispatcher branches
src/install/agents-md.js       # robin-calibration block
src/cli/commands/mcp-install.js # extend single-pass DB read to include calibration
```

---

## Waves

| Wave | Tasks | Parallel |
|---|---|---|
| 1 | 1 (migration + all helpers) | 1 |
| 2 | 2 (predict), 3 (resolve_prediction), 4 (list_open_predictions) | 3 |
| 3 | 5 (Dream step), 6 (CLI predictions), 7 (CLI calibration) | 3 |
| 4 | 8 (daemon wiring + AGENTS.md + endpoints) | 1 |
| 5 | 9 (integration roundtrip) | 1 |

---

## Task 1: Migration 0014 + `predictions.js` helpers

**Files:** `src/schema/migrations/0014-predictions.surql`, `src/jobs/predictions.js`, `tests/unit/predictions-helpers.test.js`.

**Migration:**
```sql
DEFINE TABLE predictions SCHEMAFULL;
DEFINE FIELD statement              ON predictions TYPE string;
DEFINE FIELD kind                   ON predictions TYPE string;
DEFINE FIELD confidence             ON predictions TYPE float ASSERT $value >= 0 AND $value <= 1;
DEFINE FIELD predicted_at           ON predictions TYPE datetime DEFAULT time::now() READONLY;
DEFINE FIELD expected_resolution_at ON predictions TYPE option<datetime>;
DEFINE FIELD resolved_at            ON predictions TYPE option<datetime>;
DEFINE FIELD correct                ON predictions TYPE option<bool>;
DEFINE FIELD actual_outcome         ON predictions TYPE option<string>;
DEFINE FIELD meta                   ON predictions TYPE option<object> FLEXIBLE;
DEFINE INDEX predictions_kind  ON predictions FIELDS kind;
DEFINE FIELD calibration ON profile TYPE option<object> FLEXIBLE;
```

**Helpers (`src/jobs/predictions.js`):**

```js
import { surql } from 'surrealdb';

export async function recordPrediction(db, { statement, kind, confidence, expected_resolution_at }) {
  const row = {
    statement,
    kind,
    confidence,
    expected_resolution_at: expected_resolution_at ? new Date(expected_resolution_at) : undefined,
  };
  const [rows] = await db.query(surql`CREATE predictions CONTENT ${row}`).collect();
  return { id: String(rows[0].id) };
}

export async function resolvePrediction(db, { id, correct, actual_outcome }) {
  const existing = await getPrediction(db, id);
  if (!existing) return { ok: false, reason: 'not_found' };
  if (existing.resolved_at) return { ok: false, reason: 'already_resolved' };
  await db
    .query(
      surql`UPDATE type::thing('predictions', ${id.replace(/^predictions:/, '')}) MERGE ${{
        resolved_at: new Date(),
        correct: !!correct,
        actual_outcome: actual_outcome ?? null,
      }}`,
    )
    .collect();
  return { ok: true };
}

export async function getPrediction(db, id) {
  const bareId = String(id).replace(/^predictions:/, '');
  const [rows] = await db
    .query(surql`SELECT * FROM type::thing('predictions', ${bareId})`)
    .collect();
  return rows?.[0] ?? null;
}

export async function listOpenPredictions(db, { kind, older_than_days } = {}) {
  let sql = `SELECT * FROM predictions WHERE resolved_at IS NONE`;
  const args = {};
  if (kind) {
    sql += ` AND kind = $kind`;
    args.kind = kind;
  }
  if (older_than_days) {
    const cutoff = new Date(Date.now() - older_than_days * 86_400_000);
    sql += ` AND predicted_at < $cutoff`;
    args.cutoff = cutoff;
  }
  sql += ` ORDER BY predicted_at DESC`;
  const [rows] = await db.query(sql, args).collect();
  return rows ?? [];
}

export async function listAllPredictions(db, { kind, resolved } = {}) {
  let sql = `SELECT * FROM predictions WHERE true`;
  const args = {};
  if (kind) {
    sql += ` AND kind = $kind`;
    args.kind = kind;
  }
  if (resolved === true) sql += ` AND resolved_at IS NOT NONE`;
  if (resolved === false) sql += ` AND resolved_at IS NONE`;
  sql += ` ORDER BY predicted_at DESC`;
  const [rows] = await db.query(sql, args).collect();
  return rows ?? [];
}

export async function computeCalibration(db) {
  const [resolved] = await db
    .query(surql`SELECT kind, correct FROM predictions WHERE resolved_at IS NOT NONE`)
    .collect();
  const [openRows] = await db
    .query(surql`SELECT count() AS n FROM predictions WHERE resolved_at IS NONE GROUP ALL`)
    .collect();
  const by_kind = {};
  for (const r of resolved ?? []) {
    const k = r.kind;
    if (!by_kind[k]) by_kind[k] = { resolved: 0, correct: 0, accuracy: 0 };
    by_kind[k].resolved += 1;
    if (r.correct) by_kind[k].correct += 1;
  }
  for (const k of Object.keys(by_kind)) {
    by_kind[k].accuracy =
      by_kind[k].resolved === 0 ? 0 : by_kind[k].correct / by_kind[k].resolved;
  }
  return {
    by_kind,
    total_open: openRows?.[0]?.n ?? 0,
    total_resolved: (resolved ?? []).length,
    last_computed_at: new Date(),
  };
}

export async function setCalibration(db, calibration) {
  await db
    .query(surql`UPSERT profile:singleton MERGE ${{ calibration }}`)
    .collect();
}

export async function getCalibration(db) {
  const [rows] = await db.query(surql`SELECT calibration FROM profile:singleton`).collect();
  return rows?.[0]?.calibration ?? null;
}
```

**Tests:** see Task 1 prompt — covers record/resolve/list/calibration math + null cases.

Commit message: `feat(4b.3): predictions migration 0014 + helpers (record/resolve/list/calibration)`.

---

## Task 2-4: Three MCP tool factories

Each is a standard factory pattern: `createXxxTool({db})` returning `{name, description, inputSchema, handler}`. See spec §7 for exact shapes.

**Task 2 — `predict`:** `src/mcp/tools/predict.js`. inputSchema: `{statement, kind, confidence, expected_resolution_at?}`. Handler calls `recordPrediction`, returns `{ok: true, id}`. Commit: `feat(4b.3): predict MCP tool`.

**Task 3 — `resolve_prediction`:** `src/mcp/tools/resolve-prediction.js`. inputSchema: `{id, correct, actual_outcome?}`. Handler calls `resolvePrediction`, returns its result. Commit: `feat(4b.3): resolve_prediction MCP tool`.

**Task 4 — `list_open_predictions`:** `src/mcp/tools/list-open-predictions.js`. inputSchema: `{kind?, older_than_days?}`. Handler calls `listOpenPredictions`, returns `{predictions: [...]}`. Commit: `feat(4b.3): list_open_predictions MCP tool`.

Each task includes a 3-test file (happy path, edge case, error case).

---

## Task 5: Dream step-calibration

`src/dream/step-calibration.js`:
```js
import { computeCalibration, setCalibration } from '../jobs/predictions.js';
export async function stepCalibration({ db }) {
  try {
    const c = await computeCalibration(db);
    await setCalibration(db, c);
    return { ok: true, total_resolved: c.total_resolved };
  } catch (e) {
    console.warn(`[dream] step-calibration: ${e.message}`);
    return { ok: false, reason: e.message };
  }
}
```

Wire into `src/dream/pipeline.js` AFTER stepCommStyle. Test: existing `dream-full-cycle` test should still pass (the new step is a no-op when predictions table is empty). Commit: `feat(4b.3): Dream pipeline runs calibration step`.

---

## Task 6: CLI `robin predictions list` + `resolve`

Standard CLI pattern with deps injection. `predictions list [--open|--resolved] [--kind <k>]` reads via `listAllPredictions`. `predictions resolve <id> <correct|incorrect> [<actual>]` POSTs to `/internal/predictions/resolve`.

Files: `src/cli/commands/predictions-list.js`, `src/cli/commands/predictions-resolve.js`. Append tests to `tests/unit/predictions-cli.test.js`. Commit: `feat(4b.3): robin predictions list + resolve CLI`.

---

## Task 7: CLI `robin calibration`

`src/cli/commands/calibration-show.js`. Reads via `getCalibration` (deps-injectable). Prints by-kind table + totals. New test `tests/unit/calibration-cli.test.js`. Commit: `feat(4b.3): robin calibration CLI`.

---

## Task 8: Daemon wiring + AGENTS.md + endpoints

Same pattern as 4b.2 Task 6:
- Register `createPredictTool`, `createResolvePredictionTool`, `createListOpenPredictionsTool` in `tools` array.
- Add `/internal/predictions/resolve` POST + `/internal/calibration/refresh` POST endpoints.
- Add `calibrationSection(calibration)` export to `src/install/agents-md.js`. Extend `agentsMdContent({integrations, jobs, commStyle, calibration})` signature. Insert `${calibrationSection(calibration)}` after the comm-style section.
- Modify `src/cli/commands/mcp-install.js`'s `readDbDataForAgentsMd` to also fetch calibration. Pass through to both AGENTS.md writes.
- Modify `src/cli/index.js`: add `predictions` and `calibration` dispatcher branches.
- New test `tests/unit/agents-md-calibration.test.js` (4 tests).
- Run mcp-end-to-end + scheduler-multi-integration to verify no regression.

Commit: `feat(4b.3): daemon wires predictions + AGENTS.md calibration block`.

---

## Task 9: Integration roundtrip

`tests/integration/predictions-roundtrip.test.js`: seed prediction → resolve → compute calibration → verify by_kind/totals → check `get_calibration` reflects it. Single test covers the lifecycle. Commit: `test(4b.3): integration roundtrip — predict → resolve → calibrate`.
