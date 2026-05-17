# Cognition E1 — Self-Improvement v2 Design

**Author:** Kevin (with Claude during /superpowers:brainstorming, 2026-05-17)
**Status:** Draft, awaiting user review before /superpowers:writing-plans
**Replaces / extends:** No replacement. Extends `c2-dream-dag`, `c3-telemetry-umbrella`, `b1-per-hit-reinforcement`, `phase-4b2-comm-style`, `phase-4b3-predictions`.
**Feature flag:** `runtime:self-improvement-v2.value.enabled`

---

## TL;DR

Robin's six declared learning surfaces (biographer, reflection, reinforcement, comm-style, predictions, dream consolidation) all execute on schedule but yield almost nothing. In 7 days of production use: 0 new rule_candidates from 194 reflection cycles, 0 patterns recorded, 0 active predictions, all 19 arcs unnamed, `calibration.by_kind = {}`. Only comm-style works (confidence 0.93). The other agent's parallel investigation independently traced part of this to a broken `events.source` enum that silently drops every `record_correction` call.

This spec adds an always-on `introspection` faculty that watches the daemon's event stream and writes `task_outcome` memos, plus five new dream steps that synthesize those outcomes into `playbook` memos (capability axis) and `confidence_band` memos (decision calibration axis). Nine new MCP tools surface playbooks, calibration, and provenance (two writes, seven reads). The existing 5-faculty arch gains a 6th (introspection) sibling. Cost: ~$2/day in additional LLM spend at defaults, doubling current Robin costs to ~$120/month.

Two axes of "smarter over time" are in scope: **capability synthesis** (Robin learns *how* to do recurring tasks better via playbooks) and **decision calibration** (Robin's confidence, comm-style, and behavior rules sharpen via prediction outcomes and corrections). The other two axes — knowledge synthesis and retrieval quality — are out of scope; a parallel investigation is fixing the plumbing layer that those depend on.

---

## Background

### Observed failure modes (2026-05-17, this Robin instance)

- `list_patterns()` → `[]`. Pattern table empty since v2 boot.
- `list_open_predictions()` → 1 smoke test + 1 ops prediction. `calibration.by_kind = {}`. `total_open=0`, `total_resolved=0`.
- `list_arcs(limit=50)` → 19 active, **every `name: null`**. Arc-naming step never fires successfully.
- `list_rules({status: 'all'})` → 100 active, all `created_at=2026-05-12T08:46:55Z` (single batch from v1 quarantine import), all `source_candidate=null`. Zero rules earned through dream candidate flow.
- `show_pending_triggers()` → `{count: 0}`. Not a queue-depth problem.
- `show_step_health(7d)` → every dream step 100% success rate. `reflection` ran 194 times in the window.

The pipeline is healthy but unfilled. Engine running, nothing coming out.

### Root causes identified during brainstorm

1. **Broken `events.source` enum** — `record_correction()` writes `source='explicit_correction'`, which is not in the enum. Daemon log shows `tool remember failed: unknown source "explicit-correction"`. Corrections never become events, so reflection has nothing to cluster.
2. **Reflection clusters at 0.85 cosine on content alone** — Kevin's terse correction style ("no", "1", "different") produces low pairwise similarity *across task contexts*. Same threshold + same content-only clustering means no clusters form.
3. **Predictions have no calling discipline** — the tool exists but is uncited. No rule says "call `predict()` for falsifiable claims." Free-form `statement_kind` means even if predictions accumulated, calibration math couldn't aggregate them.
4. **No concept of "capability"** — Robin has rules (behavior) and knowledge (facts) but no first-class representation of *how to execute a recurring task*. Daily-briefing structure exists as rules + protocol markdown; recall query strategy is implicit; outbound write recipes don't exist. Nothing learns task-specific HOW.

### Decisions taken during brainstorm

| Decision | Choice | Rationale |
|---|---|---|
| Axes of "smarter" | Capability synthesis + Decision calibration | Knowledge synthesis and retrieval quality depend on plumbing fixes the parallel investigation is doing. |
| Signal sources | All four (explicit corrections, prediction outcomes, outcome inference, self-grading) | Compose through one substrate; marginal cost is small once one is built. |
| Cadence | Hybrid — fast loop for cheap signals, nightly dream for expensive synthesis | Continuous everywhere costs 10–15× current Opus spend; nightly-only delays correction → behavior by 24h, kills predictions. |
| Autonomy | Auto-apply + correction retraction, with candidate gate for cross-turn behavioral changes | Mirrors existing action-trust AUTO→ASK auto-demote pattern. |
| Scope | Approach C — substrate + persistent introspection faculty | User explicitly chose; comprehensive option. |

---

## Architecture overview

```
                                         ┌────────────────────┐
                                         │   user / agent     │
                                         └──────────┬─────────┘
                                                    │
        ┌───── events (existing) ───────────────────┼───────────────────┐
        │                                           │                   │
        ▼                                           ▼                   ▼
 ┌─────────────┐                            ┌──────────────┐    ┌────────────────┐
 │ biographer  │                            │ correction-  │    │ task_close     │
 │ (entities,  │                            │ inference    │───►│ enqueue from 5 │
 │  edges)     │                            │ (new module) │    │ sources        │
 └─────┬───────┘                            └──────┬───────┘    └──────┬─────────┘
       │                                           │                   │
       │                                           ▼                   ▼
       │                                ┌──────────────────────────────────────┐
       │                                │  task_close_queue (new table)        │
       │                                └────────────────┬─────────────────────┘
       │                                                 │
       │                                                 ▼
       │                                ┌─────────────────────────────────────┐
       │                                │  introspection faculty (NEW)        │
       │                                │  - 1-min drain                      │
       │                                │  - inline grading (budget-gated)    │
       │                                │  - structural outcome inference     │
       │                                │  - writes task_outcome memos        │
       │                                └────────────────┬────────────────────┘
       │                                                 │
       ▼                                                 ▼
 ┌──────────────────────────────────────────────────────────────────────┐
 │  memos (existing table + new kinds: playbook, task_outcome,          │
 │  confidence_band, comm_style_snapshot)                                │
 └────────────────────────────────┬─────────────────────────────────────┘
                                  │
                                  ▼
 ┌──────────────────────────────────────────────────────────────────────┐
 │  dream pipeline (existing DAG + new steps)                            │
 │  L1: step-reflection (existing) → step-outcome-grading (NEW)          │
 │  L2: step-playbook-synthesis (NEW) ← reads reflection output          │
 │       step-calibration-bucket (NEW) ← sole writer of confidence_band  │
 │       step-prediction-taxonomy (NEW, weekly)                          │
 │       step-comm-style (existing)                                       │
 └────────────────────────────────┬─────────────────────────────────────┘
                                  │
                                  ▼
 ┌──────────────────────────────────────────────────────────────────────┐
 │  inject path (existing intuition) — extended:                         │
 │  prepend playbook[task_type] after memory excerpts                    │
 └──────────────────────────────────────────────────────────────────────┘
```

---

## Section 1: Substrate

### Task taxonomy (new noun)

A `task_type` is a stable identifier for a recurring assistant operation. Held in `system/cognition/introspection/task-taxonomy.js` as a bounded enum. Free-form values are rejected at write time. Four prefixes:

- **`job:<name>`** — declared jobs from `system/cognition/jobs/builtin/*` and `user-data/jobs/*`. Examples: `job:daily-briefing`, `job:health-trends`.
- **`outbound:<tool>:<action>`** — outbound writes by action-class. Examples: `outbound:discord_send:send_dm`, `outbound:github_write:create-issue`.
- **`recall:<intent>`** — recall queries bucketed by intent. Initial: `recall:person`, `recall:past_session`, `recall:domain_facts`, `recall:default`.
- **`turn:<intent>`** — general assistant turns. Initial: `turn:recommend`, `turn:analyze`, `turn:plan`, `turn:execute_change`, `turn:default`.

Token caps and inject costs declared per prefix:

| Prefix | length_cap_tokens | Inject cost |
|---|---|---|
| `job:` | 1200 | per job fire |
| `outbound:` | 400 | per outbound write |
| `recall:` | 600 | per recall call |
| `turn:` | 800 | per classified turn |

Enum extension is candidate-gated (user approves via `update_rule`); seed enum is hand-maintained in skeleton/.

### New memo kinds (no schema migration; `memos.kind` is a free string)

**`playbook`** — synthesized recipe for one `task_type`. Markdown body + YAML frontmatter:
```yaml
task_type: job:daily-briefing
version: 7
active: true
cold_start: false
trust: trusted
signal_count: 23
declared_sections: [inbox, calendar, markets, whoop, weather, birding, watch_list, nhl, focus]
length_cap_tokens: 1200
last_synthesized_at: 2026-05-17T03:42:11Z
evidence_outcomes: [memos:abc..., memos:def...]
related_rules: [rules:dd573373..., rules:23bc58df...]
related_comm_style_snapshot: memos:hjk...
```
Exactly one row per `task_type` carries `active=true`. Indexed `kind+meta.task_type+active+derived_at`.

**`task_outcome`** — one task invocation, graded. Unique on `(task_type, task_id)`; later writes merge `signals` (`explicit_correction` > `outcome_inference` > `self_grade` in conflict). Fields:
```
content: one-line grade summary
meta: {
  task_type, task_id, source_event,
  signals: { explicit_correction?, prediction_resolution?, outcome_inference?, self_grade? },
  score: 0..1 | null,
  playbook_used?, playbook_version?
}
```
Indexed `kind+meta.task_type+ts`.

**`confidence_band`** — per-bucket calibration math, one row per `(statement_kind, bucket)`. Replaces empty `persona.calibration.by_kind` blob. Fields:
```
content: one-line narrative ("event_timing predictions at 0.8 conf: 60% accurate, n=15")
meta: {statement_kind, bucket: 0.0..0.9, n, correct, accuracy_laplace, last_recomputed_at}
```

**`comm_style_snapshot`** — versioned snapshot of comm-style for citation. Singleton `persona:singleton.comm_style.last_snapshot_id` points to the active row. Created on every comm-style synthesis. Old snapshots stay with `active=false`.

### New table: `task_close_queue`

Queue rows with TTL — not durable knowledge, so not a `memos` kind. Schema:
```surql
DEFINE TABLE task_close_queue SCHEMAFULL;
DEFINE FIELD task_type ON task_close_queue TYPE string;
DEFINE FIELD task_id ON task_close_queue TYPE string;
DEFINE FIELD event_id ON task_close_queue TYPE record<events>;
DEFINE FIELD payload ON task_close_queue FLEXIBLE TYPE object;
DEFINE FIELD enqueued_at ON task_close_queue TYPE datetime DEFAULT time::now();
DEFINE FIELD claimed_at ON task_close_queue TYPE option<datetime>;
DEFINE FIELD claimed_by ON task_close_queue TYPE option<string>;
DEFINE FIELD expires_at ON task_close_queue TYPE datetime;
DEFINE INDEX task_close_queue_unclaimed ON task_close_queue FIELDS claimed_at, expires_at;
```
Rows are deleted on successful grade-and-write or aged out at `expires_at` (default `+24h`).

### Migration: `events.source` enum

Single migration adds:
- `task_outcome`, `playbook_proposed`, `playbook_applied`, `introspection_sample`, `confidence_resolved`, `explicit_correction`.

The `explicit_correction` add unblocks the silent-failure cascade.

### New MCP tools (eight here; `show_cost_rollup` is added in §6, total nine)

| Tool | Direction | Purpose |
|---|---|---|
| `record_outcome({task_type, task_id, signals, source_event?})` | Write | Idempotent on `(task_type, task_id)`. Merges signals per priority above. Called by introspection and by Robin in-session. |
| `propose_playbook({task_type, draft, source_outcomes[]})` | Write | Writes a `playbook` memo with `version=current+1`. Prior version → `active=false`, `superseded_by=<new id>`. Called by dream step. |
| `list_playbooks({task_type?, active_only=true})` | Read | Headers only (frontmatter). |
| `get_playbook({id})` | Read | Full body. |
| `explain_playbook({id})` | Read | Lineage: frontmatter + body + diff vs prior + source_outcomes excerpts + cited_rules state + synthesis_step_version. Truncates at depth 4. |
| `list_comm_style_snapshots({limit=20})` | Read | Deterministic snapshot history (replaces embedding-recall hack). |
| `get_calibration({statement_kind?})` | Read | Calibration curve from confidence_band rows. |
| `explain_learning({memo_id|rule_id|prediction_id})` | Read | Unified provenance, dispatches across the above. |

Write tools (`record_outcome`, `propose_playbook`) are internal-only — not exposed in agent-facing AGENTS.md surfaces but reachable via MCP for in-session use.

### New dream steps

Added to `DREAM_DAG_DEPS` in `system/cognition/dream/dag.js`:

- **L1: `step-outcome-grading`** — fills `score` on `task_outcome` rows with `score=null`. Haiku-tier, capped by row count. Cold-start safe: writes structural description even when no playbook exists to grade against.
- **L2: `step-playbook-synthesis`** — depends on `step-reflection`. For each `task_type` with ≥3 graded outcomes since last synthesis AND `normalized_drift > threshold`, re-synthesize. Cap K=5/night ranked by `normalized_drift × n`. Opus-tier.
- **L2: `step-calibration-bucket`** — pure math. Sole writer of `confidence_band`. Bootstrap (n<30): 3 buckets. Mature (n≥30): 10 buckets. Laplace smoothing.
- **L2 (weekly): `step-prediction-taxonomy`** — clusters `kind='other'` predictions, proposes new enum entries as rule_candidates.
- **L2: `step-self-improvement-rollup`** — writes the `runtime:self-improvement-v2.metrics` rollup. Depends on the others.

Ordering: `step-reflection` runs first (existing) so rule candidates exist when `step-playbook-synthesis` runs and can reference them.

---

## Section 2: Introspection faculty

Sister to `intuition`, `biographer`, `reflection`, `reinforcement`, `dream`. Lives at `system/cognition/introspection/` (currently empty — was reserved for this).

### Why a faculty, not a job

1. Triggered by events (`task_close`), not cron.
2. Long-running with sampling state.
3. Failure-isolated — crash here does not stop dream, biographer, or recall.

### Lifecycle

- Started from `system/runtime/daemon/server.js` after DB-reachable + embedder-loaded.
- Supervised by daemon-restart machinery.
- `start()` / `stop()` with bounded drain (20s wall-clock cap; unfinished grades stay in queue for next start).
- Gate: `runtime:introspection.config.value.enabled` (default `true`; hot-reloadable).

### Failure isolation (no Node `domain`)

Process-level `unhandledRejection` handler routes introspection-tagged errors into the faculty logger and increments `runtime:introspection.value.crash_count` (leaky-bucket, 1/min decay). Per-grade try/catch wraps LLM + DB write. Auto-restart at `crash_count > 5` (leaky-bucket basis). Daemon-level restart only if leaky bucket persists.

### Event ingress — five `task_close` sources

| Source | Coverage | Carries |
|---|---|---|
| **Jobs** | 100% | task_type=`job:<name>`, result, duration, output if produced |
| **Outbound writes** | 100% | task_type=`outbound:<class>`, policy/API result (incl. `outbound_blocked` reason) |
| **Recall queries** | 100% (first per fingerprint/60s) | top-K hit ids, attribution mode |
| **Assistant turns** | Sampled (`crc32(event_id) mod 100 < turn_sample_pct`); auto-tuned | event_id, captured assistant_text length |
| **Predictions** | 100% | `(correct, statement_kind, confidence)` — feeds calibration directly |

Stop hook is gated at `assistant_len > 0` (closes a known capture-skip path at the source).

### Budget — in USD, not tokens

`runtime:introspection.config.value.daily_cost_budget_usd` (default `0.50`). Tokens × model_price → dollars; atomically decremented. **Strata degrade in priority order** when budget runs low:

1. Predictions + explicit corrections — always processed (no LLM, free).
2. Outbound writes — always up to exhaustion (low volume, structural detection of `outbound_blocked` is free).
3. Jobs — always up to budget.
4. Recall queries — 100% until budget at 25% remaining, then 25%.
5. Assistant turns — at `turn_sample_pct` (auto-tuned). Drops to 0 below 10% remaining.

Unsampled events still write *structural* `task_outcome` rows (signals from outcome inference only, score=null). Only the LLM grade is skipped.

**`turn_sample_pct` auto-tune rule** — recomputed once per hour from the trailing 7-day rolling cost-per-graded-turn and the daily budget:

```
projected_turn_cost = avg_turn_grade_cost_usd_7d × turns_per_day_7d
target_turn_spend = daily_cost_budget_usd × 0.5
turn_sample_pct = clamp(round(target_turn_spend / projected_turn_cost × 100), 5, 50)
```

Floor 5%, ceiling 50%. Never exceeds half the daily budget so jobs / outbound / recall always have headroom. Persisted to `runtime:introspection.value.turn_sample_pct`.

**Antecedent-check budget degradation** — the Haiku antecedent LLM call in `correction-inference.js` consumes from the same daily budget. When budget hits 25% remaining, the antecedent check drops to **regex-only matching** (no LLM verification). Raises false-positive rate but keeps the correction signal flowing through to reflection.

### Self-grading rubric (Haiku-tier)

Two axes only:
- **Completeness** vs. playbook's `declared_sections` (binary per section, averaged). `null` when no playbook.
- **Correction-likelihood** — LLM probability the user would correct, given playbook (or bare task_type definition for cold start).

`score = mean(axes)` when both exist; `score = correction-likelihood` when no playbook; `null` when sampling skipped LLM entirely.

### Outcome inference rules (v1, no LLM)

- *Outbound refusal*: outbound-policy `ok=false` on a job's output → `{kind: 'outbound_blocked', reason}`, score 0.2.
- *Explicit correction follow-up*: `record_correction({source_event=X})` within 10 min of graded turn X → merge `signals.explicit_correction=true`, **score=0** (corrections are authoritative).
- *Recall fingerprint reuse*: same `recall()` fingerprint twice in a session with disjoint top-K → first call was a miss. Score 0.3.

v1.5 deferred (need more spec): re-ask detection (channel-aware), abandoned-thread (30-min per-session timer).

### Constants surface

`system/cognition/introspection/inference-rules.js` — leaky-bucket rates, regex patterns, time windows, sample percentages. Configuration-only; never auto-modified.

### Telemetry surface

Writes to `telemetry_hourly` under `faculty=introspection`:
- `event_kind=sample` — `{task_type, sampled, llm_used, strata}`, `{tokens_in, tokens_out, cost_usd}`.
- `event_kind=outcome_written` — `{task_type, score_bucket, signals_present}`.
- `event_kind=budget` — hourly, `{budget_remaining_usd, projected_eod_usd, throttled}`.

This introduces first-class LLM-cost telemetry in Robin. Existing `embed_usage` covers embeddings; introspection's per-faculty + dream's per-step rows cover everything else after Section 6 wires up cost instrumentation in the other faculties.

---

## Section 3: Playbook surface (capability axis)

### Task-type identification at runtime

Three tiers, fastest first. **Only tier 3 costs LLM:**

1. **Declared.** Jobs and outbound writes carry their task_type directly. Free.
2. **Routed.** Recall queries bucketed by a small pattern table in `task-taxonomy.js`. Cheap.
3. **Classified.** Haiku classifier — fires only when (a) at least one `turn:*` playbook exists, AND (b) the prior turn in the same session didn't already classify. Result cached for the session. Empty-playbook-set short-circuit means cold-start sessions pay zero classifier cost.

Classifier failure → fall back to `turn:default`, log, do not crash.

### Cache invalidation

Per-session classifier cache invalidates when the user's turn message has cosine similarity < 0.3 with the prior cached turn (cheap embedding compare; no LLM).

### Inject path

`system/cognition/intuition/inject.js`:
- Existing memory-excerpt prepend preserved.
- New: after memory excerpts, inject the active playbook for the current task_type (capped by frontmatter `length_cap_tokens`).
- Single playbook per turn — no stacking in v1.
- Cold-start: when no active playbook exists, inject a one-line stub.
- **Failure mode:** playbook fetch throws → log, skip playbook, proceed with memory-excerpts only. Turn never fails because of playbook fetch.

### Synthesis-time rule access

New field on `rules`: `relates_to_task_types: array<string>`. Auto-populated by `step-reflection` when emitting a candidate tied to a graded `task_outcome` (carries forward the task_type). `step-playbook-synthesis` fetches active rules where `task_type ∈ relates_to_task_types` and includes their content in the synthesis prompt. This is how "rules > playbooks" is enforced: synthesis is *aware* of the rule and writes the playbook to defer rather than duplicate.

### Stale rule cleanup

Synthesis verifies every entry in the prior version's `related_rules` is still `active=true`; dropped rules are removed from the new version's frontmatter.

### Lifecycle (5 states)

| State | active | cold_start | Trigger |
|---|---|---|---|
| `cold_start` | true | true | Synthesized from <5 outcomes |
| `active` | true | false | ≥5 graded outcomes AND ≥3 days since cold_start |
| `corrected` | true | * | `record_correction({playbook_id})` lands |
| `superseded` | false | * | New version synthesized; `superseded_by` set |
| `archived` | false | * | Retention age exceeded; moved to `playbook_archive` table |

### Retention policy

Per task_type: keep last 5 versions in `memos` (1 active + 4 superseded). Older superseded versions move to `playbook_archive` SurrealDB table (same schema, no embedding column). Archive prune at 18 months. `explain_playbook` traverses both transparently.

### Token-cap enforcement

Synthesis runs with `target = length_cap_tokens × 0.8` in prompt. Output overflow → one retry with tighter target. If retry overflows, truncate at hard cap and log `playbook_synthesis_overflow` event.

### Interaction with rules and outbound-policy

- **Rules > playbooks** on conflict (synthesis-time enforcement via `related_rules`).
- **Outbound-policy > playbooks** — verbatim-quote guard and PII scanner are absolute. `outbound_blocked` outcomes feed synthesis as evidence to avoid the trigger pattern.
- **Action-trust > playbooks** — outbound playbooks describe content shape; action-trust still gates send.

---

## Section 4: Decision calibration (the second axis)

### 4a. Predictions become first-class

**Predict-discipline is an *authored seed rule*** — version-pinned in `system/cognition/skeleton/rules/predict-discipline.md`, edited by user only. Content:

> When stating a falsifiable claim where (a) resolution time ≤ 30 days, (b) evidence is in Robin's reach (job result, integration data, calendar event, user statement), AND (c) it's not a value judgment, call `predict()` silently with `(statement, kind, confidence, expected_resolution_at)`. Do not surface the prediction id unless asked.

**`statement_kind` enum-locked with `'other'` escape**. Initial members: `event_timing`, `outcome_value`, `duration`, `preference_guess`, `fact_recall`, `behavior_continuation`. `kind='other'` recorded but does not contribute to calibration buckets. Weekly `step-prediction-taxonomy` clusters `other` predictions and proposes new enum entries as rule_candidates.

**Resolution is heartbeat-driven**. New scheduler tick `resolve-due-predictions` (5-min cadence) checks open predictions past `expected_resolution_at + grace`. Per `statement_kind`:
- `event_timing` ← `runtime_jobs.last_run_at`, `events` table.
- `outcome_value` ← integration data.
- `duration` ← measured time delta.
- `fact_recall` ← needs_user (Robin can't grade its own recall).
- `preference_guess` ← needs_user.
- `behavior_continuation` ← `chrome_recent_visits`, `spotify_recently_played`, Whoop journal.

Unambiguous evidence → auto-resolve. Ambiguous → `resolution_status='needs_user'`, surface in daily-brief watch-list.

### 4b. Per-bucket calibration math

`confidence_band` keyed by `(statement_kind, bucket)`. **Adaptive bucketing:**
- **Bootstrap** (n < 30 per kind): 3 coarse buckets — `low: [0, 0.4)`, `mid: [0.4, 0.7)`, `high: [0.7, 1.0]`.
- **Mature** (n ≥ 30): refine to 10 buckets at 0.1 resolution. One-shot rebucket migration.
- **Laplace smoothing:** `accuracy = (correct + 1) / (n + 2)`.

`step-calibration-bucket` is the **sole writer** of `confidence_band` (recomputed nightly from prediction rows). Both `resolve_prediction()` and `record_correction({prediction_id})` only mutate the prediction row; bucket math is rebuilt next cycle.

**Confidence-drift detection:** when `|stated_mean - laplace_accuracy| > 0.2` for `n ≥ 10` in any bucket, emit a `confidence_drift` rule_candidate **(candidate, not auto-applied)**. Rejection moves the re-emit threshold to `n ≥ 20` (anti-thrash).

### 4c. Rule pipeline unblocking (highest-leverage single fix)

Five changes:

1. **`events.source` enum migration** (Section 1, prereq for everything).
2. **Co-dimension clustering.** Reflection clusters on `(content_embedding, task_type)` not content alone. Cross-task_type clustering remains at 0.85 for rare cross-cutting rules; within-task_type clustering at 0.70.
3. **Threshold drop** — 0.85 → 0.70 within task_type. Validate on v1-quarantine import (≥80% recall of imported rules).
4. **Verbatim quotes as primary candidate content.** `rule_candidates.content` retains user verbatim quotes; LLM paraphrase moves to `meta.synthesis_body`. **Only `meta.synthesis_body` is installed into CLAUDE.md** (PII protection — verbatim quotes can contain finance/health detail).
5. **Retraction at next cycle.** `record_correction({rule_id})` flips `active=false`. Re-evaluation: if cluster lost ≥3 supporting corrections, rule stays inactive.

### 4d. Comm-style tightening

Loop is healthy (`confidence=0.93`). Three extensions:

1. **Per-context, three contexts:** `discord`, `terminal` (Claude Code / Cursor / Gemini / Codex), `web` (askrobin.io VM). Synthesis populates contexts with ≥10 evidence events; under-evidenced contexts inherit from `default`. Inject reads `ROBIN_SESSION_PLATFORM` or falls back.
2. **Citation via snapshot memos.** Each synthesis writes a `comm_style_snapshot` memo with content_hash. `persona:singleton.comm_style.last_snapshot_id` points to active. Playbooks cite via `related_comm_style_snapshot`. Updated snapshot id → cited playbooks queued for re-synthesis.
3. **Convergence definition.** Comm-style is *converged* when 2 consecutive synthesizes produce matching content_hashes. Non-converged citations are flagged `volatile: true` and treated as soft references by synthesis.

### Learning typology

| Category | Examples | Apply timing |
|---|---|---|
| **Authored seed** | predict-discipline rule, task-taxonomy enum, outcome-inference constants | Version-pinned in skeleton/. User-edited only. Not retracted by corrections. |
| **Learned auto-applied** | comm-style updates, playbook revisions, calibration math | Apply on next dream cycle. Corrections retract via `record_correction({memo_id})`. |
| **Learned candidate** | Reflection-emitted behavior rules, confidence_drift, new statement_kind/task_type enum entries, new action-policy classes, ASK→AUTO upgrades | Surface as `rule_candidates`. User approves before apply. |

Dividing line: candidate-gated if it (a) changes Robin's behavioral defaults across many turns, (b) affects outbound writes or action policy, or (c) extends a system enum. Otherwise auto-apply.

---

## Section 5: Signal routing & governance

### Single resolution authority for `confidence_band`

`step-calibration-bucket` is the **sole writer** of `confidence_band`. Both `resolve_prediction` and `record_correction({prediction_id})` only mutate the underlying `memos kind='prediction'` row. Nightly recompute reflects all changes. Intra-day delta: one prediction's worth of bucket math is wrong for up to 24h. Acceptable.

### Correction-inference is a new module

`system/cognition/intuition/correction-inference.js`. Invoked synchronously by the Stop hook **before** the biographer is enqueued. Biographer remains pure entity extraction.

**Antecedent enumeration** — inference only fires when prior assistant turn matches at least one *strong* signal (a, c below) OR two *weak* signals (b, d, e):

- (a) Called `AskUserQuestion`. **Strong**.
- (b) Contains numbered/lettered list ≥2 items. Weak.
- (c) Contains a falsifiable claim flagged by `predict()` in the same turn. **Strong**.
- (d) Ends in `?`. Weak.
- (e) Performed an outbound write whose output is now subject to correction. Weak.

No antecedent match → inference doesn't fire even if user turn matches a correction pattern.

**Inference patterns** (initial set, in `inference-rules.js`):
- `/^(no|nope|wrong|actually|wait|instead|i meant|i mean)\b/i`
- `/^\d+\.?\s*(no|not)\b/i`
- `/^[a-e]\.?$/i` (after multi-option `AskUserQuestion`)

On match + antecedent pass:
- Writes `events` row with `source='explicit_correction'`.
- Writes `task_outcome` row keyed `(task_type=antecedent.task_type, task_id=prior_event_id)` with `signals.explicit_correction={text: user_verbatim}`, `score=0`.

Manual `record_correction({...})` still works for explicit user intent.

### End-to-end canonical flow

1. Kevin types "no, I meant E" responding to a job-output Robin sent.
2. Discord adapter / Stop hook captures user turn → `events` row.
3. `correction-inference.js` fires: antecedent check passes (prior turn called `AskUserQuestion`) → match → writes `events:explicit_correction` + `task_outcome` row.
4. Reflection (nightly) clusters with peers in same `task_type`. ≥3 → rule_candidate with verbatim quotes in `.content`, paraphrase in `meta.synthesis_body`.
5. User reviews via `list_rules({status: 'pending'})`, sees verbatim quotes for context.
6. User approves → rule installed with `meta.synthesis_body` as injected body. Verbatim stays in candidate row for provenance via `explain_learning`.
7. Playbook synthesis (next dream cycle) sees the new `task_outcome` + new rule, revises playbook to defer to the rule. Loop closed in ~24h.

### Scheduler integration

Two new 5-min handlers + one 1-min drain:
- `resolve-due-predictions` (5 min) — checks open predictions past `expected_resolution_at + grace`.
- `task-close-drain` (1 min) — introspection's queue poller. Inline grading happens at enqueue when budget allows; the drain handles structural-only writes and any deferred grading.
- `decay-task-outcomes` (existing reinforce-recall co-handler, extended) — `task_outcome` rows past 90 days move to archive.

All `manually_runnable=false`, scheduler-only, inspectable via `robin jobs list`.

### Governance: auto-apply / candidate / never-auto

**Auto-apply** (no user gate):
- `comm_style_snapshot` writes + `persona.last_snapshot_id` flip.
- `playbook` writes + prior version supersession.
- `task_outcome` writes.

**Auto-apply with immediate-revert on retraction:**
- `record_correction({comm_style_snapshot_id})` → immediate revert of `last_snapshot_id` to prior snapshot. Next synthesis may issue corrected new snapshot.

**Candidate** (requires `update_rule`):
- Reflection-emitted rule_candidates.
- `confidence_drift` candidates.
- New `statement_kind` / `task_type` enum entries.
- New action-policy classes.
- `ASK → AUTO` action-policy upgrades.

**Never auto** (configuration only):
- Authored seed rules.
- `task-taxonomy.js` enums.
- `inference-rules.js` constants.
- Per-task-type token caps.

### Retraction propagation matrix

| `record_correction({memo_id})` where memo.kind = | Behavior |
|---|---|
| `playbook` | Flip `active=false`, set `retraction_reason`, queue re-synthesis. |
| `comm_style_snapshot` | Immediate revert of persona's `last_snapshot_id` to prior snapshot. Synthesis next night. |
| `task_outcome` | Mark `meta.user_disputed=true`. Synthesis weights dispute. |
| `prediction` | Mutate prediction row's `correct` / `actual_outcome` / `meta.user_disputed`. Bucket math rebuilt nightly. |
| `confidence_band` | Not retracted directly. Rebuilt from predictions. |

`record_correction({rule_id})` → existing path, retracts rule.

### Audit trail (unified provenance)

- `explain_playbook({id})` — playbook lineage.
- `list_rules({status})` + `rule_candidates.content` (verbatim) + `meta.synthesis_body` (installed body).
- `list_comm_style_snapshots({limit=20})` — deterministic snapshot history.
- `get_calibration({statement_kind?})` — calibration curves.
- `explain_learning({memo_id|rule_id|prediction_id})` — unified surface. Truncates evidence chains at depth 4 with `truncated: true` flag.

---

## Section 6: Cost, telemetry, testing, rollout, success criteria

### Cost budgets

| Faculty / step | Default budget | Notes |
|---|---|---|
| introspection (inline + classifier + antecedent) | $0.50/day | `runtime:introspection.config.value.daily_cost_budget_usd` |
| `step-outcome-grading` | $0.20/night | Haiku-tier |
| `step-playbook-synthesis` | $1.50/night | Opus-tier, K=5 cap |
| `step-calibration-bucket` | $0 | Pure math |
| `step-prediction-taxonomy` | $0.10/week | Weekly |
| `step-comm-style` (existing) | $0.30/night | Already shipped |
| `step-reflection` (existing) | $0.20/night | Already shipped |
| `biographer` (existing) | $1.00/day | Already shipped |

**New machinery: ~$2.00/day. Total Robin LLM cost: ~$4/day ≈ $120/month.**

All budgets are `runtime:*.config` values, hot-reloadable. Threshold alerts at 2× budget surface in daily-brief watch-list.

### Telemetry surface

Every cost-bearing operation writes `telemetry_hourly` row:
```
{faculty, event_kind: 'llm_call', ts,
 dimensions: {step_name?, task_type?, model, success},
 metrics: {tokens_in, tokens_out, cost_usd, duration_ms},
 meta: {prompt_version?}}
```

First first-class LLM cost surface in Robin. New MCP tool `show_cost_rollup({window, faculty?})` aggregates.

### Testing strategy

**Unit (`pnpm test:unit`, mem:// only):**
- `task-taxonomy.js` enum validation.
- `correction-inference.js` antecedent gate (strong/weak combinations) + regex matching.
- `step-outcome-grading` LLM scorer (mocked LLM) — completeness math, correction-likelihood math, null cold-start handling.
- `step-playbook-synthesis` ranking (drift × n normalization), top-K selection.
- `step-calibration-bucket` math — Laplace, bootstrap→mature transition, single-writer property.
- `resolve-due-predictions` auto-resolution by statement_kind, surface-to-user fallback.
- `task_close_queue` claim semantics.
- Inject-path playbook fetch with failure mode.
- Retraction propagation per memo kind.
- Lifecycle state transitions.
- PII separation (verbatim in `.content`, paraphrase installed).

**Integration (full daemon spin-up):**
- End-to-end correction flow → rule emergence → playbook revision.
- Cold-start playbook synthesis path.
- Budget exhaustion and strata degradation.
- Confidence drift detection and re-emit threshold bump.
- `events.source` migration on copy of live DB.

**Replay validation** (against v1-quarantine corpus):
- Captured corrections through new 0.70 + co-dimension clustering → ≥80% recall of imported rules.

**Performance:**
- Stop-hook → correction-inference roundtrip: <100ms p99.
- Inject-path playbook fetch: <50ms p99.
- Dream-cycle wall-clock: ≤7 min (+25% over current).

### Rollout — phased behind `runtime:self-improvement-v2.value.enabled`

**Phase 0 — prerequisites** (~3 days):
- `events.source` enum migration.
- Memo kinds + `task_close_queue` table.
- Replay validation on v1-quarantine.

**Phase 1 — substrate, dark** (~4 days, flag=false):
- Introspection started but writes telemetry only (no outcomes).
- New dream steps registered, `enabled: false` in step config.
- New MCP tools defined, return "v2 not enabled" stubs.
- Inject-path playbook fetch reads only when flag true.

**Phase 2 — soft launch** (~2 days, flag=true with monitoring):
- Flip flag. Outcomes write. Dream steps fire.
- Monitor `show_cost_rollup` every 6h for 3 days.
- Auto-flag-off if task_outcome write rate drifts > 50% from baseline (baseline = first 3 days).

**Phase 3 — full operation:**
- Confidence_drift candidates emerge after ~30 predictions per kind.
- Playbooks transition cold_start → active per task_type.

**Rollback:** flag flip to false. Faculty stops writing. Inject path falls back to memory-only. Existing rows remain. Additive substrate — no destructive ops needed.

### Error handling matrix

| Failure | Surface | Action | User-visible |
|---|---|---|---|
| Introspection crash | leaky-bucket counter | Auto-restart up to 5/min | Yes (daily brief if >5/day) |
| LLM timeout in grading | Log, `score=null` | Retry next dream | No |
| Synthesis output overflow | Log, retry tighter target | One retry then hard truncate | No |
| `events.source` enum violation (migration) | Throws | Abort, manual fix | Yes |
| `task_close_queue` claim race | `claimed_by` mismatch | Skip + log | No |
| Inject-path fetch error | Log | Skip playbook | No |
| Comm-style retraction with no prior snapshot | Log | Stay on current until next synthesis | Yes (daily brief) |
| Budget exhausted mid-day | `throttled=true` | Strata degrade | Yes (watch-list if >12h) |

### Success criteria

Tracked in `runtime:self-improvement-v2.metrics`. **All required for v1-done declaration:**

**Pipeline yield:**
- Rule candidates emitted ≥5/week (vs. current 0).
- Active playbooks: ≥1 each for `job:daily-briefing`, `outbound:discord_send:send_dm`, and 3 of 5 seed `turn:*` types within 14 days of phase 2.
- `confidence_band` rows: ≥10 buckets populated within 30 days.

**Behavior change:**
- Repeat-correction rate per task_type (same correction landing >2× in 30 days) → -40% from baseline at 4 weeks.
- Daily-brief `outbound_blocked` rate near 0 after playbook v1 synthesis.

**Cost / performance:**
- Total daily LLM cost ≤ $4 sustained.
- Dream cycle wall-clock ≤ 7 min.
- Introspection restart count ≤ 1/day at 30-day average.

**Negative metric:**
- Auto-applied playbook revisions corrected within 24h of synthesis at ≤10% rate.

---

## Out of scope (deferred)

- **v1.5 outcome inference rules:** re-ask detection (channel-aware), abandoned-thread timer.
- **Multi-playbook stacking** (e.g., `turn:analyze` + `outbound:discord_send` in same turn).
- **Auto-expansion of `turn:*` enum via dream observation.**
- **Knowledge synthesis axis** (patterns table, arc naming) — parallel investigation handles plumbing prerequisites first.
- **Retrieval-quality axis** (recall attribution, reinforcement signal) — parallel investigation owns this.
- **Per-confidence-bucket downshift application during inject** — v2; for now drift only emits a candidate.
- **Cross-task_type playbook composition** — stacking and inheritance.
- **TSDB-grade telemetry** — daily rollups stay in SurrealDB.

## Open questions / decisions still owed

1. **Predict-discipline rule:** authored seed (Section 4a recommends). Alternative: emit as candidate on first install. Default: authored seed.
2. **Reflection threshold drop 0.85 → 0.70:** validate on replay first. If false-positive rate >10% on held-out, tune up.
3. **`daily_cost_budget_usd` default $0.50:** sufficient for high-value strata + ~20% turn sampling. Alternative conservative default: $0.25.
4. **Per-context comm-style:** ship in v1 (proposed). Alternative: defer to v2 if it materially extends the scope.

## References

- `c2-dream-dag-design` — existing DAG; this spec adds L1 + L2 steps.
- `c3-telemetry-umbrella-design` — `telemetry_hourly` table; this spec adds first-class LLM-cost rows.
- `b1-per-hit-reinforcement-design` — reinforcement loop; not modified by this spec.
- `phase-4b2-comm-style-design` — existing comm-style synthesis; extended by per-context fields.
- `phase-4b3-predictions-design` — existing prediction API; extended by enum-locking, heartbeat resolution, calibration bucketing.
- Other agent's parallel investigation (2026-05-17) — observability/plumbing fixes that are out-of-scope here but unblock the retrieval-quality and knowledge-synthesis axes for later specs.
