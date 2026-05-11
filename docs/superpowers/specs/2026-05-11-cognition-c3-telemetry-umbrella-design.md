# Robin v2 — Cognition C3: Telemetry umbrella

**Status:** Design (working draft; canonical reference for in-flight specs in this round)
**Date:** 2026-05-11
**Umbrella:** `2026-05-11-robin-v2-evolution-roadmap.md` (post-alpha.16, "Cognition C" track)
**Coordinates with:** `2026-05-11-runtime-layer-hardening-design.md` §5 (R-3: post-R-3 the new MCP tool registration moves into `buildTools(ctx)`; pre-R-3 it lives in `system/runtime/daemon/tools.js`. Either order works.)
**Companions in this round (deferred to this spec for telemetry storage layout):** B1 (per-hit reinforcement), B2, A3 (recall eval + MMR), C1 (biographer batching), C2, D1 (state inference), D2, D3.

## Why

Every faculty maintains its own telemetry surface today, and the five in-flight specs landing this month each add more:

- `intuition_telemetry` — per recall (~100s/day on a working session)
- `recall_log` — per recall, semi-mutable (`outcome` updates 5 min later)
- `cadence_telemetry` — per dream-step run
- `compaction_telemetry` — per nightly compaction
- `evidence_ledger` — per evidence signal (structural — not telemetry, but worth naming)
- `action_trust_ledger` — per state change (structural)
- `archive_log` — per archive (structural)
- `refusals` — per refusal (structural)
- `runtime:*` rows — counter-style on long-lived KV rows (biographer, cadence, etc.)

Plus, layered on top by in-flight specs:

- B1: extends `recall_log` with `attribution.*`, extends `intuition_telemetry`.
- A3: new `recall_eval_runs` table, extends `intuition_telemetry.meta`.
- C1: extends `runtime:biographer.value` with batch counters.
- D1: new `state_inference_telemetry`, extends `recall_log.meta.focus_block_*`.

A cross-cutting review flagged this: pick one umbrella before the in-flight plans merge, or it's permanent debt. Two concrete problems beyond shape sprawl:

- **Write volume on hot surfaces.** `intuition_telemetry` and `recall_log` write per recall — 100s/day on a working session. `dream_triggers` and `cadence_telemetry` are 10s/day. At one-year retention that's ~50–100K rows in the hot path with no aggregation. The cost is not the rows; it's that *every consumer query* (doctor, Theme 4 introspection, ad-hoc grep) re-scans them.
- **No common rollup surface.** Theme 4's `show_step_health` already eats `cadence_telemetry` and hand-aggregates. Adding A3's recall eval, D1's state inference, B1's attribution distribution, and C1's batch ratio means five more bespoke aggregators by next week.

The fix is small: define one umbrella row shape for new telemetry, leave the existing hot tables in place (they're load-bearing for in-flight plans), and add a single hourly-rollup table + aggregator job that every consumer can read.

## Goals

- One row shape for all *new* telemetry going forward (`faculty`, `event_kind`, `ts`, `dimensions`, `metrics`, `meta`).
- One rollup destination: `telemetry_hourly`, with FLEXIBLE `metric_buckets` so each recorder owns its own histogram shape.
- Hot surfaces aggregate hourly: an internal job reads `intuition_telemetry`, `recall_log`, and (where applicable) the rest, rolls them into `telemetry_hourly`, advances a cursor. Cuts query cost for dashboards by an order of magnitude.
- Retention floor: 7 days raw, 90 days hourly, 1 year daily (daily is an optional follow-up).
- **Zero forced rewrites** of the four in-flight specs (B1, A3, C1, D1). Their planned tables stay where they are; the umbrella documents how a future migration could fold them in if/when telemetry grows.
- One introspection MCP tool — `show_telemetry_rollup({faculty?, event_kind?, window?})` — wired through the daemon route layer.

## Non-goals

- Replacing `evidence_ledger`, `action_trust_ledger`, `archive_log`, `refusals`. These are structural append-only records (audit trails, lineage), not telemetry. They stay.
- Replacing `runtime:*` counter rows (e.g., C1's `runtime:biographer.value` counters). These are *operational state*, not historical telemetry. They stay.
- Backfilling existing tables into the umbrella shape. Migration is forward-only; old rows queryable in place.
- A general-purpose metrics engine. `telemetry_hourly` is a fixed-shape rollup table with FLEXIBLE buckets — not a TSDB.
- LLM-driven analysis of telemetry. (`robin doctor` and `show_telemetry_rollup` are reads against rollup rows; no inference layer.)

## Anchoring decisions

**Why hourly aggregation, not per-write rollup:**

The natural alternative is "write the raw row AND increment a rollup counter in the same transaction". That couples every recorder to the rollup shape, and any schema change to `telemetry_hourly` requires a synchronized code-and-data change across every recorder. The heartbeat-paced aggregator decouples them: recorders write raw rows; the aggregator reads them; bugs in the aggregator don't block writes; rollup shape changes are local. The 60-min lag is fine — every consumer of `telemetry_hourly` is either a dashboard (`robin doctor`, the new MCP tool) or a daily health check; neither needs sub-hour resolution. For the rare "what happened in the last 10 min?" query, the raw tables are still there for the 7-day retention window.

**Why one rollup table, not per-faculty rollup tables:**

A per-faculty `intuition_hourly`, `cadence_hourly`, `state_inference_hourly` etc. would mean five new tables today and one per faculty per quarter. The umbrella shape (`faculty`, `event_kind`, `dimensions`) is a covering index over all of them — an index on `(faculty, event_kind, hour)` makes the per-faculty filter cheap. The cost is one extra hop ("filter by faculty"); the benefit is one schema to maintain and one introspection tool to wire. Same trade SurrealDB itself makes with `TYPE RELATION` edges (`edges` is one table, kind-discriminated, not nine RELATION tables — see `docs/architecture.md`).

**Why FLEXIBLE `dimensions` and `metric_buckets`:**

Telemetry shape evolves per faculty. Recall has `(source, mode, mmr_path)`; cadence has `(step, success)`; biographer has `(batch_size_bucket, fallback_reason)`. Forcing them into a fixed columnar shape either bloats the schema (eight nullable columns per faculty) or restricts what can be tracked. FLEXIBLE objects let each recorder own its own dimension set; the introspection tool can `SELECT VALUE dimensions.<key>` against any sub-shape because SurrealDB tolerates missing object keys at projection time. Same idiom Robin already uses for `recall_log.meta`, `evidence_ledger.meta`, `events.meta`. Naming convention: snake_case for *all* dimension and metric keys (carry-over from `intuition_telemetry`'s column names).

**Why keep existing hot tables instead of rewriting them:**

`intuition_telemetry` and `recall_log` are load-bearing for four in-flight specs. B1's attribution writes onto `recall_log.attribution`; A3's eval harness reads `recall_log.ranked_hits`; D1's intuition path writes `recall_log.meta.focus_block_*`; existing reinforcement reads `recall_log.outcome`. Forcing a rename or rewrite before those merge would either (a) require all four to re-plan, or (b) sequence them behind C3 and stall the round. The cheap, defensible move is: leave the raw tables alone; add `telemetry_hourly` *on top*; the aggregator job is the only new write path; old consumers (existing `explain_recall`, B1's `show_attribution_health`) keep reading the raw tables; new dashboards read the rollup.

**Why "new tables in this round (A3, D1) stay as planned, not refactored into the umbrella":**

`recall_eval_runs` is per-run, not per-event — its row shape is rich (`metrics: object`, `per_source`, `config_digest`, `git_sha`), tied to the harness output contract, and writes happen ~once per release. `state_inference_telemetry` writes per source per tick — moderate volume (~tens/day per source), with a unique shape (`signal_hash`, `outcome ∈ {wrote, dropped_thin, skipped_unchanged, error}`). Both would *fit* the umbrella shape, but forcing the refactor would (a) make this spec a blocker for A3 and D1, and (b) lock in the umbrella shape against use cases it hasn't yet been tested on. We document the future migration path in §6 instead.

**Why `telemetry_hourly`, not `telemetry_daily` or `telemetry_5min`:**

- Sub-hour buckets multiply row count (288 5-min buckets per day vs 24 hourly) for marginal precision gain — the consumers can't tell a 5-min spike from an hour-long warm-up.
- Daily buckets lose the "show me today's hot hour" question that doctor and the MCP tool want to answer. Hourly is also where most ops tooling expects to start (cron syntax, log-rotate cadence).

Optional `telemetry_daily` rollup on top of hourly is listed in §6 as a follow-up; it's a 24:1 reduction over `telemetry_hourly` and pays for the 1-year retention window cheaply if/when we need it.

**Why a heartbeat-driven aggregator (not a separate cron/timer):**

Robin already has the heartbeat dispatcher (`system/runtime/daemon/dispatcher-tick.js`) firing every 60s and consuming markdown job descriptors from `system/cognition/jobs/builtin/*.md`. The existing `reinforce-recall` (every 5 min) and `log-rotate` (every 6 hours) jobs prove the cadence is workable. Adding `telemetry-rollup` (every 60 min) is a one-file descriptor + a new internal implementation — no new infrastructure.

## Section 1 — Inventory

Every existing telemetry/ledger surface today, plus every addition the in-flight specs propose.

| Surface | Kind | Write rate | Retention today | Retention target | Classification |
|---|---|---|---|---|---|
| `intuition_telemetry` | Per-event | ~100/day | No rotation | 7d raw, rolled up hourly | **Hot** |
| `recall_log` | Per-event (mutable: `outcome` set ~5 min later) | ~100/day | No rotation | 7d raw, rolled up hourly | **Hot** |
| `cadence_telemetry` | Per-step run | ~10–30/day | No rotation | 90d raw | **Cold** |
| `compaction_telemetry` | Per nightly run | ~1/day | No rotation | 1y raw | **Cold** |
| `dream_triggers` | Per trigger (queue + history) | ~10–50/day | No rotation | 90d raw (already TTL'd at `trigger_ttl_days=7d` for pending) | **Cold (queue+log hybrid)** |
| `evidence_ledger` | Per evidence signal | ~10s/day | No rotation | Permanent | **Ledger (structural)** |
| `action_trust_ledger` | Per state change | ~1s/day | No rotation | Permanent | **Ledger (structural)** |
| `archive_log` | Per archive | ~10s/day during compaction nights | No rotation | Permanent | **Ledger (structural)** |
| `refusals` | Per refusal | ~1s/day | No rotation | 90d raw | **Ledger (structural; auditor-facing)** |
| `runtime:biographer.value` | Counter row (singleton) | Increments on every batch | Live (overwritten) | Live | **Operational state** |
| `runtime:cadence.cursors` | Cursor row | Updated per consumer tick | Live | Live | **Operational state** |
| `runtime:recall.value` | Tunable config | Rarely updated | Live | Live | **Config** |

**In-flight additions** (read each spec; this is the inventory of new telemetry surfaces this round):

| Surface | From | Kind | Write rate | Disposition under C3 |
|---|---|---|---|---|
| `recall_log.attribution.*` (top-level extension) | B1 | Per-event (extends Hot) | Same as `recall_log` (~100/day) | Stays on `recall_log`; rolled up via aggregator (count by `attribution.mode`) |
| `recall_log.ranked_hits[*].used` / `used_via` / `used_score` | B1 | Per-event sub-object | Same | Stays inline (already FLEXIBLE); rollup counts `used=true` per mode |
| `intuition_telemetry.meta.*` (mmr_drops, mmr_path, mmr_vec_coverage) | A3 | Per-event extension | Same as `intuition_telemetry` | Stays inline (already FLEXIBLE per A3 §4); rollup buckets `mmr_path` |
| `recall_log.meta.from`, `latency_ms` | A3 | Per-event extension | Same | Stays inline; rollup buckets `from`, percentiles on `latency_ms` |
| `recall_log.meta.focus_block_present`, `focus_block_tokens` | D1 | Per-event extension | Same | Stays inline; rollup counts `present=true`, sums `tokens` |
| `recall_eval_runs` | A3 | Per-run | ~1/release | New table per A3; **kept as-planned** (per-run, not per-event); §6 documents future folding path |
| `runtime:biographer.value.batches_total` (and siblings) | C1 | Counter row (singleton) | Increments per batch | **Kept as-planned** (operational state); aggregator may optionally hourly-sample for trend |
| `state_inference_telemetry` | D1 | Per source per tick (~10s/day per source) | Moderate | New table per D1; **kept as-planned** (per-tick); §6 documents future folding path |
| `recall_log.session_id` (top-level, B1 Phase 0) | B1 | Plumbing | Per-event | Stays inline; rollup keys on `session_id` only for `show_telemetry_rollup` filters, not as a dimension |

**Net effect of C3:** **one new table** (`telemetry_hourly`), **one new internal job** (`telemetry-rollup`), **one new config row** (`runtime:telemetry.config`), **one new MCP tool** (`show_telemetry_rollup`). All existing surfaces and in-flight planned surfaces stay exactly where they were planned.

## Section 2 — Two-tier classification

Three categories — only the first changes behaviour under C3.

### 2.1 Hot telemetry (aggregate to `telemetry_hourly`)

High-volume per-event surfaces. The aggregator job reads them since its last cursor, computes counts and metric rollups, writes to `telemetry_hourly`, and advances the cursor. Raw rows stay for 7 days (a `telemetry-prune` sub-job, §5, deletes older raw rows).

- `intuition_telemetry` (~100/day)
- `recall_log` (~100/day; semi-mutable — `outcome` is set 5 min after the row lands, so the aggregator must wait for `outcome != 'pending'` to roll up — see §4.2)
- B1's `recall_log.attribution.*` (no new table — rolled up from the same `recall_log` pass)
- A3's `intuition_telemetry.meta.*` (no new table — rolled up from the same `intuition_telemetry` pass)
- D1's `recall_log.meta.focus_block_*` (no new table — rolled up from the same `recall_log` pass)

These tables continue to be **read directly** by their consumers (`explain_recall`, B1's `show_attribution_health`, A3's recall-eval harness) for the 7-day raw window. The rollup is purely additive: it doesn't replace reads from raw.

### 2.2 Cold telemetry (keep as-is)

Per-step or per-day surfaces. Volume too low to justify aggregation overhead.

- `cadence_telemetry` (~10–30/day)
- `compaction_telemetry` (~1/day)
- `dream_triggers` (~10–50/day; queue + history hybrid — already self-limits via `trigger_ttl_days=7`)
- `recall_eval_runs` (A3; ~1/release)
- `state_inference_telemetry` (D1; ~10s/day per source)

**This round** these are NOT pruned by the rollup job — the inventory's "retention target" column for cold tables is aspirational and a small follow-up extension to `telemetry-prune`. We hold off because (a) their volume is so low (1/day for compaction; 10s/day for cadence) that 1+ year of raw is ~10K rows — nothing to optimise — and (b) two of them are *new this round* (recall_eval_runs, state_inference_telemetry) and forcing a retention decision before they've been in production for a week is premature. Consumers continue to query them directly.

### 2.3 Ledger telemetry (keep as-is — structural, not telemetry)

Append-only audit/lineage rows. Not telemetry in the rollup sense — each row is a primary record consumed by a faculty (evidence as part of `fn::derived_confidence`, action_trust_ledger as the audit history for `explain_action_trust`, etc.). Aggregating would lose the per-row payload (the reason, the polarity, the actor) which is the whole point of these surfaces.

- `evidence_ledger` — read by `fn::derived_confidence`, `step-confidence-recompute`, `explain_belief`. Permanent.
- `action_trust_ledger` — read by `explain_action_trust`. Permanent.
- `archive_log` — read by `archive_history` MCP tool. Permanent.
- `refusals` — read by `recent_refusals` MCP tool. 90d retention is plenty (auditor-facing).

C3 leaves these untouched.

## Section 3 — Unified row shape (for *new* telemetry going forward)

```surql
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

-- Compound index for the common query: filter by (faculty, event_kind), order by hour.
DEFINE INDEX telemetry_hourly_key ON telemetry_hourly
  FIELDS faculty, event_kind, hour;
-- Secondary index for time-window scans (doctor, MCP tool default queries).
DEFINE INDEX telemetry_hourly_hour ON telemetry_hourly FIELDS hour;
```

Field meanings:

- `hour`: bucket key, normalised to the top of the hour (e.g., `2026-05-11T14:00:00Z`). Used as part of the natural primary key together with `faculty`, `event_kind`, and a deterministic dimensions digest (see §4.3). Rows are UPSERTed by the aggregator on each tick — repeat ticks update the same row.
- `faculty`: short snake_case name. Initial values: `'intuition' | 'reinforcement' | 'biographer' | 'cadence' | 'dream' | 'compaction' | 'state_inference' | 'recall_eval'`. Not enum-asserted — open at write time, code-side registry enforces.
- `event_kind`: snake_case verb-like name within faculty. **In this round** the following faculty/event_kind combinations are written by the rollup (the hot ones, per §4):
  - `intuition`: `'recall'` (counts and metric sums per `intuition_telemetry` row), `'recall_attribution'` (counts per B1 `attribution.mode`).
  - `reinforcement`: `'evaluate'` (counts per `recall_log.outcome` bucket).
  - `belief`: `'call'` (counts and latency sums from D3's `cadence_telemetry` rows where `step='belief.call'`, per §3.2 / §4.2).
  - `dream`: `'<sub_step>'` (counts and per-sub-step metrics from C2's `cadence_telemetry` rows where `step LIKE 'dream.%'`, per §3.2 / §4.2).
  - `meta_cognition`: `'run'` (counts and per-run metrics from D2's `meta_cognition_telemetry` rows; low volume, included for completeness per §4.2).
  - **Aspirational** (documented for future fold-in; *not* written in this round): `biographer.batch_run`, `cadence.step_run` (non-hot step kinds), `compaction.run`, `state_inference.tick`, `recall_eval.run`. Each has a natural mapping to the umbrella row shape, but their raw tables / counter rows are kept as-planned by §6.
- `dimensions`: snake_case object. Anything the recorder wants to *group by*. Examples (only the first three are written in this round):
  - `intuition.recall`: `{ source: 'intuition'|'mcp_recall', mmr_path: 'cosine'|'substring'|null }`.
  - `intuition.recall_attribution`: `{ mode: 'citation'|'similarity'|'fallback_no_reply'|... }` (one row per mode per hour, per B1 §3).
  - `reinforcement.evaluate`: `{ outcome: 'reinforced'|'corrected'|'evaluated_no_signal'|'evaluated_no_used' }`.
  - Aspirational only: `cadence.step_run` `{ step, success }`, `biographer.batch_run` `{ batch_size_bucket, fallback_reason }`, `state_inference.tick` `{ source, outcome }`.
- `count`: integer event count for this bucket.
- `metric_sums`: snake_case object. Sums of scalar metrics, recorder-defined. Examples (this round):
  - `intuition.recall`: `{ latency_ms_sum, tokens_injected_sum, hits_sum, query_chars_sum, focus_block_tokens_sum }` (the `focus_block_tokens_sum` lands once D1's `recall_log.meta.focus_block_tokens` populates).
  - `intuition.recall_attribution`: `{ used_count_sum, total_sum, dropped_hits_sum, elapsed_ms_sum }` (from B1's `attribution` object).
  - `reinforcement.evaluate`: empty `{}` (count-only).
- `metric_buckets`: snake_case object, **fully FLEXIBLE**. Each recorder owns its own histogram shape. The umbrella does not prescribe percentiles. This round:
  - `intuition.recall`: `{ latency_ms: { p50, p95, p99 } }` (computed via `math::percentile` per §4.2).
  - Other rollups: empty unless the recorder needs them.
- `meta`: optional. Free-form extras (e.g., the aggregator job version, cursor lag, partial-rollup flag).

**Recorder contract** (`system/cognition/telemetry/record.js`, §5):

```js
recordTelemetry({
  faculty: 'intuition',
  event_kind: 'recall',
  dimensions: { source: 'intuition', mode: 'hybrid' },
  metrics: { latency_ms: 18, tokens_injected: 320, hits: 4, query_chars: 84 },
  // ts defaults to now; pass explicitly only for replay
});
```

The recorder writes to the raw per-faculty table (or the new umbrella raw table, see §4.1) as today — but the rollup aggregator reads from the raw table on its next tick.

**Naming rules (carried through every faculty):**

- `dimensions` and `metric_sums` keys: snake_case.
- Metric sum keys: `<metric>_sum` (the trailing `_sum` is mandatory so `metric_sums.latency_ms_sum / count` always yields a mean without ambiguity).
- Histogram keys in `metric_buckets`: `<metric>` (no suffix) — e.g., `metric_buckets.latency_ms.p95`. The recorder decides which buckets it computes.
- Outcome dimensions: `outcome` (not `result`, not `status` — match `recall_log.outcome`, `dream_triggers.outcome`, `state_inference_telemetry.outcome`).

### 3.1 Privacy & cardinality contract

`dimensions` is the GROUP BY key for every rollup — its values land in row IDs (via `dimensions_hash`) and in the projected rollup rows. Free-text values blow up cardinality (one row per unique string) and leak content into telemetry. The contract:

- **Dimensions MUST be enumerable values from a small fixed set** (e.g., `outcome ∈ {reinforced, corrected, …}`, `mode ∈ {citation, similarity, …}`) **OR an opaque hash** (≤ 16 hex chars) of a high-cardinality identifier the recorder needs to group on.
- **Free-text values** (raw `query` strings, content snippets, user-typed input, error messages) **MUST go to `meta`** (the FLEXIBLE per-row extras object), **NOT to `dimensions`**. `meta` is not GROUP-BY'd and not part of the row ID.
- **Recorder-side enforcement:** `recordTelemetry()` rejects dimension values longer than **64 chars** or containing characters outside `[A-Za-z0-9_.-]`. Validation is unit-tested (§9.1 test 8). Violations throw at write time; the calling faculty is responsible for hashing or moving the value to `meta`.
- **D3 example:** D3's `belief.call` writes a free-text `query` field. The recorder MUST place `query` in `meta` (or hash it and place the hash in `dimensions.query_hash`), never in `dimensions.query` directly.

### 3.2 `cadence_telemetry` rows with hot-tier `step` values

`cadence_telemetry` is classified cold (§2.2) overall — most of its rows (state_inference, calibration, etc.) stay raw. But D3 writes `belief.call` rows to `cadence_telemetry` with `step='belief.call'`, and C2 writes per-step dream telemetry with `step='dream.<sub_step>'`. These have hot-tier volume and need rollup.

- The aggregator (§4.2) adds a `cadence_hot_steps` SELECT branch that reads `cadence_telemetry` rows whose `step` matches the configured hot-step prefixes (`belief.%`, `dream.%`) and rolls them into `telemetry_hourly` under `faculty='belief'` / `event_kind='call'` (and `faculty='dream'` / `event_kind='<sub_step>'` respectively).
- Cold-tier `cadence_telemetry` rows (state_inference, calibration, anything not matching the hot-step list) stay raw — they are *not* rolled up; consumers read them directly per §2.2.
- The hot-step list is config: `runtime:telemetry.config.cadence_hot_steps` (default `['belief.', 'dream.']` — prefix match). New hot steps are added by appending to the list and registering the rollup branch in `rollup.js` per §5.4.

### 3.3 Sampling fidelity

D3 (and any future high-volume hot writer) may sample at write time — only every Nth call is recorded, with `sample_rate` stored on the row. The rollup MUST preserve this for accurate post-hoc inference: each rollup row records the `sample_rate` of the contributing raw rows (mean, or — when the recorder samples uniformly per row — passthrough). Consumers compute estimated population counts as `count × (1 / mean_sample_rate)`. The rollup transform stores `sample_rate` under `metric_sums.sample_rate_sum` (so `sample_rate_sum / count` yields the mean rate for the bucket).

### 3.4 Nested metric handling (object-shaped metrics)

Some metrics are object-shaped, not scalar. Example: B2's `contradictions_suppressed_by_rule` is `option<object> FLEXIBLE` — a counter map per suppression rule (e.g., `{ low_confidence: 3, private_redaction: 1 }`). The umbrella's `metric_sums.<key>_sum` model is scalar — it can't represent a per-rule map directly.

**Fan-out at write time.** The recorder (`recordTelemetry()`) fans object-shaped metrics out into scalar entries via `Object.entries`. For `contradictions_suppressed_by_rule = { low_confidence: 3, private_redaction: 1 }`:

- emits `metrics: { contradictions_suppressed_low_confidence: 3, contradictions_suppressed_private_redaction: 1, ... }`
- which rolls up into `metric_sums.contradictions_suppressed_low_confidence_sum`, etc.

**Explosion ceiling.** To bound the metric_sums key space, the recorder rejects object-shaped metrics with more than **16 keys**. Faculties with naturally-unbounded key spaces (e.g., per-user-id counters) MUST hash or bucket their keys first. Validated by a unit test in §9.1.

### 3.5 `dimensions_hash` normalization

To make the `dimensions_hash` deterministic across recorders and runs:

- **Dimension values are restricted to `string | bool | int`** (no floats — floats stringify ambiguously across engines; no nested objects; no arrays; no unicode beyond ASCII — non-ASCII goes through the hash-or-move-to-`meta` path of §3.1).
- The canonical JSON serializer is `JSON.stringify` with **sorted keys** (per `dimensionsHash()` in §4.1). This produces deterministic hash input across Node versions.

## Section 4 — Aggregation strategy

### 4.1 Rollup destination

One table: `telemetry_hourly`. UPSERT key: composite of `(faculty, event_kind, hour, dimensions_hash)`. The `dimensions_hash` is a deterministic SHA-256 over the JSON-serialised dimensions object with sorted keys — guarantees the same dimensions always hit the same row. Stored as the `id` field for the row (`telemetry_hourly:{hash}`), so the aggregator can `UPSERT telemetry_hourly:<id> SET ...` without a SELECT-then-INSERT race.

```js
function dimensionsHash(faculty, event_kind, hour, dimensions) {
  const sorted = Object.fromEntries(
    Object.entries(dimensions ?? {}).sort(([a], [b]) => a.localeCompare(b))
  );
  const key = `${faculty}|${event_kind}|${hour.toISOString()}|${JSON.stringify(sorted)}`;
  return sha256_hex(key).slice(0, 24);
}
```

24 hex chars (~96 bits) is collision-safe for the scale we're at (max ~10K rows in the table at any moment under the 90d retention target).

### 4.2 What the aggregator reads

Per faculty, the aggregator runs a fixed SurrealQL SELECT scoped to the cursor window `[$cursor, $now)`. The cursor is stored on a singleton runtime row, advanced atomically per faculty:

```
runtime:`telemetry.cursor` SET value = {
  intuition_telemetry:        <iso>,    // last rolled-up `ts` (events are immutable)
  recall_log_eval:            <iso>,    // last rolled-up `evaluated_at` (skips pending rows)
  cadence_telemetry_hot:      <iso>,    // last rolled-up `ts` for belief.%/dream.% rows (§3.2)
  meta_cognition_telemetry:   <iso>,    // last rolled-up `ts` for D2 meta_cognition.run
  // Cold cursors (state_inference_telemetry, recall_eval_runs, the non-hot
  // cadence_telemetry rows, compaction_telemetry) are not used in this round.
}
```

**`recall_log` is semi-mutable.** `outcome` is set ~5 min after the row lands by the reinforcement loop; B1's `attribution.*` is written in the same UPDATE. To avoid a partial rollup (counting a row before its `outcome` resolves), the aggregator uses **one cursor** keyed off `evaluated_at` — not `ts`:

- `recall_log_eval` cursor: rolls up rows with `evaluated_at IS NOT NONE` (set by reinforcement when it writes `outcome`). Aggregates everything `recall_log` knows about a recall in one pass — `outcome` bucket, `attribution.mode`, `meta.from`, `meta.focus_block_present`, etc. The cursor advances to the max `evaluated_at` of rows scanned in this window, minus the `cutoff_safety_seconds` margin. Rows still `outcome='pending'` (or never-evaluated legacy rows) are skipped; they enter the rollup on a later tick once evaluated. Worst-case lag: ~10 min (reinforcement window + safety margin) — acceptable for hourly buckets.

Per-faculty SELECTs (one per cursor) — example for the `intuition_telemetry` cursor:

```surql
SELECT
  time::floor(ts, 1h)                  AS hour,
  meta.from                            AS source,
  meta.mmr_path                        AS mmr_path,
  count()                              AS n,
  math::sum(latency_ms)                AS latency_ms_sum,
  math::sum(tokens_injected)           AS tokens_injected_sum,
  math::sum(hits)                      AS hits_sum,
  math::sum(query_chars)               AS query_chars_sum,
  math::percentile(latency_ms, 50)     AS p50_latency_ms,
  math::percentile(latency_ms, 95)     AS p95_latency_ms,
  math::percentile(latency_ms, 99)     AS p99_latency_ms
FROM intuition_telemetry
WHERE ts >= $cursor AND ts < $cutoff
GROUP BY hour, source, mmr_path;
```

`$cursor` = previous high-water mark; `$cutoff` = `now - cutoff_safety_seconds` (config default 60s — guards against clock skew letting an in-flight write get missed).

**Note on `math::percentile`.** SurrealDB v3 ships `math::percentile(array<number>, n)` (verified against `/surrealdb/docs.surrealdb.com`). Inside `GROUP BY`, columns referenced inside aggregate functions are auto-collected into the group's value array (the same idiom that makes `math::stddev(score)` work as a grouped aggregate per the SurrealDB docs "Calculate statistics in table views" example). If a future engine release tightens this contract, the rollup falls back to a SurrealQL `array::group` + `math::percentile($group, 50)` pattern, or — last resort — fetches the latency array per group and computes percentiles in JS. This is a single-file fallback inside `rollup.js`, not a schema change. Treat the SELECT above as the primary shape; revisit only if benchmarks show a hot spot.

**Note on `meta.from` availability.** `meta.from` is added by A3 (`intuition_telemetry` and `recall_log` both gain the field per A3 §1.5). Pre-A3 rows return `null` for `meta.from`, which groups into a `dimensions: { source: null }` bucket — not dropped (verified by §9.1 test 6). Post-A3, the field is populated and groups correctly.

A companion SELECT against `recall_log` for the `recall_log_eval` cursor — same shape, attribution-aware:

```surql
SELECT
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
GROUP BY hour, outcome, attribution_mode, source, focus_block_present;
```

Yields one or more `telemetry_hourly` rows under `faculty='intuition'`, `event_kind='recall_attribution'` (and a sibling rollup `faculty='reinforcement'`, `event_kind='evaluate'` derived from the same scan — the aggregator splits the result into two row families based on which dimensions/metrics each cares about; no extra DB read).

**B2 metric coverage.** B2 adds three fields to `intuition_telemetry.meta` — `contradictions_surfaced`, `contradictions_suppressed_by_rule` (object-shaped, see §3.4 fan-out), and `conflict_block_tokens`. C3's `intuition_telemetry` rollup SELECT enumerates every metric the in-flight specs need:

- B2 scalars roll up via `math::sum(meta.contradictions_surfaced)` and `math::sum(meta.conflict_block_tokens)` (added as `contradictions_surfaced_sum` and `conflict_block_tokens_sum` in the rollup output).
- B2's object-shaped `contradictions_suppressed_by_rule` is fanned out at write time per §3.4 into `meta.contradictions_suppressed_<rule>` scalars; each becomes its own `*_sum` entry in `metric_sums`. The set of rule keys is bounded (≤16 per §3.4).

**Third SELECT branch: `cadence_telemetry` hot-step bridge (§3.2).** A third SELECT branch reads cadence rows matching the configured hot-step prefixes — covers both D3's `belief.call` rows AND C2's per-step dream telemetry rows:

```surql
SELECT
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
  AND (string::starts_with(step, 'belief.') OR string::starts_with(step, 'dream.'))
GROUP BY hour, step, success;
```

The aggregator splits results by `step` prefix:

- `belief.*` → `faculty='belief'`, `event_kind=<step suffix>` (e.g., `belief.call` → `event_kind='call'`).
- `dream.*` → `faculty='dream'`, `event_kind=<step suffix>` (one row per dream sub-step per hour per `success` bucket).

Cursor: `cadence_telemetry_hot` (separate from the general `cadence_telemetry` cursor — which is unused in this round since cadence cold rows aren't rolled up). The hot-step prefix list lives in `runtime:telemetry.config.cadence_hot_steps` (default `['belief.', 'dream.']`); appending a new prefix + a registry entry adds a new hot step without a schema change.

**D2 `meta_cognition.run` rollup (low volume, for completeness).** D2 writes per-run rows to `meta_cognition_telemetry` (~1–5/day on a working session). Volume is low enough that rollup is for *uniformity* (not query-cost reduction). The aggregator runs a fourth SELECT branch under `faculty='meta_cognition'`, `event_kind='run'`, grouping by `dimensions.outcome` and summing the per-run metrics (`tokens_in`, `tokens_out`, `latency_ms`, `actions_proposed`, `actions_accepted`). Cursor: `meta_cognition_telemetry`.

The aggregator transforms each result row into a `telemetry_hourly` UPSERT:

```surql
UPSERT telemetry_hourly:<dim_hash> CONTENT {
  hour: <hour>,
  faculty: 'intuition',
  event_kind: 'recall',
  dimensions: { source: <source>, mmr_path: <mmr_path> },
  count: <n>,
  metric_sums: { latency_ms_sum, tokens_injected_sum, hits_sum, query_chars_sum },
  metric_buckets: { latency_ms: { p50, p95, p99 } }
};
```

UPSERT means the second tick covering the same `hour` (e.g., the aggregator runs at 14:00 and again at 15:00 — both touch the 14:xx hour for rows that landed late) **overwrites** the row rather than adding to it. Idempotency comes from the fact that the GROUP BY in the SELECT is a full re-aggregation of the window `[$cursor, $cutoff)` — see §4.4.

### 4.3 Idempotency and cursor advance

The aggregator is idempotent because:

1. Every tick computes the rollup *from scratch* over the cursor window.
2. UPSERT replaces, doesn't add — running twice over the same window yields the same row state.
3. The cursor is only advanced after the UPSERTs succeed.

Failure modes:

- **Crash mid-rollup, before cursor advance** → next tick re-aggregates the same window. UPSERTs are idempotent. No double-count.
- **Cursor file corruption / missing row** → aggregator falls back to "start from `now - 24h`" (configurable via `runtime:telemetry.config.cursor_fallback_window`). The 7-day raw retention means we lose at most 24h of rollup precision in this edge case; we don't lose the underlying raw rows. The cursor row is rewritten on next successful tick.
- **Clock skew** → `$cutoff = now - cutoff_safety_seconds` (default 60s) and the per-faculty cursors all share the same `$cutoff` value within one tick (computed once at the top of the tick). Late-arriving rows that landed *before* the previous cursor get picked up by the next tick's wider window (the cursor only advances to `$cutoff`, not `now`).

Cursor advance is one UPSERT per faculty, batched at the end of the tick:

```surql
UPSERT runtime:`telemetry.cursor` MERGE {
  value: {
    intuition_telemetry:      $cutoff,
    recall_log_eval:          $cutoff_eval,
    cadence_telemetry_hot:    $cutoff,
    meta_cognition_telemetry: $cutoff,
    -- per-hot-source cursors. Cold sources omitted in this round.
  }
};
```

`$cutoff_eval` is the max `evaluated_at` of rows scanned this tick (minus `cutoff_safety_seconds`), per §4.2. `$cutoff` is `now - cutoff_safety_seconds`.

If any UPSERT fails, the surviving cursors keep their old value — fail-soft (per-faculty resumes from where it left off).

### 4.4 Re-aggregation window

The aggregator does **not** rely on "only roll up rows we haven't seen". It rolls up the entire window `[$cursor, $cutoff)` every tick. This is the simpler, idempotent strategy and avoids any "row-was-written-after-the-cursor-moved" race. Cost: each tick re-reads up to ~5 min of rows that were already rolled up at the previous tick (the safety margin), times the row rate. At 100 rows/day on `intuition_telemetry`, that's ~0.35 rows re-read per tick — negligible.

For high-volume scenarios (1000+ rows/hour), the aggregator can be extended to use a sliding-only-forward cursor with no overlap — but the simple form ships first.

### 4.5 What the aggregator does NOT roll up (this round)

- `cadence_telemetry` rows that do **not** match the configured hot-step prefixes (state_inference, calibration, etc.) — too low-volume per-row-kind; consumers query raw. Hot-prefix rows (`belief.%`, `dream.%`) **are** rolled up per §3.2 / §4.2 bridge.
- `compaction_telemetry`, `state_inference_telemetry`, `recall_eval_runs` — too low-volume; consumers query raw.
- `evidence_ledger`, `action_trust_ledger`, `archive_log`, `refusals` — structural ledgers, not telemetry (per §2.3).
- `runtime:*` counter rows — operational state, not historical telemetry (per §2).

The aggregator is **extensible**: adding a new hot source is one new SELECT + one new cursor key + one entry in the recorder registry (§5). No schema migration to `telemetry_hourly`.

## Section 5 — Implementation

### 5.1 New files

```
system/cognition/telemetry/
├── record.js          # recordTelemetry({faculty, event_kind, ...}) — pure write to raw
├── rollup.js          # rollupHotTelemetry({db, since, until}) — pure aggregator
├── retention.js       # pruneRawTelemetry({db, table, before}) — pure pruner
└── config.js          # readTelemetryConfig(db) — reads runtime:telemetry.config (cached per tick)

system/cognition/jobs/internal/
└── telemetry-rollup.js  # heartbeat-driven; calls rollup.js + retention.js

system/cognition/jobs/builtin/
└── telemetry-rollup.md   # job descriptor (60-min cadence)

system/io/mcp/tools/
└── show-telemetry-rollup.js  # introspection tool
```

### 5.2 Job descriptor

`system/cognition/jobs/builtin/telemetry-rollup.md`:

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
description: Roll up hot-tier telemetry (intuition_telemetry, recall_log) into telemetry_hourly. Prunes raw rows past 7d retention.
---
```

Schedule `5 * * * *` = every hour at :05 (small offset from the heartbeat boundary so it doesn't contend with reinforce-recall at :00). Cadence rationale: hourly buckets, hourly aggregator.

### 5.3 Aggregator job implementation sketch

`system/cognition/jobs/internal/telemetry-rollup.js`:

```js
import { paths } from '../../../config/data-store.js';
import { rollupHotTelemetry } from '../../telemetry/rollup.js';
import { pruneRawTelemetry } from '../../telemetry/retention.js';
import { readTelemetryConfig } from '../../telemetry/config.js';

export default async function telemetryRollup({ db }) {
  const cfg = await readTelemetryConfig(db);
  if (!cfg.enabled) return JSON.stringify({ skipped: 'disabled' });

  const result = { rollup: {}, prune: {} };

  // Stage 1: rollup.
  try {
    result.rollup = await rollupHotTelemetry({ db, cfg });
  } catch (e) {
    result.rollup = { error: e.message };
  }

  // Stage 2: prune raw rows past retention. Fail-soft per-table.
  for (const table of ['intuition_telemetry', 'recall_log']) {
    try {
      const before = new Date(Date.now() - cfg.raw_retention_days * 86400 * 1000);
      // recall_log: only prune rows with outcome != 'pending' (defensive — pending
      // rows shouldn't be 7d old, but if they are it means reinforcement is stuck;
      // keep them visible for debugging).
      const where = table === 'recall_log' ? 'outcome != "pending"' : null;
      result.prune[table] = await pruneRawTelemetry({ db, table, before, where });
    } catch (e) {
      result.prune[table] = { error: e.message };
    }
  }

  // Stage 3: prune telemetry_hourly past 90d (cheap; one DELETE).
  try {
    const before = new Date(Date.now() - cfg.hourly_retention_days * 86400 * 1000);
    result.prune.telemetry_hourly = await pruneRawTelemetry({
      db, table: 'telemetry_hourly', before, timestampField: 'hour',
    });
  } catch (e) {
    result.prune.telemetry_hourly = { error: e.message };
  }

  return JSON.stringify(result);
}
```

Fail-soft per-stage and per-table. The job *always* exits cleanly so the heartbeat doesn't get stuck.

#### 5.3.1 Pending-row bounded growth

Edge case: a recall_log row is written with `outcome='pending'` and waits for the reinforcement loop to evaluate it. Normal path — reinforcement fires ~5 min later and sets `outcome='reinforced' | 'corrected' | 'evaluated_no_signal' | 'evaluated_no_used'`. But if the daemon is down at the right time, or reinforcement crashes mid-evaluation, the row stays `outcome='pending'` forever. The Stage 2 prune above explicitly excludes pending rows from the 7-day delete (`where: 'outcome != "pending"'`), so without a bound, pending rows accumulate indefinitely.

**Hard ceiling.** A separate prune stage (Stage 2b) deletes pending rows older than `pending_recall_log_hard_ceiling_days` (default 30d):

```js
// Stage 2b: hard ceiling on stuck pending recall_log rows.
try {
  const cutoff = new Date(Date.now() - cfg.pending_recall_log_hard_ceiling_days * 86400 * 1000);
  const deleted = await pruneRawTelemetry({
    db, table: 'recall_log', before: cutoff, where: 'outcome = "pending"',
  });
  if (deleted.count > 0) {
    // Emit a telemetry warning row so the doctor surfaces the prune.
    await recordTelemetry({
      faculty: 'reinforcement',
      event_kind: 'pending_recall_log_force_pruned',
      dimensions: {},
      metrics: { count: deleted.count },
    });
  }
  result.prune.recall_log_pending = deleted;
} catch (e) {
  result.prune.recall_log_pending = { error: e.message };
}
```

**Doctor check.** A `robin doctor --health` probe counts pending rows older than 7 days; warns if the count exceeds 100. The threshold is deliberately tight (a healthy instance evaluates pending rows within ~5 min, so 7-day-old pending rows always indicate a bug). The probe lives in the existing `health.js` registry; the check is a single SurrealQL `SELECT count() FROM recall_log WHERE outcome = 'pending' AND ts < time::now() - 7d`.

**Rollback note:** this prune is additive — it only deletes pending rows past the hard ceiling. Disabling the C3 telemetry job (per §8.3) leaves the prune stage inactive, but pending rows that accumulate under that condition would be cleaned up the moment C3 is re-enabled. No data dependency on C3 rollup state.

### 5.4 Config row

Seeded by the migration (§7):

```surql
UPSERT runtime:`telemetry.config` SET value = {
  enabled: true,
  shadow_mode: true,                  -- §8.1 — rollups computed, not consumed by tools
  raw_retention_days: 7,
  hourly_retention_days: 90,
  daily_retention_days: 365,          -- reserved for future telemetry_daily; not used in this round
  cutoff_safety_seconds: 60,          -- $cutoff = now - cutoff_safety_seconds
  cursor_fallback_window_hours: 24,
  faculties_enabled: ['intuition', 'reinforcement', 'belief', 'dream', 'meta_cognition'],
  cadence_hot_steps: ['belief.', 'dream.'],   -- prefix match for hot rows in cadence_telemetry (§3.2)
  pending_recall_log_hard_ceiling_days: 30    -- hard prune for stuck pending rows (§5.3.1)
};
```

`shadow_mode: true` ships first (§8.1). One week later, flip to `false` to surface rollups in `show_telemetry_rollup` and `robin doctor` widgets.

**`faculties_enabled` is a kill-switch-per-faculty, not a registry.** The actual rollup SELECTs live in a registry (`system/cognition/telemetry/rollup-registry.js`) — one entry per faculty/cursor combination, each defining: cursor name, SurrealQL SELECT, source table, hot-step filter (if applicable), and the projection into `telemetry_hourly` row family (faculty, event_kind, dimensions, metric_sums, metric_buckets). `faculties_enabled` toggles each entry on/off at runtime — disabled entries are skipped on the tick; enabled entries run their registered SELECT. Adding a new hot source = one new registry entry + one new entry in `faculties_enabled`. No `rollup.js` edit beyond the registry file.

`cadence_hot_steps` is the prefix list driving the `cadence_telemetry` hot-step bridge SELECT (§3.2 / §4.2). Default `['belief.', 'dream.']`. Append-only contract: removing a prefix orphans existing rollup rows under that prefix; do that only via a follow-up reset migration.

### 5.5 MCP tool

`system/io/mcp/tools/show-telemetry-rollup.js` — a new read-only introspection tool:

```js
export const showTelemetryRollupTool = {
  name: 'show_telemetry_rollup',
  description:
    'Return hourly telemetry rollups. Filter by faculty and/or event_kind. ' +
    'Window defaults to last 24h. Returns aggregated counts, sums, and bucket histograms ' +
    'from telemetry_hourly.',
  inputSchema: {
    type: 'object',
    properties: {
      faculty: { type: 'string', description: 'e.g. "intuition", "biographer". Optional.' },
      event_kind: { type: 'string', description: 'e.g. "recall", "batch_run". Optional.' },
      window: {
        type: 'string',
        description: 'ISO duration: "PT24H", "P7D", etc. Default "PT24H".',
        default: 'PT24H',
      },
      limit: { type: 'number', default: 200 },
    },
  },
};
```

Implementation:

```surql
SELECT * FROM telemetry_hourly
WHERE hour >= $since
  AND ($faculty IS NONE   OR faculty   = $faculty)
  AND ($event_kind IS NONE OR event_kind = $event_kind)
ORDER BY hour DESC, faculty, event_kind
LIMIT $limit;
```

Returns the raw `telemetry_hourly` rows for the window. The tool does no aggregation on top — the rows ARE the aggregation. Read-only (no CREATE / UPDATE / DELETE in source — enforced by the existing `introspection-tools-readonly.test.js` per Theme 4).

**Wiring (R-3 coordination):** Pre-R-3, register in `system/runtime/daemon/tools.js`. Post-R-3, the tool is registered in `buildTools(ctx)` (§5.2 of the runtime-layer-hardening spec). No new `/internal/*` route is required — the tool is invoked through the existing MCP transport.

### 5.6 Recorder convention for new telemetry

Future faculties writing telemetry SHOULD use the umbrella row shape (`faculty`, `event_kind`, `ts`, `dimensions`, `metrics`, `meta`) via `recordTelemetry()`. The existing hot tables (`intuition_telemetry`, `recall_log`) are grandfathered — their column names predate the umbrella, but the aggregator translates them into the umbrella shape at rollup time (see §4.2 example SELECT — `meta.from AS source`, etc.).

**No forced migration for existing recorders.** Each faculty that wants to migrate to the umbrella raw shape can do so in a follow-up PR (one column rename per faculty, one aggregator SELECT rewrite). Out of scope for C3.

## Section 6 — Backwards-compat with in-flight specs

The five in-flight specs are the load-bearing reason C3 ships now — and the reason it ships as a *non-disruptive overlay*. Per-spec compat treatment:

### 6.1 B1 — per-hit reinforcement

B1 extends `recall_log` with three top-level fields (`reply_event_id`, `attribution`) and three keys per `ranked_hits[]` (`used`, `used_via`, `used_score`). All on `recall_log`. No new table.

- C3 disposition: `recall_log` stays hot-tier. The B1-introduced `attribution.mode` becomes a *dimension* in the rollup: `event_kind='recall_attribution'`, `dimensions={mode, used_count_bucket}`, `count=N`. B1's `show_attribution_health` tool (planned Theme 4 follow-up) can continue to read `recall_log` directly *or* switch to `telemetry_hourly` once rollups are flowing. C3 documents both paths; B1's spec doesn't need to change.
- No migration interaction. B1's `0009-per-hit-reinforcement.surql` lands before C3's `0017-telemetry-umbrella.surql` (or vice versa) — neither touches the other's tables.

### 6.2 A3 — recall eval + MMR

A3 adds `recall_eval_runs` (per-run) and extends `intuition_telemetry.meta` (`mmr_drops`, `mmr_path`, `mmr_vec_coverage`).

- C3 disposition: `recall_eval_runs` is **cold** (~1/release). Kept as-planned. `intuition_telemetry.meta.*` extensions are rolled up into the `'intuition'/'recall'` event_kind (`mmr_path` becomes a dimension; `mmr_drops`, `mmr_vec_coverage` become metric sums). The A3 spec doesn't need to change.
- A future fold-in path: when `recall_eval_runs` grows enough to need rollups (unlikely — eval is intrinsically per-run), it can adopt the umbrella shape via a `recall_eval` faculty entry. Out of scope here.
- **Schema precondition.** C3's rollup SELECT references `meta.from` and `meta.mmr_path` on `intuition_telemetry`. **Precondition:** A3's migration MUST add `DEFINE FIELD meta ON intuition_telemetry TYPE option<object> FLEXIBLE` (and the `recall_log.meta.from` field). C3's migration verifies this DEFINE exists via `INFO FOR TABLE intuition_telemetry` and fails loudly with a clear error if absent — preventing a silent rollup where every row groups into `dimensions: { source: null, mmr_path: null }`. If C3 lands before A3 (unlikely given migration numbering 0010 < 0017), the verification trips and C3 refuses to seed the config row; operator runs A3's migration first.

### 6.3 C1 — biographer batching

C1 adds counters on `runtime:biographer.value` (`batches_total`, `last_batch_size`, token sums, etc.). No new table.

- C3 disposition: `runtime:biographer.value` stays untouched (operational state, per §2). C1's counters are not aggregated; the existing C1 §11 query template (`SELECT … FROM runtime:biographer LIMIT 1`) keeps working.
- **Optional fold-in path** (not in this round): if the operator wants hourly trend data on batch fallback rates, the aggregator could be extended with a `biographer.batch_run` rollup that *samples* the counter row each tick and computes a delta. Out of scope; trivial to add later.

### 6.4 D1 — state inference

D1 adds `state_inference_telemetry` (per source per tick) and extends `recall_log.meta.focus_block_*`.

- C3 disposition: `state_inference_telemetry` is **cold** per §2.2 (writes are ~10s/day per source) — kept as-planned, with the umbrella row shape *aspirationally* documented as a future fold-in but not enforced. The `recall_log.meta.focus_block_*` keys are rolled up into the `'intuition'/'recall'` event_kind (`focus_block_present` becomes a dimension; `focus_block_tokens` becomes a metric sum).
- The D1 spec's `state_inference_telemetry` shape (`outcome`, `signal_hash`, `tokens_in`, `tokens_out`, `latency_ms`, `reason`) is *already aligned* with the umbrella row shape — `outcome` ↔ a dimension, `tokens_*` and `latency_ms` ↔ metric_sums. Future fold-in would be a column rename, not a redesign.

### 6.5 B2 — contradictions on recall

B2 adds fields to `intuition_telemetry.meta`: scalar `contradictions_surfaced` (int), scalar `conflict_block_tokens` (int), and object-shaped `contradictions_suppressed_by_rule` (per-rule counter map, ≤16 keys).

- C3 disposition: scalars roll up directly into `metric_sums.contradictions_surfaced_sum` and `metric_sums.conflict_block_tokens_sum` under `faculty='intuition'`, `event_kind='recall'` (per §4.2). The object-shaped `contradictions_suppressed_by_rule` is fanned out at write time (§3.4) into per-rule scalar metrics, each rolling up under its own `*_sum` key.
- Spec link: see B2's telemetry section — C3 is the contract for these rollups; B2's writer side feeds them.

### 6.6 C2 — dream per-step telemetry

C2 writes per-dream-sub-step rows to `cadence_telemetry` with `step='dream.<sub_step>'`. Volume is hot (every dream cycle, several sub-steps per cycle).

- C3 disposition: rolled up by the cadence hot-step bridge (§3.2 / §4.2 third SELECT) under `faculty='dream'`, `event_kind='<sub_step>'`. Without this bridge, C2's rows fell in a hole — `cadence_telemetry` is classified cold overall, but C2's rows are hot.
- Spec link: see C2's §6/§7/§8 — C3 absorbs C2's rollup requirement.

### 6.7 D2 — meta-cognition runs

D2 writes per-run rows to `meta_cognition_telemetry` (~1–5/day). Low volume.

- C3 disposition: rolled up under `faculty='meta_cognition'`, `event_kind='run'` (per §4.2) — included for *uniformity*, not query-cost reduction. Consumers may still read raw if they need the per-run payload (full reasoning trace).
- Spec link: see D2's telemetry section.

### 6.8 D3 — belief calls

D3 writes per-call rows to `cadence_telemetry` with `step='belief.call'` (and a `query` free-text field, plus a `sample_rate` for sampled writes).

- C3 disposition: rolled up by the cadence hot-step bridge (§3.2 / §4.2 third SELECT) under `faculty='belief'`, `event_kind='call'`. The `query` field MUST be placed in `meta` by the recorder, NOT in `dimensions` (§3.1 privacy & cardinality contract); a hash of the query may go in `dimensions.query_hash` if grouping by query is needed. `sample_rate` rolls up into `metric_sums.sample_rate_sum` for accurate post-sample population inference (§3.3).
- Spec link: see D3's telemetry section — C3 is the rollup contract; D3's writer feeds it.

### 6.9 The eight-in-flight summary

| Spec | New telemetry table | Disposition |
|---|---|---|
| B1 | none (extends `recall_log`) | Rolled up under `intuition.recall_attribution` |
| B2 | none (extends `intuition_telemetry.meta`) | Rolled up under `intuition.recall` (scalars + fanned-out per-rule counters per §3.4) |
| A3 | `recall_eval_runs` | Cold; kept as-planned. `intuition_telemetry.meta` rolled up. |
| C1 | none (extends `runtime:biographer.value`) | Operational state; not rolled up. Optional sample-rollup is a follow-up. |
| C2 | rows on `cadence_telemetry` (`step='dream.%'`) | Rolled up via cadence hot-step bridge under `dream.<sub_step>` |
| D1 | `state_inference_telemetry` | Cold; kept as-planned. `recall_log.meta.focus_block_*` rolled up. |
| D2 | `meta_cognition_telemetry` | Rolled up under `meta_cognition.run` (low volume; uniformity rollup) |
| D3 | rows on `cadence_telemetry` (`step='belief.%'`) | Rolled up via cadence hot-step bridge under `belief.call`; `query` stays in `meta` per §3.1 |

**C3 is the contract for all round-2 telemetry.** Every in-flight spec's metrics are either (a) explicitly covered by a rollup branch in §4.2 (B1, B2, C2, D2, D3, and the recall_log extension from D1), or (b) deliberately kept raw as cold-tier (A3 `recall_eval_runs`, D1 `state_inference_telemetry`, C1 counter rows). The rollup may be partial-v1 (e.g., D2 uniformity rollup is metrics-only with no buckets) but the contract is set here.

No forced rewrites. Every in-flight spec lands on its own schedule.

## Section 7 — Migration

`system/data/db/migrations/0017-telemetry-umbrella.surql`:

```surql
-- ============================================================================
-- Cognition C3: telemetry umbrella. One rollup table + one config row.
-- Existing per-faculty raw tables stay; this is purely additive.
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

DEFINE INDEX telemetry_hourly_key  ON telemetry_hourly FIELDS faculty, event_kind, hour;
DEFINE INDEX telemetry_hourly_hour ON telemetry_hourly FIELDS hour;

-- Indexes required by the recall_log_eval cursor SELECT (§4.2). Existing
-- recall_log indexes are recall_log_ts, recall_log_outcome, recall_log_session
-- — none cover `evaluated_at`. Without these, the hourly rollup full-scans
-- recall_log every tick.
DEFINE INDEX recall_log_evaluated_at      ON recall_log FIELDS evaluated_at;
DEFINE INDEX recall_log_outcome_evaluated ON recall_log FIELDS outcome, evaluated_at;

-- One-time backfill: pre-B1 recall_log rows have `outcome` set but
-- `evaluated_at IS NONE` (the field was added by B1). The cursor's
-- `WHERE evaluated_at IS NOT NONE` filter would silently drop them.
-- Stamp legacy rows with `ts` so the first rollup picks them up.
UPDATE recall_log SET evaluated_at = ts
  WHERE outcome != 'pending' AND evaluated_at IS NONE;

-- Seed config row. Ships with shadow_mode=true (§8.1).
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

-- Initialise the cursor row empty; aggregator falls back to
-- cursor_fallback_window_hours on first tick.
UPSERT runtime:`telemetry.cursor` SET value = {};
```

**Version slot.** Verified at draft time: existing migrations on disk end at `0008-doctor.surql` (`system/data/db/migrations/`). Cross-cutting migration slot allocation (post-review):

- B1 → `0009-per-hit-reinforcement.surql`
- A3 → `0010-recall-eval-mmr.surql`
- C1 → `0011-biographer-batching.surql`
- D1 → `0012-state-inference.surql`, `0013-state-inference-shadow.surql`, `0014-state-inference-enable.surql`
- B2 → `0015-contradictions-on-recall.surql`
- B2 follow-up → `0016-contradictions-followup.surql`
- **C3 → `0017-telemetry-umbrella.surql`** (this spec)
- D2 → `0018-meta-cognition.surql`
- D3 → `0019-belief-calls.surql`
- C2 → `0020-dream-per-step-telemetry.surql` (renumbered from earlier 0016 claim to land after C3)

C3 is **0017**. The migration is order-independent at the SurrealQL level (it touches no other surface beyond adding indexes on `recall_log` and seeding two `runtime:` rows), but the §6.2 precondition (A3's `meta` field DEFINE) means A3 (0010) MUST run first. Migrations are applied in numeric order by `migrate.js`, so 0010 lands before 0017 naturally. If a different gap is free at PR time, the version slot is renamed; nothing in C3 depends on its absolute number (`migrate.js` versioning is purely alphabetical-then-numeric, per `system/data/db/migrate.js:21-25`).

**No backfill.** The rollup table starts empty; the aggregator fills it from raw on first tick (one tick = one `cursor_fallback_window_hours` of history rolled up). No data is lost; the raw tables retain everything.

## Section 8 — Rollout

### 8.1 Shadow mode

The migration seeds `shadow_mode: true`. While shadow:

- Aggregator job runs on schedule.
- `telemetry_hourly` rows are written (rollups are computed).
- `show_telemetry_rollup` MCP tool is **registered but returns an error** if `shadow_mode` is true: `{ error: 'show_telemetry_rollup is in shadow mode; flip runtime:telemetry.config.shadow_mode to false to enable.' }`.
- `robin doctor` does **not** read `telemetry_hourly` yet (the doctor-side widget lands as a Theme 4 follow-up).

This lets us watch the rollup row growth, validate the math (compare a sample hour's rollup against a hand-aggregated raw SELECT — verification §9.3), and tune the cursor cadence without exposing half-baked numbers to anyone.

### 8.2 Promote to general availability

After one week of clean shadow telemetry:

```surql
UPDATE runtime:`telemetry.config` SET value.shadow_mode = false;
```

One-line flip. No daemon restart. The next `show_telemetry_rollup` call returns rollups; doctor widget (if landed) starts reading them.

### 8.3 Rollback

**Soft rollback (config flip).** `UPDATE runtime:`telemetry.config` SET value.enabled = false;` — applied on the next tick (not mid-tick; see §11 clarification). The job no-ops, cursor stays where it was, `telemetry_hourly` row growth halts. Flip back to `true` and rollups resume from the cursor.

**Hard rollback (data wipe / shape redesign).** A follow-up migration (e.g., `0021-telemetry-reset.surql` — slot picked at PR time to land after C3) removes every schema artifact C3 added. The migration runner (`migrate.js:48-54`) rejects edits to already-applied migrations via checksum, so the rollback path goes through a *new* migration file, not by editing `0017`.

C3's schema artifacts, exhaustively (each is independently `REMOVE`-able):

| Artifact | Type | Removal |
|---|---|---|
| `telemetry_hourly` | Table | `REMOVE TABLE telemetry_hourly;` |
| `telemetry_hourly_key` | Index on `telemetry_hourly` | `REMOVE INDEX telemetry_hourly_key ON telemetry_hourly;` |
| `telemetry_hourly_hour` | Index on `telemetry_hourly` | `REMOVE INDEX telemetry_hourly_hour ON telemetry_hourly;` |
| `recall_log_evaluated_at` | Index on `recall_log` | `REMOVE INDEX recall_log_evaluated_at ON recall_log;` |
| `recall_log_outcome_evaluated` | Index on `recall_log` | `REMOVE INDEX recall_log_outcome_evaluated ON recall_log;` |
| `runtime:telemetry.config` | KV row | `DELETE runtime:`telemetry.config`;` |
| `runtime:telemetry.cursor` | KV row | `DELETE runtime:`telemetry.cursor`;` |

**Note: the §7 backfill (`UPDATE recall_log SET evaluated_at = ts WHERE outcome != 'pending' AND evaluated_at IS NONE`) is not reversible** — once legacy rows have `evaluated_at` stamped, there's no record of which were stamped vs. natively set. This is acceptable because the field is semantically correct after stamping (the row *was* evaluated; we just don't know precisely when). Rollback leaves the field populated.

**Note: §5.3.1's hard ceiling prune of stuck pending rows is additive** — disabling C3 stops it from running but doesn't restore deleted rows. Pending rows past 30d are dead-by-bug data; the audit trail is the `pending_recall_log_force_pruned` telemetry rows the prune emits.

### 8.4 No flag flips required for existing surfaces

Critical: `intuition_telemetry`, `recall_log`, `cadence_telemetry`, etc. continue to write and be read exactly as today. C3 is purely additive at the data plane. The only behavioral change is the new `telemetry-rollup` job tick — and that's behind `runtime:telemetry.config.enabled`.

## Section 9 — Test plan

### 9.1 Unit tests

`system/tests/unit/telemetry-rollup-math.test.js` (new):

1. **Hour bucket math**: feed 6 fake `intuition_telemetry` rows across two hours (3 each), assert the rollup produces 2 rows with `count=3` each and correct sums.
2. **Dimensions hash determinism**: same dimensions object produces the same hash regardless of key insertion order. Different dimensions produce different hashes.
3. **Metric sums**: `latency_ms_sum = sum(latency_ms)` exactly; no rounding drift.
4. **Percentile bucket (load-bearing)**: 100 rows with latency 1..100ms → `p50 ≈ 50`, `p95 ≈ 95`, `p99 ≈ 99`. **This test validates the `math::percentile(field, N)` inside `GROUP BY` SurrealQL idiom (§4.2).** If it fails on a future SurrealDB upgrade, `rollup.js` falls back to a client-side percentile path (also covered by a sibling test) — the spec's primary path is the SurrealQL one, but the fallback is a single-file swap, not a schema change.
5. **Empty window**: cursor window with zero rows → no UPSERTs, cursor still advances.
6. **Single dimension absent**: rows where `meta.mmr_path` is null group into a `dimensions: { mmr_path: null }` bucket (not dropped).
7. **Object-shaped metric fan-out (§3.4)**: `recordTelemetry({ metrics: { contradictions_suppressed_by_rule: { low_confidence: 3, private_redaction: 1 } } })` writes `contradictions_suppressed_low_confidence=3` and `contradictions_suppressed_private_redaction=1` as scalar metrics. Passing >16 keys throws.
8. **Dimension validation (§3.1)**: `recordTelemetry({ dimensions: { source: 'a'.repeat(65) } })` throws ("dimension value exceeds 64 chars"). `recordTelemetry({ dimensions: { mode: 'has spaces' } })` throws (chars outside `[A-Za-z0-9_.-]`). `recordTelemetry({ dimensions: { kind: 'normal_value-1.0' } })` succeeds. Floats / nested objects / non-ASCII unicode in `dimensions` values also throw per §3.5.

`system/tests/unit/telemetry-retention.test.js` (new):

9. **Prune respects timestampField**: pruning `telemetry_hourly` uses `hour`, pruning `intuition_telemetry` uses `ts`.
10. **Prune respects `where`**: `pruneRawTelemetry(recall_log, where: 'outcome != "pending"')` does not delete pending rows even if older than retention.
11. **Pending-row hard ceiling (§5.3.1)**: a `recall_log` row with `outcome='pending'` and `ts < now - 30d` IS deleted by the hard-ceiling stage; the prune emits a `pending_recall_log_force_pruned` telemetry row.

### 9.2 Integration tests

`system/tests/integration/telemetry-rollup-job.test.js` (new):

12. **Aggregator idempotency**: run the job twice over the same raw rows; assert `telemetry_hourly` row count and `count` field are identical after both runs (not doubled).
13. **Cursor advance**: after a successful run, `runtime:telemetry.cursor.value.intuition_telemetry` is set to `$cutoff` (not `now`). Run again immediately — fewer rows scanned.
14. **Cursor fallback on missing cursor**: delete `runtime:telemetry.cursor`, run the job; assert it falls back to `now - cursor_fallback_window_hours` and the cursor row is recreated.
15. **Pending recall_log not rolled up**: seed a `recall_log` row with `outcome='pending'` and `evaluated_at IS NONE`; run the job; assert the row is NOT counted in `telemetry_hourly` (the `evaluated_at IS NOT NONE` filter excludes it) and the `recall_log_eval` cursor does NOT advance past `now - cutoff_safety_seconds` in a way that would skip the row when it eventually evaluates.
16. **Recall_log rolls up after evaluation**: same row, but UPDATE to set `outcome='reinforced'` and `evaluated_at = time::now()`, then re-run; assert the rollup picks it up.
17. **Per-faculty fail-soft**: induce a SurrealQL error in the `intuition_telemetry` SELECT (e.g., by passing a malformed `$cursor` parameter for that one branch); assert the `recall_log_eval` rollup still runs and its cursor still advances; the intuition cursor stays at its previous value. The same fail-soft contract applies to the `cadence_telemetry_hot` and `meta_cognition_telemetry` branches once they're wired.
18. **Prune does not touch pending recall_log (default path)**: a `recall_log` row aged past `raw_retention_days` (7d) with `outcome='pending'` is **not** deleted by Stage 2 (the `where` clause filters it out).
19. **Shadow mode**: with `shadow_mode=true`, `show_telemetry_rollup` returns an error message; `telemetry_hourly` row growth continues normally.
20. **Cadence hot-step bridge (§3.2)**: seed `cadence_telemetry` rows with `step='belief.call'` (3) and `step='dream.gather'` (5) and `step='state_inference'` (2); run aggregator; assert `belief.call` rows roll up under `faculty='belief'`, `event_kind='call'`; `dream.gather` rows roll up under `faculty='dream'`, `event_kind='gather'`; `state_inference` rows are NOT rolled up.
21. **Backfill UPDATE applies once (§7)**: seed legacy `recall_log` rows with `outcome='reinforced'` and `evaluated_at IS NONE`; apply migration 0017; assert `evaluated_at` is now equal to `ts` on those rows; rerun is a no-op. Pending rows are untouched.
22. **§6.2 schema precondition fails loudly**: if A3's `meta` field DEFINE is missing on `intuition_telemetry`, C3 migration's `INFO FOR TABLE` check throws with a clear error message; rollup doesn't seed config.

### 9.3 Backward-compat tests

`system/tests/integration/telemetry-backwards-compat.test.js` (new):

23. **`explain_recall` still works**: seed `recall_log` rows; run aggregator; assert `explain_recall` reads raw `recall_log` and returns the same content it did before (the rollup does not modify `recall_log`).
24. **B1's attribution.mode counts match**: seed 5 `recall_log` rows with `attribution.mode = 'citation'` and 3 with `'fallback_no_reply'`; run aggregator; assert `SELECT count FROM telemetry_hourly WHERE faculty='intuition' AND event_kind='recall_attribution' AND dimensions.mode='citation'` returns `count=5`.
25. **A3's `mmr_path` dimension propagates**: seed `intuition_telemetry` rows with `meta.mmr_path = 'cosine'` (4) and `'substring'` (2); run aggregator; assert the rollup splits them into two rows with the correct counts.
26. **D1's `focus_block_present` dimension propagates**: seed `recall_log` rows with `meta.focus_block_present = true` (3) and `false` (5); run aggregator; assert the rollup splits them.
27. **B2 fan-out propagates**: seed `intuition_telemetry` rows with `meta.contradictions_suppressed_by_rule = { low_confidence: 2, private_redaction: 1 }`; run aggregator; assert `telemetry_hourly.metric_sums.contradictions_suppressed_low_confidence_sum=2` and `contradictions_suppressed_private_redaction_sum=1`.
28. **D3 query field stays in meta**: seed `cadence_telemetry` rows with `step='belief.call'` and `meta.query='free text user query'`; run aggregator; assert `dimensions` on the resulting rollup row does NOT contain `query` (per §3.1); raw row's `meta.query` is unchanged.
29. **Hand-aggregated raw matches rollup**: pick a 1-hour window, hand-aggregate `intuition_telemetry` via a one-off SELECT, compare against the equivalent `telemetry_hourly` row. They should match within ±1 row (rows landing on the boundary second go to one or the other deterministically).

### 9.4 Verification gates

30. **MCP tool read-only**: `system/io/mcp/tools/show-telemetry-rollup.js` source contains zero `CREATE` / `UPDATE` / `DELETE` keywords (existing `introspection-tools-readonly.test.js` guard).
31. **Migration is reversible-ish**: in a test-only fixture, applying then reversing every artifact from the §8.3 table produces a clean baseline — no orphan data, no broken indexes. Verifies each artifact in §8.3's table is independently `REMOVE`-able.
32. **`robin doctor --health` unaffected**: pre-C3 behavior preserved (the C3-aware doctor widget is a follow-up; the unchanged-doctor invariant is asserted by the existing health.js tests).
33. **Doctor pending-row probe (§5.3.1)**: doctor health check counts `recall_log WHERE outcome='pending' AND ts < now - 7d`; warns when count > 100.

## Section 10 — File-by-file changes

**Created:**

- `system/data/db/migrations/0017-telemetry-umbrella.surql` — schema + seed + backfill UPDATE + recall_log indexes (§7).
- `system/cognition/telemetry/record.js` — `recordTelemetry({ faculty, event_kind, ts?, dimensions?, metrics?, meta? })`. Writes to a per-faculty raw table (the existing `intuition_telemetry` / `recall_log`) OR to a new umbrella raw table if/when faculties adopt the umbrella shape. Enforces the §3.1 dimension contract (length, charset, type) and the §3.4 object-shaped metric fan-out + ceiling. Out of scope to migrate existing recorders.
- `system/cognition/telemetry/rollup.js` — `rollupHotTelemetry({ db, cfg })`. Pure function over the DB handle. Iterates the registry, running enabled SELECTs; UPSERTs `telemetry_hourly` rows; advances per-cursor.
- `system/cognition/telemetry/rollup-registry.js` — registry of per-faculty rollup SELECTs, cursor names, source tables, and projection helpers (§5.4). One entry per `(faculty, event_kind)` family. Adding a new hot source = one new entry + one `faculties_enabled` flip.
- `system/cognition/telemetry/retention.js` — `pruneRawTelemetry({ db, table, before, where?, timestampField? })`. One DELETE per call; fail-soft on error.
- `system/cognition/telemetry/config.js` — `readTelemetryConfig(db)`. Reads `runtime:telemetry.config`; cached per tick.
- `system/cognition/jobs/internal/telemetry-rollup.js` — internal job entry; calls rollup + retention + pending hard-ceiling prune (§5.3.1); fail-soft.
- `system/cognition/jobs/builtin/telemetry-rollup.md` — job descriptor (markdown-cron — the existing job pattern, not R-2's bucket scheduler; §5.2 / §11 clarification).
- `system/io/mcp/tools/show-telemetry-rollup.js` — read-only MCP tool.
- `system/tests/unit/telemetry-rollup-math.test.js` — §9.1 tests 1-8.
- `system/tests/unit/telemetry-retention.test.js` — §9.1 tests 9-11.
- `system/tests/integration/telemetry-rollup-job.test.js` — §9.2 tests 12-22.
- `system/tests/integration/telemetry-backwards-compat.test.js` — §9.3 tests 23-29.

**Modified:**

- `system/runtime/daemon/tools.js` (or, post-R-3, `system/runtime/daemon/tools.js`'s registry array) — register `show_telemetry_rollup`. One-line import + one-line factory call. R-3 coordination: when the file is restructured per `2026-05-11-runtime-layer-hardening-design.md` §5, the tool registration moves into `buildTools(ctx)` — same one-line addition, different home.
- `docs/architecture.md` — add a short paragraph under "Operational" / "Evolution layer" naming `telemetry_hourly` and pointing at this spec. Diagram row: `telemetry_hourly · hourly rollups of hot faculties (intuition, recall_log); 90d retention`.
- `docs/faculties.md` — add a short subsection under introspection: `show_telemetry_rollup` returns hourly rollups from `telemetry_hourly`. List the supported `faculty` / `event_kind` values.

**Not modified (deliberately):**

- `system/cognition/intuition/inject.js` and `reinforcement.js` — continue to write to `intuition_telemetry` / `recall_log` directly. No recorder changes.
- `system/cognition/dream/*` — `cadence_telemetry` and `compaction_telemetry` writes unchanged.
- D1's `state_inference_telemetry` writer — unchanged.
- A3's `recall_eval_runs` writer — unchanged.

## Section 11 — Clarifications and open questions

### 11.1 Clarifications (load-bearing, called out by review)

- **`enabled` knob is next-tick, not mid-tick.** §8.3's "instant" rollback is really "next-tick": flipping `runtime:telemetry.config.enabled = false` causes the *next* `telemetry-rollup` job invocation to no-op. An in-flight tick (already past the config read) runs to completion. Same for shadow-mode flips (§8.2). Worst-case lag: ~60 min (one tick cadence). Acceptable for a telemetry surface.
- **Heartbeat scheduler vs. R-2 bucket scheduler.** The aggregator job runs as a markdown-cron job (the existing pattern under `system/cognition/jobs/builtin/*.md`, dispatched by `system/runtime/daemon/dispatcher-tick.js`). R-2's bucket scheduler is for daemon plumbing only and is **not** the host for this job.
- **R-3 MCP tool registration.** C3 expects to land *before* R-3 — pre-R-3, the `show_telemetry_rollup` tool is registered in `system/runtime/daemon/tools.js` directly. If R-3 ships first, the registration moves to `buildTools(ctx)` per R-3 §5.1 (same one-line addition, different host file). Either order works without spec changes.
- **`math::percentile` inside `GROUP BY` is a load-bearing assumption.** §9.1 test 4 validates the SurrealQL idiom. If a future engine release tightens the contract (or if the assumption was wrong on close reading of the docs), `rollup.js` falls back to client-side percentile — single-file swap, no schema change. See §4.2 percentile note.
- **C3 is the contract for all round-2 telemetry.** Per §6.5–§6.9: every in-flight spec's metrics are accounted for here — either as an explicit rollup branch in §4.2 (B1, B2, C2, D1's recall_log extensions, D2, D3) or as cold-tier kept-as-planned (A3 `recall_eval_runs`, D1 `state_inference_telemetry`, C1 counter rows). In-flight specs should cross-link their telemetry sections here.

### 11.2 Open questions

These are real ambiguities the design *acknowledges and defers*; not gaps the author missed.

- **Daily rollup (`telemetry_daily`).** Listed as a config field (`daily_retention_days`) but not implemented in this round. Add when (a) `telemetry_hourly` grows past ~10K rows (at ~10 rows/hour × 24h × 90d × ~5 dimension sets that's ~108K rows — already past the threshold by month-3 of `intuition` traffic), or (b) the doctor widget wants 1-year trends. Cheap follow-up: one more job tick (daily) + one more UPSERT shape (`hour` → `day`).
- **Cold-faculty fold-in.** `cadence_telemetry`, `state_inference_telemetry`, `recall_eval_runs` would all *fit* the umbrella shape (their per-row sizes are small; their dimension/metric splits are natural). Whether to fold them in is a question of "is there a consumer that wants a unified view?". Today there isn't — `show_step_health` reads `cadence_telemetry` directly. Revisit after Theme 4's introspection tools have soaked.
- **Counter-row sampling.** C1's `runtime:biographer.value` counters could be hourly-sampled by the aggregator (compute delta from previous tick → write a `biographer.batch_run` rollup row) to give trend data. Trivial to add; not needed for B1/B2/A3/D1 in this round.
- **Dimensions hash collisions.** 24 hex chars (~96 bits) is overkill at our scale but cheap. If a future faculty produces a dimension set with collision-prone keys (e.g., free-form user-input strings), bump to 32 chars. Out of scope today.
- **Multi-process aggregation.** Robin's daemon is single-writer (`docs/architecture.md` §"The daemon owns the DB"). If `robin-mcp` ever sharded, the aggregator would need a lock (or each shard would write to its own hour bucket and a meta-aggregator would merge — same idiom as the doctor health-check). Not a near-term concern.
- **Tool naming collision.** `show_telemetry_rollup` parallels the existing `show_step_health` / `show_pending_triggers` shape from Theme 4. If those tools eventually wrap `telemetry_hourly` reads (instead of reading raw cadence/dream tables), the read-from-rollup logic can centralize behind `show_telemetry_rollup` and the legacy tools become thin filters over it. Not a blocker; pure refactor when/if it makes sense.
- **Percentile computation engine.** `math::percentile(field, N)` in SurrealQL is the natural choice (cited in §4.2). If percentiles become a per-tick hot spot, swap for a t-digest sketch maintained as the recorder writes (no per-tick recomputation). Defer until telemetry shows the SELECT is slow.

## Section 12 — Cost envelope

- Per aggregator tick (default 60 min cadence):
  - +1 SELECT on `runtime:telemetry.config` (cached for the tick).
  - +1 SELECT on `runtime:telemetry.cursor` (cached for the tick).
  - +N SELECTs against hot raw tables — **one per cursor entry**. Active in this round: 4 (intuition_telemetry, recall_log_eval, cadence_telemetry_hot, meta_cognition_telemetry). Each is a `GROUP BY hour, <dimensions>` scan over ~1 hour of new rows (worst case ~10 rows on a working session; D2 typically 0–1 row). Sub-50ms per SELECT. `recall_log_eval` SELECT is bounded by the new `recall_log_outcome_evaluated` index (§7).
  - +M UPSERTs on `telemetry_hourly` — **one per (faculty, event_kind, hour, dimensions_hash) tuple in the window**. With 4 hot rollups × ~3 dimension combinations × 1–2 hours per tick = ~12–24 UPSERTs per tick. Sub-200ms total.
  - +1 UPSERT on `runtime:telemetry.cursor` to advance.
  - +3 DELETEs from Stage 2 retention (one per raw table being pruned) + 1 DELETE for Stage 2b pending hard ceiling — bounded by `where ts < ...` indexes (`intuition_telemetry_ts`, `recall_log_ts`, `telemetry_hourly_hour`, `recall_log_outcome_evaluated`). Sub-50ms each.
  - Total wall time per tick: <1s typical (was <500ms before adding cadence_hot + meta_cognition branches; budget grows linearly with cursor count).
- New LLM tokens: **zero**. New embedding tokens: **zero**.
- Memory: aggregator holds at most ~100 rollup row payloads at once (a few KB total per tick).
- Storage growth: `telemetry_hourly` at ~10 rollup rows/hour × 24 × 90d × 5 dimension sets ≈ 108K rows. Each row ~300 bytes serialised → ~30 MB. Well within the surrealkv envelope.
- Read cost for `show_telemetry_rollup` with default `PT24H` window: ≤ ~240 rows scanned (10 rollup rows/hour × 24h × N faculties — but the compound index `(faculty, event_kind, hour)` filters before scan).

Within the post-alpha.16 cost envelope. No cadence-budget interaction (this is not a cadence-eligible step).

## Section 13 — Sequencing within C3

Short engineering view (the operational rollout sequence lives in §8). Land-order:

1. Schema migration `0017-telemetry-umbrella.surql` (additive; new indexes on `recall_log`; one-time backfill UPDATE on legacy rows; `shadow_mode: true`).
2. `record.js` + `rollup.js` + `rollup-registry.js` + `retention.js` + `config.js` + unit tests (§9.1 #1-11). No production behavior change (no consumers yet).
3. Job descriptor + `telemetry-rollup.js` internal job (rollup + Stage 2 prune + Stage 2b pending hard-ceiling). Integration tests §9.2 #12-22. Production behavior: aggregator runs hourly, writes `telemetry_hourly`, no consumers.
4. `show_telemetry_rollup` MCP tool (returns shadow-mode error). Verification gates §9.4 #30-33 (read-only, doctor probe).
5. Backwards-compat tests §9.3 #23-29 pass.
6. After one week in shadow on Kevin's instance, flip `shadow_mode = false` via the runtime config UPDATE. Theme 4's doctor widget (follow-up) starts reading rollups.

## See also

- `2026-05-11-cognition-b1-per-hit-reinforcement-design.md` — extends `recall_log.attribution`; rolled up under `intuition.recall_attribution`.
- `2026-05-11-cognition-b2-contradictions-on-recall-design.md` — extends `intuition_telemetry.meta` with `contradictions_surfaced`, `contradictions_suppressed_by_rule` (object-shaped, fanned out per §3.4), `conflict_block_tokens`; rolled up under `intuition.recall`.
- `2026-05-11-cognition-a3-recall-eval-and-mmr-design.md` — extends `intuition_telemetry.meta` (precondition for C3's rollup, per §6.2); new `recall_eval_runs` table (cold, kept as-planned).
- `2026-05-11-cognition-c1-biographer-batching-design.md` — counters on `runtime:biographer.value` (operational state, not rolled up).
- `2026-05-11-cognition-c2-dream-per-step-telemetry-design.md` — writes per-sub-step rows to `cadence_telemetry` (`step='dream.%'`); rolled up via the hot-step bridge under `dream.<sub_step>`.
- `2026-05-11-cognition-d1-state-inference-design.md` — new `state_inference_telemetry` (cold, kept as-planned); extends `recall_log.meta.focus_block_*`.
- `2026-05-11-cognition-d2-meta-cognition-design.md` — writes per-run rows to `meta_cognition_telemetry`; rolled up under `meta_cognition.run`.
- `2026-05-11-cognition-d3-belief-calls-design.md` — writes per-call rows to `cadence_telemetry` (`step='belief.call'`); rolled up via the hot-step bridge under `belief.call`; `query` text stays in `meta` per §3.1.
- `2026-05-11-runtime-layer-hardening-design.md` §5 — R-3 route table; `show_telemetry_rollup` registration coordination (per §11.1).
- `2026-05-11-robin-v2-theme-4-observability-design.md` — introspection tools; future `robin doctor` widget consumer.
- `system/cognition/jobs/internal/log-rotate.js` — retention precedent (daemon.log size-based rotation).
- `system/cognition/jobs/internal/reinforce-recall.js` — heartbeat-driven internal job precedent.
- `docs/architecture.md` — full telemetry surface diagram.
