# Robin v2 Phase 4b.3 — Predictions + Calibration

**Status:** Design (pre-implementation)
**Date:** 2026-05-10
**Phase:** 4b.3 (third sub-phase of Phase 4b)
**Predecessors:** Phase 2c (Dream pipeline), Phase 4b.2 (comm-style synthesis pattern, profile singleton).

---

## 1. Goal

Track the agent's falsifiable predictions, resolve them with actual outcomes, and compute per-kind accuracy over time. Surface calibration in AGENTS.md so the agent knows how much to trust its own future predictions.

## 2. Surface

Three new MCP tools, one new Dream step, two CLI commands, one new singleton row for calibration summary.

**Tools the agent calls:**
- `predict({statement, kind, confidence, expected_resolution_at?})` — record a falsifiable claim.
- `resolve_prediction({id, correct, actual_outcome?})` — record the outcome when known.
- `list_open_predictions({kind?, older_than_days?})` — find predictions awaiting resolution (lets the agent prompt the user).

**Dream step** runs nightly, computes per-kind calibration from resolved predictions, writes to `profile:singleton.calibration`.

**CLI:**
- `robin predictions list [--open|--resolved] [--kind <k>]`
- `robin predictions resolve <id> <correct|incorrect> [<actual>]`
- `robin calibration` — print the calibration summary.

**AGENTS.md** gets a `<!-- robin-calibration:start -->` block showing per-kind accuracy + the instruction to call `predict` when making falsifiable claims.

## 3. Out of scope

- **Per-confidence-bucket calibration curves** (e.g. "predictions with confidence 0.8 are correct 80% of the time"). Just per-kind accuracy + sample count in v1. Adds later.
- **Proactive outcome-check reminders** (Dream notices a 7-day-old open prediction and prompts the user). Defer — agent can opportunistically call `list_open_predictions`.
- **`kind` taxonomy enforcement.** `kind` is a free-form string; agent picks names like `duration`, `fact_recall`, `preference_guess`. AGENTS.md suggests common ones but doesn't restrict.

## 4. Schema (migration 0014)

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
DEFINE INDEX predictions_kind ON predictions FIELDS kind;
DEFINE INDEX predictions_open ON predictions FIELDS resolved_at;

DEFINE FIELD calibration ON profile TYPE option<object> FLEXIBLE;
```

`profile.calibration` shape:
```ts
{
  by_kind: {
    [kind: string]: {
      resolved: number,
      correct: number,
      accuracy: number,   // correct / resolved
    }
  },
  total_open: number,
  total_resolved: number,
  last_computed_at: Date,
}
```

## 5. Helpers (`src/jobs/predictions.js`)

```ts
recordPrediction(db, { statement, kind, confidence, expected_resolution_at? })
  → Promise<{ id: string }>
resolvePrediction(db, { id, correct, actual_outcome? })
  → Promise<{ ok: boolean, reason?: string }>
listOpenPredictions(db, { kind?, older_than_days? })
  → Promise<row[]>
listAllPredictions(db, { kind?, resolved? })
  → Promise<row[]>
computeCalibration(db) → Promise<calibration_object>
setCalibration(db, calibration) → Promise<void>
getCalibration(db) → Promise<calibration_object | null>
```

## 6. Dream step

`src/dream/step-calibration.js` — pure math, no LLM:

1. Query all resolved predictions: `SELECT kind, correct FROM predictions WHERE resolved_at IS NOT NONE`.
2. Group by `kind`. For each: `accuracy = correct / resolved`.
3. Also count `total_open` (resolved_at IS NONE).
4. UPSERT `profile:singleton SET calibration = {by_kind, total_open, total_resolved, last_computed_at: now}`.

Fail-soft per existing Dream-step pattern.

## 7. MCP tools

### `predict`
```ts
{
  name: 'predict',
  description: 'Record a falsifiable claim about the future or a verifiable fact. Use when you say "this will take ~30 min" or "you usually prefer X" — anything the user (or you) can later check.',
  inputSchema: {
    type: 'object',
    properties: {
      statement: { type: 'string' },
      kind: { type: 'string' },
      confidence: { type: 'number', minimum: 0, maximum: 1 },
      expected_resolution_at: { type: 'string' }   // ISO8601 optional
    },
    required: ['statement', 'kind', 'confidence']
  }
}
```

### `resolve_prediction`
```ts
{
  name: 'resolve_prediction',
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string' },
      correct: { type: 'boolean' },
      actual_outcome: { type: 'string' }
    },
    required: ['id', 'correct']
  }
}
```

### `list_open_predictions`
```ts
{
  name: 'list_open_predictions',
  inputSchema: {
    type: 'object',
    properties: {
      kind: { type: 'string' },
      older_than_days: { type: 'integer', minimum: 1 }
    }
  },
  handler: returns { predictions: [...] }
}
```

## 8. CLI

```
robin predictions list [--open|--resolved] [--kind <k>]
robin predictions resolve <id> <correct|incorrect> [<actual>]
robin calibration
```

Each CLI command uses the existing daemon-request pattern (rocksdb open is fine for list since it's read-only; resolve goes through daemon endpoint).

## 9. Daemon endpoints

- `/internal/predictions/resolve` POST → `{id, correct, actual_outcome?}` → calls `resolvePrediction`. Returns its result.
- `/internal/calibration/refresh` POST → empty body → calls `computeCalibration` + `setCalibration`. Returns the computed object.

(`predict` is agent-only via MCP, not CLI-exposed.)

## 10. AGENTS.md

```
## Calibration

Your past predictions (synthesized nightly):
- duration: 65% accurate (n=20)
- fact_recall: 88% accurate (n=12)
- preference_guess: 50% accurate (n=8)
- total_open: 5 predictions awaiting resolution

When you make a falsifiable claim — "this will take 30 min", "you
usually prefer terse summaries", "the meeting is at 3pm" — call
`predict({statement, kind, confidence})` so calibration can improve.

Common kinds: `duration`, `fact_recall`, `preference_guess`,
`identity` (who is X), `event_timing` (when is X). Pick whichever
matches; agent decides taxonomy.

When the outcome becomes known — user says "actually it took 2 hours"
— call `resolve_prediction({id, correct, actual_outcome})`. You can
call `list_open_predictions()` to find predictions you might want to
follow up on.

If calibration shows accuracy < 50% for a kind, treat new predictions
in that kind with low confidence (≤ 0.5).
```

Static when calibration not yet computed: "No calibration data yet — make some predictions and resolve their outcomes."

## 11. Tests

**Unit:**
- `predictions-helpers.test.js` — record/resolve/list/listAll round-trip; computeCalibration math; getCalibration null when unset.
- `predict-tool.test.js`, `resolve-prediction-tool.test.js`, `list-open-predictions-tool.test.js` — MCP tool shapes + handler behavior.
- `predictions-cli.test.js` — list/resolve via daemon-request stubs.
- `calibration-cli.test.js` — show via getCalibration stub.
- `agents-md-calibration.test.js` — block renders populated + null forms.

**Integration:**
- `predictions-roundtrip.test.js` — `predict` → DB row → `resolve_prediction` → `computeCalibration` → AGENTS.md regen reflects accuracy.

Approx test count: ~25 unit + 1 integration. Brings suite to ~1062.

## 12. Risk register

- **Agent never calls predict.** Calibration stays empty. AGENTS.md surfaces "no data yet" — same fail-soft pattern as comm-style.
- **Agent over-predicts.** Every claim triggers a predict call, table grows fast. Mitigation: the prompt instructs "falsifiable claims only" — agent self-limits. If it goes wild, user prunes via CLI (future polish).
- **Calibration is misleading on small N.** If only 2 resolved predictions exist for `duration`, "100% accurate" is meaningless. AGENTS.md should note `(n=2)` so the agent reads accordingly.

## 13. Phase exit criteria

- Migration 0014 applies.
- `predict` writes a row; `resolve_prediction` flips it; `list_open_predictions` returns open ones.
- Dream step computes `profile.calibration` correctly from a few seeded rows.
- AGENTS.md block renders.
- All tests green.

## 14. Plan: ~10 tasks across 5 waves

1. Migration 0014 + helpers (predictions + calibration)
2. `predict` MCP tool
3. `resolve_prediction` MCP tool
4. `list_open_predictions` MCP tool
5. Dream step-calibration
6. CLI predictions list+resolve
7. CLI calibration show
8. Daemon wiring + MCP registration + endpoints + AGENTS.md block
9. Integration roundtrip
