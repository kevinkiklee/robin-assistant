# Robin v2 — Theme 3: Cognition cadence

**Status:** Design (working draft; impl waits for `feat/surrealdb-improvements` merge)
**Date:** 2026-05-11
**Umbrella:** `2026-05-11-robin-v2-evolution-roadmap.md` (Theme 3)
**Depends on:** `2026-05-11-surrealdb-improvements-design.md` (engine swap; nothing structural)

## Why

A correction landing at 9 AM doesn't influence Robin until the next 4 AM dream run — roughly **19 hours of "Robin keeps making the same mistake while the correction sits in the chronicle."** That latency is the headline problem this theme solves.

The naïve fix — "run dream every 5 minutes" — would 100× LLM cost. The roadmap caps token spend at ±20% of today's nightly baseline (§4). The design must be selective, cost-aware, and idempotent.

## Goals

- Trigger-driven cognition for the subset of dream steps where it's high-value and bounded-cost (`reflection`, `comm-style`, `calibration`).
- Bring correction-to-rule-update p50 latency to ≤ 10 minutes.
- Stay within ±20% of today's 24h LLM token envelope.
- Cursor-aware nightly run that doesn't re-do work already handled by triggers (the cost discipline that keeps the envelope tight).
- Full per-step telemetry so the policy is tuneable from data, not vibes.

## Non-goals

- Replacing the nightly dream run — it stays as the deep-sleep batch for non-trigger-eligible steps and as the cursor-advance for the rest.
- Replacing the 5-min reinforcement loop — it stays; this theme adds the *next* layer of low-latency cognition above it.
- Event-driven `DEFINE EVENT` triggers firing dream steps inline (rejected; runs inside the inserting transaction, holds LLM-bound work).
- Per-step LLM model selection / cost optimisation (separate work).
- Making every step trigger-eligible (cost-prohibitive; some steps benefit from batched cross-day inputs).

## Anchoring decisions

**Why a queue + heartbeat-consumer, not inline:**
- Decouples producer from consumer; producer side stays fail-soft.
- Survives daemon crashes — pending triggers persist.
- Audit trail (which trigger fired when, was it debounced, did the step succeed).
- Mirrors how Robin already handles biographer: event → queue → subprocess.

**Why only three trigger-eligible steps:**
- Cost. Trigger-eligible × N triggers/day must stay sub-baseline; selecting cheap, focused steps preserves the envelope.
- Idempotence. Each trigger-eligible step has a clean cursor (process events newer than X, advance X); steps like `knowledge` make broader judgements that don't decompose into a cursor cleanly.
- Latency value. `reflection`, `comm-style`, `calibration` are the steps a user would notice running late. `knowledge` / `narrative` benefit from batched cross-day inputs anyway.

**Why cursor-aware nightly, not "skip if recently run":**
- Skipping a step entirely throws away its non-trigger-eligible work (e.g., reflection on events that never triggered).
- Cursor-aware nightly continues from where triggers stopped — strict subset of nightly's previous work.
- Net cost stays within envelope by construction: today's full nightly = triggered + remainder. Tomorrow's = triggered + (full minus triggered) = same.

**Why a daily token budget, not per-step:**
- LLM cost varies widely between steps; one global budget gives the consumer a clear signal.
- `cadence_telemetry` per-step rows let the user (or Theme 4 introspection) drill down.

**Why derive baseline from 7-day rolling average vs hard-coded:**
- Robin's activity varies. A static budget either over-provisions (waste) or under-provisions (drops triggers). Rolling baseline self-tunes.
- Bootstrap problem: until 7 days of telemetry land, a configured `daily_token_budget` value is used; if null, a conservative default applies.

## Section 1 — Architecture

```
producers (reinforcement loop, biographer, predictions, MCP)
       │
       ▼
  dream_triggers   ← append-only queue, processed_at IS NONE = pending
       │
       ▼
 heartbeat consumer (every 60s)
       │
       ├─ check debounce / hourly cap / daily cap / daily token budget
       ├─ dispatch eligible step with since-cursor
       ├─ write cadence_telemetry row
       └─ advance runtime:cadence.cursors[step]
       │
       ▼
   nightly cron (4 AM) — cursor-aware: processes only un-cursored ranges
```

## Section 2 — Schema additions

```surql
DEFINE TABLE dream_triggers SCHEMAFULL TYPE NORMAL;
DEFINE FIELD step         ON dream_triggers TYPE string;          -- 'reflection' | 'comm-style' | 'calibration' | …
DEFINE FIELD reason       ON dream_triggers TYPE string;          -- 'correction_landed' | 'prediction_resolved' | 'manual' | …
DEFINE FIELD source_id    ON dream_triggers TYPE option<record>;  -- the row that triggered (correction event, resolved prediction, …)
DEFINE FIELD requested_at ON dream_triggers TYPE datetime DEFAULT time::now() READONLY;
DEFINE FIELD processed_at ON dream_triggers TYPE option<datetime>;
DEFINE FIELD outcome      ON dream_triggers TYPE option<string>;  -- 'ran' | 'debounced' | 'capped' | 'budget_exceeded' | 'error' | 'expired'
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
```

## Section 3 — Configuration

### `runtime:cadence.config`

```json
{
  "daily_token_budget": null,
  "budget_safety_margin": 0.20,
  "trigger_consumer_enabled": true,
  "trigger_ttl_days": 7,
  "consume_batch_size": 20,
  "steps": {
    "reflection":   { "trigger_eligible": true,  "debounce_minutes": 5,  "max_per_hour": 4, "max_per_day": 12 },
    "comm-style":   { "trigger_eligible": true,  "debounce_minutes": 30, "max_per_hour": 2, "max_per_day": 6 },
    "calibration":  { "trigger_eligible": true,  "debounce_minutes": 60, "max_per_hour": 1, "max_per_day": 4 },
    "knowledge":    { "trigger_eligible": false },
    "patterns":     { "trigger_eligible": false },
    "threads":      { "trigger_eligible": false },
    "profile":      { "trigger_eligible": false },
    "scope-cleanup":{ "trigger_eligible": false },
    "compaction":   { "trigger_eligible": false }
  }
}
```

### `runtime:cadence.cursors`

```json
{
  "reflection":  "2026-05-11T09:23:00Z",
  "comm-style":  "2026-05-11T08:00:00Z",
  "calibration": "2026-05-11T04:00:00Z"
}
```

One per trigger-eligible step. Tracks the latest `ts` the step has processed.

## Section 4 — Producers

| Source | Step | Reason |
|---|---|---|
| `reinforcement.js` (`recall_log → outcome='corrected'`) | `reflection` | `correction_landed` |
| `biographer.js` (event with `meta.kind='correction'`) | `reflection` | `correction_event` |
| `biographer.js` (tone-shift heuristic crosses threshold) | `comm-style` | `tone_shift_detected` |
| `foresight.js` (resolve / heartbeat sweep of due predictions) | `calibration` | `prediction_resolved` |
| MCP `run_dream({step})` | varies | `manual` |

Each producer writes one row:

```surql
CREATE dream_triggers CONTENT {
  step: $step,
  reason: $reason,
  source_id: $source_id
};
```

Producer-side fail-soft: trigger-write failure is logged but doesn't abort the upstream operation.

## Section 5 — Heartbeat consumer

```js
// src/daemon/cadence-consumer.js
export async function consumePendingTriggers(db, host) {
  const cfg = await readCadenceConfig(db);
  if (!cfg.trigger_consumer_enabled) return { skipped: 'disabled' };

  let budget = await currentBudget(db, cfg);   // re-decremented per dispatch below
  if (budget.remaining <= 0) return { skipped: 'budget_exceeded' };

  // Expire stale pending triggers first
  await db.query(surql`
    UPDATE dream_triggers SET processed_at = time::now(), outcome = 'expired'
    WHERE processed_at IS NONE AND requested_at < time::now() - ${cfg.trigger_ttl_days}d
  `);

  const [pending] = await db.query(surql`
    SELECT * FROM dream_triggers WHERE processed_at IS NONE
    ORDER BY requested_at ASC LIMIT ${cfg.consume_batch_size}
  `).collect();

  for (const trig of pending) {
    const stepCfg = cfg.steps[trig.step];
    if (!stepCfg?.trigger_eligible) { await mark(db, trig.id, 'capped', 'not_trigger_eligible'); continue; }
    if (await isDebounced(db, trig.step, stepCfg.debounce_minutes)) { await mark(db, trig.id, 'debounced'); continue; }
    if (await isOverHourlyCap(db, trig.step, stepCfg.max_per_hour)) { await mark(db, trig.id, 'capped', 'hourly'); continue; }
    if (await isOverDailyCap(db, trig.step, stepCfg.max_per_day)) { await mark(db, trig.id, 'capped', 'daily'); continue; }
    const estCost = await estimateStepCost(db, trig.step);
    if (estCost > budget.remaining) { await mark(db, trig.id, 'budget_exceeded'); continue; }

    const cursor = await getCursor(db, trig.step);
    const start = Date.now();
    try {
      const result = await dispatchStep(db, host, trig.step, { since: cursor });
      await advanceCursor(db, trig.step, result.processed_until);
      const used = (result.tokens_in ?? 0) + (result.tokens_out ?? 0);
      await writeCadenceTelemetry(db, {
        step: trig.step, trigger_id: trig.id,
        tokens_in: result.tokens_in ?? 0, tokens_out: result.tokens_out ?? 0,
        duration_ms: Date.now() - start, success: true,
      });
      await mark(db, trig.id, 'ran');
      budget.remaining -= used;                 // decrement live budget for subsequent triggers
      if (budget.remaining <= 0) break;         // halt the loop; remaining triggers stay pending for next tick
    } catch (e) {
      await writeCadenceTelemetry(db, { step: trig.step, trigger_id: trig.id, success: false, error: e.message, duration_ms: Date.now() - start });
      await mark(db, trig.id, 'error');
    }
  }
}
```

## Section 6 — Cursor-aware nightly

`src/dream/pipeline.js` reads cursors, passes them through to each step:

```js
const cursors = await readCadenceCursors(db);
try {
  const since = cursors.reflection;
  summary.reflection = await dreamStepReflection(db, host, { since, ...opts.reflection });
  if (summary.reflection.processed_until) {
    await advanceCursor(db, 'reflection', summary.reflection.processed_until);
  }
} catch (e) { summary.reflection = { error: e.message }; }
// (analogous for comm-style, calibration)

// non-trigger-eligible steps unchanged
summary.knowledge = await dreamStepKnowledge(db, host, embedder, opts.knowledge);
// …
```

Steps that previously ignored their `since` opt continue to do so safely; trigger-eligible steps must respect it.

## Section 7 — Budget enforcement

```js
async function currentBudget(db, cfg) {
  const daily = cfg.daily_token_budget ?? await deriveBaselineBudget(db);
  const safe = daily * (1 - cfg.budget_safety_margin);

  const [used] = await db.query(surql`
    SELECT VALUE math::sum(tokens_in + tokens_out) FROM cadence_telemetry
    WHERE ts > time::now() - 24h GROUP ALL
  `).collect();
  const consumed = used[0] ?? 0;

  return { daily: safe, consumed, remaining: safe - consumed };
}

async function deriveBaselineBudget(db) {
  // Sum tokens per day for the last 7 days; return the median daily total.
  // Group by calendar day (UTC) so trigger-driven and nightly tokens both count.
  const [rows] = await db.query(surql`
    SELECT
      time::group(ts, 'day') AS day,
      math::sum(tokens_in + tokens_out) AS daily_total
    FROM cadence_telemetry
    WHERE ts > time::now() - 7d
    GROUP BY day
  `).collect();
  if (!rows[0]?.length) return 100_000;                 // conservative fallback
  const totals = rows[0].map(r => r.daily_total ?? 0).sort((a, b) => a - b);
  return totals[Math.floor(totals.length / 2)];          // simple median
}

async function estimateStepCost(db, step) {
  const [rows] = await db.query(surql`
    SELECT VALUE (tokens_in + tokens_out) FROM cadence_telemetry
    WHERE step = ${step} AND success = true
    ORDER BY ts DESC LIMIT 10
  `).collect();
  if (!rows[0]?.length) return 2000; // conservative for unseen step
  return median(rows[0]);
}
```

## Section 8 — Cost envelope (worked example)

Caps and budget are *layered* limits. Caps are soft (sanity ceilings per step). Budget is the hard ceiling (daily_token_budget × (1 − safety_margin)). Defaults are chosen so that **worst-case-at-all-caps** stays under the budget.

Assumptions (conservative for a single-user instance):
- Today's nightly baseline: ~100k tokens/day.
- Trigger costs (median, from telemetry once it lands): reflection ~2k, comm-style ~1.5k, calibration ~500.

**Typical day:**
- ~10 corrections/day → 10 × 2k = 20k triggered reflection tokens.
- ~3 tone-shift triggers → 3 × 1.5k = 4.5k.
- ~2 calibration → 2 × 500 = 1k.
- Triggered total: ~25.5k.
- Nightly reduction from cursors (reflection/comm-style/calibration covered intraday): ~30k.
- **Net daily total: 100k − 30k + 25.5k ≈ 95.5k.** Slightly under baseline.

**Worst case at all caps:**
- reflection: 12 × 2k = 24k.
- comm-style: 6 × 1.5k = 9k.
- calibration: 4 × 500 = 2k.
- Triggered total at caps: 35k.
- Nightly drops to ~70k (reflection/comm-style/calibration cursors saturated).
- **Worst-case total: 70k + 35k = 105k = +5% over baseline.** Within ±20% envelope by construction.

**Hard ceiling:** if reality outpaces caps (corrections burst above 12/day), the budget kicks in and skips. Budget is `daily_token_budget × (1 − 0.20) = 80k` if `daily_token_budget = 100k`. Mid-loop budget decrement ensures the consumer stops within one tick of exhausting.

The caps in `runtime:cadence.config.steps.*.max_per_day` are tuned so cap-totals × estimated-cost-per-run ≤ trigger budget. **Re-tune caps if `estimateStepCost` median rises significantly** — Theme 4 will surface this as a `robin doctor` warning.

## Section 8.5 — Idempotence under crash

If the daemon crashes between `dispatchStep` and `mark(trig.id, 'ran')`, the trigger row stays `processed_at IS NONE` and gets re-dispatched on the next consumer tick. This is safe by design:

- Trigger-eligible steps process a cursor-bounded range. If the cursor was advanced before the crash, re-dispatch processes an empty range (no-op). If the cursor wasn't advanced (crash before `advanceCursor`), re-dispatch repeats the same range — at most one extra LLM call per crash, and the step's emissions are idempotent (memos dedupe by `content_hash`; rule_candidates dedupe by signature; etc.).
- `cadence_telemetry` may show two rows for one crash-recovered trigger. Acceptable; the audit trail honestly reflects what happened.

Mitigations beyond v1: wrap dispatch + mark in a transaction, or use an in-process lock — both add complexity and aren't justified by the failure mode's rarity.

## Section 9 — Verification gates

1. **Correction emits trigger:** `outcome='corrected'` write in `reinforcement.js` creates exactly one `dream_triggers` row with `step='reflection'`, `reason='correction_landed'`.
2. **Consumer processes pending:** simulate 5 pending triggers; consumer marks each with correct outcome.
3. **Debounce works:** two triggers for same step within `debounce_minutes` → first runs; second `debounced`.
4. **Hourly cap:** 7th trigger of hour-capped step (max=6) → `capped` with reason `'hourly'`.
5. **Daily cap:** 31st trigger of day-capped step → `capped` with reason `'daily'`.
6. **Budget cap:** simulated 24h token use at 95% of safe budget; new trigger estimated at >5% remaining → `budget_exceeded`.
7. **Cursor advances correctly:** step processes events from `cursor` to `now`; cursor updates to last processed `ts`.
8. **Nightly cursor-aware:** step with cursor at `now - 2h` processes only events older than that cursor / since-cursor (no double processing).
9. **Failed step writes telemetry:** simulated step error → `cadence_telemetry` row with `success=false`; trigger marked `error`.
10. **Manual MCP trigger:** `run_dream({step:'reflection'})` → trigger row; consumer dispatches.
11. **Non-trigger-eligible step never dispatched:** trigger written for `step='knowledge'` → consumer marks `capped` with reason `'not_trigger_eligible'`.
12. **Baseline derivation:** with 7 days of telemetry, `deriveBaselineBudget` returns median within ±10% of actual nightly token use.
13. **TTL expiry:** trigger with `requested_at < now - trigger_ttl_days` → marked `'expired'` on next consumer tick.
14. **Correction-to-reflection latency:** end-to-end test: write a `correction` event; within 60s a `cadence_telemetry` row for reflection with `success=true` exists.

## Section 10 — File-by-file changes

**Created:**

- `src/daemon/cadence-consumer.js`
- `src/dream/cursors.js` — `getCursor`, `advanceCursor`, `peekCursor`.
- `src/dream/dispatch.js` — `dispatchStep(db, host, stepName, opts)`.
- `src/dream/budget.js` — `currentBudget`, `deriveBaselineBudget`, `estimateStepCost`.
- `tests/unit/cadence-consumer.test.js`
- `tests/unit/cadence-budget.test.js`
- `tests/unit/cadence-cursor.test.js`
- `tests/integration/correction-to-reflection-latency.test.js`

**Modified:**

- `src/schema/migrations/0001-init.surql` — `dream_triggers`, `cadence_telemetry`, seed `runtime:cadence.config` and `runtime:cadence.cursors`.
- `src/recall/reinforcement.js` — write `dream_triggers` row on `outcome='corrected'` (alongside Theme 2a's `evidence_ledger` row — same batch).
- `src/capture/biographer.js` — write trigger on correction events; on tone-shift threshold cross.
- `src/memory/foresight.js` — write trigger on prediction resolution.
- `src/dream/pipeline.js` — read cursors; pass `since` to each step; advance cursors at end.
- `src/dream/step-reflection.js`, `step-comm-style.js`, `step-calibration.js` — accept `since` opt; return `{ processed_until, tokens_in, tokens_out }`.
- `src/daemon/server.js` — register cadence-consumer in heartbeat phase.
- `src/mcp/tools/run-dream.js` — write a `manual`-reason trigger row.
- `docs/architecture.md` — cadence section.
- `docs/faculties.md` — dream section: triggered vs nightly subset; budget mechanics.

## Section 11 — Sequencing within Theme 3

1. **Schema additions** — `dream_triggers`, `cadence_telemetry`, config + cursors rows. Additive.
2. **Utilities** — `cursors.js`, `dispatch.js`, `budget.js`. No behavior change.
3. **Step refactor** — trigger-eligible steps accept `since`; report token counts; return `processed_until`.
4. **Cursor-aware nightly pipeline** — `pipeline.js` reads/advances cursors. Behavior unchanged from user's perspective; cost neutral until consumer turns on.
5. **Producers** — reinforcement loop, biographer, foresight, MCP write trigger rows.
6. **Heartbeat consumer** — actually dispatches.
7. **Tests + verification gates.**

Step refactor (3) and cursor-aware pipeline (4) can land before producers (5) and consumer (6) — no behavior change until consumer turns on.

## Section 12 — Dependencies

- **Waits for** `feat/surrealdb-improvements` merge (engine swap; bonus free time-travel reads of the trigger queue for debugging).
- **Theme 2a interaction:** `reinforcement.js` writes both `evidence_ledger` row and `dream_triggers` row on `outcome='corrected'`. One transaction, two CREATEs.
- **Theme 4 will:** add MCP introspection tools that read `dream_triggers` and `cadence_telemetry` (e.g., `show_pending_triggers`, `show_step_health`).
- Independent of Themes 1a / 1b / 1c / 2b.

## Section 13 — Open questions (post-impl review)

- **Auto-tune trigger debounce.** Defaults (`reflection`: 5min, `comm-style`: 30min, `calibration`: 60min) are guesses. Telemetry should surface "triggers debounced per day" — too high means too aggressive; always-zero means too lax.
- **Budget overage policy.** Today: skip and log. Alternative: queue triggers for the next 24h window. Simpler is better in v1; reconsider if dropped-trigger rate becomes a complaint.
- **Surface to `robin doctor`.** Health check: % triggers processed in last 24h; any step's daily cap hit; rolling 24h budget consumption. Theme 4 integrates.
- **Cursor reset on schema migration.** If `runtime:cadence.cursors` survives a destructive reset but the underlying events table doesn't, cursors point at non-existent ranges. Reset cursors during migration; flag for impl.
- **Coordination with the existing nightly cron schedule.** The cron stays at 4 AM. The cursor-aware nightly does strictly-less work; no scheduling change needed in v1.

## See also

- `2026-05-11-robin-v2-evolution-roadmap.md` — umbrella.
- `2026-05-11-robin-v2-theme-2a-evidence-ledger-design.md` — co-located producer in `reinforcement.js`.
- `src/recall/reinforcement.js`, `src/dream/pipeline.js` — primary touch points.
- `src/daemon/server.js` — heartbeat phase wiring.
