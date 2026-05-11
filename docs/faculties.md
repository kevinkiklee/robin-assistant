# Faculties

Robin's behavior is organized into named faculties. Two categories:

- **Process faculties** (verbs — what Robin *does*): intuition, biographer, heartbeat, discretion, dream, reflection, introspection, reinforcement.
- **Substrate lenses** (nouns — what Robin *knows*): attention, chronicle, knowledge, habits, persona, narrative, foresight.

The two-name convention: **modules are named for cognitive function; memo kinds are named for data shape**. `habits.js` writes `kind='habit'` memos; `foresight.js` writes `kind='prediction'` memos; `narrative.js` writes `kind='thread'` memos. Code does, data is.

## Substrate lenses (`system/cognition/memory/*.js`)

All lenses read/write through `store.js` — the only writer to events/memos/edges/embeddings. Each lens is a thin file (~30–80 LOC) baking in `kind` and exposing legacy function names alongside the new ones during the migration.

### attention
**What Robin is currently attending to.** Active episodes + recent events + entities mentioned across them.
- File: `system/cognition/memory/attention.js`
- API: `getAttention(db, { source?, windowMinutes? })` → `{ episodes, recent_events, entities }`
- Replaces v1's `hot.js` (which hardcoded `entities: []`).

### chronicle
**Chronological list of significant biographed events.**
- File: `system/cognition/memory/chronicle.js`
- API: `listChronicleEntries(db, { since?, until?, limit?, minContentLen? })`
- Replaces v1's `journal.js`.

### knowledge
**Distilled facts about the world** (memos kind='knowledge').
- File: `system/cognition/memory/knowledge.js`
- API: `createKnowledge(db, embedder, input)` / `searchKnowledge(db, embedder, q)` / `listKnowledge(db, opts)` / `getKnowledgeByContentHash(db, content)`
- Subject linkage moved from `subject_id` scalar to `about` edges; lineage moved from `source_events` arrays to `derived_from` edges.

### habits
**Recurring observations** (memos kind='habit'). Dedup by `meta.name`; re-observations increment `signal_count`.
- File: `system/cognition/memory/habits.js`
- API: `upsert(db, embedder, { name, description, lineage?, strength? })` / `list(db, opts)`
- Replaces v1's `patterns.js`.

### persona
**The singleton model of Robin's user.** Stored as a `persona:singleton` row.
- File: `system/cognition/memory/persona.js`
- API: `getPersona(db)` / `updatePersonaFields(db, fields)` / `updateCommStyle(db, fields)` / `updateCalibration(db, fields)`
- Replaces v1's `profile.js` (table renamed from `profile` to `persona`).

### narrative
**Multi-episode arcs** (memos kind='thread').
- File: `system/cognition/memory/narrative.js`
- API: `add(db, embedder, { title?, summary?, episode_ids?, entity_ids? })` / `list(db, opts)`
- Replaces v1's `threads.js`.

### foresight
**Predictions and calibration** (memos kind='prediction').
- File: `system/cognition/memory/foresight.js`
- API: `predict(db, embedder, { statement, statement_kind, confidence, expected_resolution_at? })` / `resolve(db, id, { correct, actual_outcome? })` / `listOpen(db, opts)` / `computeCalibration(db)`
- New consolidation of prediction logic previously scattered.
- Calibration output (resolved-prediction stats per `statement_kind`)
  is consumed by `belief()` (Cognition D3) as the day-1 drift source and
  feeds the weekly meta-calibration narrative writer.

## Process faculties

### intuition
**The UserPromptSubmit hook that injects relevant memory into the next turn.**
- Trigger: Claude Code or Gemini CLI fires `UserPromptSubmit` with `{prompt, transcript_path, session_id}`.
- Files: `system/cognition/intuition/handler.js` (hook entry), `system/cognition/intuition/inject.js` (daemon endpoint), `system/cognition/intuition/rank.js`, `system/cognition/intuition/conflicts.js`.
- Behavior: Composes events + memos[kind=knowledge] recall via `store.searchEvents` + `store.searchMemos`. Ranks via `rank.score` (cosine × freshness × contradiction × trust × scope). MMR-lite diversity pass. When the substrate has a live `contradicts` edge among the in-view memo hits and `runtime:recall.value.conflict_surfacing_enabled` is `true`, `conflicts.fetchContradictors` hydrates the other side of each pair in one batched roundtrip and `conflicts.buildConflictBlock` emits a `<!-- conflicts -->` block above `<!-- relevant memory -->`. The same hydration step populates `contradictionCount` on the rank score so `contraPenalty` finally fires (defaulted to `0` and dormant pre-B2). Suppression rules: low confidence (<0.4), superseded (freshness 0), both sides outbound-blocked, stale (>30 days), per-turn cap (3 pairs). Writes `intuition_telemetry` + `recall_log{outcome:pending}` rows.
- Inspect: `SELECT * FROM intuition_telemetry ORDER BY ts DESC LIMIT 20`.

### biographer
**Per-turn consolidation: turns raw events into structured entities, edges, and (rarely) memos. Batched across consecutive events from the same source.**
- Files: `system/cognition/biographer/pipeline.js`, `system/cognition/biographer/batch-prompt.js`, `system/cognition/biographer/batch-output.js`, `system/cognition/biographer/accumulator.js`, `system/cognition/biographer/queue.js`, `system/cognition/biographer/output.js`, `system/cognition/biographer/prompt.js`, `system/cognition/biographer/` (edges/stage1-exact/stage2-embedding/stage3-disambig/upsert-entity).
- Trigger: `createBatchAccumulator` (source-bucketed) fires when `max_batch_size` (default 8), `debounce_ms` (default 750ms), or `max_wait_ms` (default 3000ms) hits — whichever first. Tunables live in `runtime:biographer.value.batch_config` and are re-read per flush. Rollback: set `batch_config.disable = true` to short-circuit the accumulator and route every event through the pre-C1 single-event path.
- One LLM call per batch via `biographerProcessBatch`. Per-event validation isolates failures: a malformed entry for one event does not poison the others.
- Fallback: outer-envelope JSON parse failure, batch-validation failure, or retries-exhausted on the LLM call all fall back to looping the original single-event `biographerProcess` — never worse than today's baseline. Telemetry: `runtime:biographer.value.{batches_total, batches_fallback, last_fallback_reason, events_biographed_via_batch, events_biographed_via_fallback, batch_input_tokens_total, batch_output_tokens_total, last_batch_size, last_batch_input_tokens, last_batch_output_tokens}`.
- Writes: `entities` (upserted via 3-stage cascade, deduped by `(type, name_lower)` across the batch), `edges` (mentions/about/works_on/participates_in/occurs_with/before via one `store.relateAll` call), `events.biographed_at = time::now()` and `events.episode_id` (one gated UPDATE per episode group, `WHERE biographed_at IS NONE`).

### heartbeat
**The 60-second scheduler tick.**
- Dispatches integration syncs, biographer queue, stale-session sweep, quiet-window cursor advance, internal jobs (notably `reinforce-recall`).

### discretion
**Refuses inappropriate writes (inbound), commands (bash), and outbound payloads.** Unchanged from v1 — three sub-mechanisms sharing the `refusals` table.

### dream
**Nightly multi-step consolidation into long-term memory. Layered DAG: ten steps fan out across three topological layers; per-step failures captured into `summary.<step>.error`; unified `dreamed_at` mark fires once, post-barrier, after every layer settles.**
- Files: `system/cognition/dream/pipeline.js`, `system/cognition/dream/scheduler.js` (`runDag`, `topoLayers`, `chunkByLimit`), `system/cognition/dream/dag.js` (`DREAM_DAG_DEPS`), `system/cognition/dream/step-registry.js` (`byName`), `system/cognition/dream/dream-budget.js` (`readDreamConfig`, `shouldHalt`, `defaultFloor`), `system/cognition/dream/telemetry.js` (`recordStepTelemetry`), `system/cognition/dream/step-*.js`.
- Layers: **L1** `knowledge, patterns, reflection, profile, arcs, commStyle, confidence` · **L2** `scopeCleanup ← knowledge`, `calibration ← commStyle` (persona serial) · **L3** `compaction ← knowledge, scopeCleanup`. Within a layer, steps run via `Promise.all`; layers run in series.
- step-knowledge emits `supersedes` edges when promoting contradicting facts (old memo preserved; `fn::freshness` returns 0).
- step-scope-cleanup promotes referenced ephemerals to global; prunes the rest (session: 7d, temp: 24h).
- Runtime config: `runtime:`dream.config`.value` carries `parallelism_enabled` (default `false`), `max_concurrent` (`NONE` → unlimited within a layer), `budget_check_enabled` (default `true`), `budget_floor` (`NONE` → 20% of `runtime:`cadence.config`.daily_token_budget`). Flip parallelism on with `UPDATE runtime:\`dream.config\` SET value.parallelism_enabled = true;`; rollback with `false`.
- Budget coupling (§5.1): dream's per-step writes land in `cadence_telemetry` alongside the cadence consumer's rows, so `currentBudget(db, cfg)`'s 24-h rolling sum reflects both surfaces. The dream budget halts at layer boundaries — never mid-step. Worst-case overshoot is bounded by the most expensive layer (today: layer 1 with five LLM-bound steps ≈ 250k tokens).
- Per-run ledger: `runtime:dream.value` carries `last_run_at`, `last_run_at_success`, `last_layers: [{ names, duration_ms }]`, `last_halted: 'budget_exhausted' | 'scheduler_error' | NONE`. Doctor + `show_step_health` consume these.

### reflection
**Correction-to-rule + reinforcement-to-rule learning loop.** Runs as a step inside dream; clusters correction *and* positive-reinforcement events into `rule_candidates`.

### reinforcement (NEW)
**The recall feedback loop — the keystone effectiveness fix.**
- Files: `system/cognition/intuition/reinforcement.js`, `system/cognition/intuition/attribute.js`, `system/cognition/intuition/reinforcement-config.js`, `system/cognition/jobs/internal/reinforce-recall.js`, `system/cognition/jobs/builtin/reinforce-recall.md`.
- Behavior: every 5 minutes, walks `recall_log` rows whose `outcome='pending'` and `ts < now - 5min`. For each row:
  1. If a `meta.kind='correction'` event landed in the session window -> `outcome='corrected'`, refute every memo hit in `evidence_ledger` (Theme 2a).
  2. Else, attribute hits via `attribute(hits, replyBody, config)` — explicit `<!-- recall_used: ... -->` marker -> `[event|episode YYYY-MM-DD]` citation -> asymmetric Jaccard similarity. Hits matched get `used=true, used_via=<pass>`.
  3. If the conversation event capturing the next reply is missing -> fallback governed by `runtime:reinforcement.config.fallback_when_no_reply`.
  4. If attribution matched zero hits -> fallback governed by `fallback_when_zero_used`. Without fallback, `outcome='evaluated_no_used'`.
  5. For every hit with `used=true`, `signal_count += 1` and `decay_anchor = time::now()`. A `corroborates` ledger row is emitted weighted by the count of used-this-batch occurrences.
- Config knobs (`runtime:reinforcement.config`, single UPDATE to retune):
  - `attribution_mode`: `'hybrid'` (default once rolled out) or `'off'` (kill switch, every hit force-used).
  - `similarity_threshold` (default 0.35): asymmetric Jaccard cutoff.
  - `jaccard_min_overlap_tokens` (default 2): absolute floor on intersection size.
  - `citation_date_window_days` (default 2): tolerance for `[event YYYY-MM-DD]` date match.
  - `fallback_when_no_reply` / `fallback_when_zero_used` (default both true): preserve legacy reinforce-all when attribution can't run / matched nothing.
  - `reply_lookup_window_ms` (default 600_000): how long after recall we wait for the reply event.
- Inspect: `SELECT outcome, count() FROM recall_log GROUP BY outcome`; `explain_recall({last_n:5})` returns per-hit `used`/`used_via`/`used_score` plus the row's `attribution.mode`.
- **Mode-rate distribution (interim telemetry, until `show_attribution_health` ships).** Until the `show_attribution_health` MCP rollup lands as a follow-up (spec §9.2 step 3), this query is the only way for an operator to verify the "watch for one week" check in rollout step 4:

  ```surql
  SELECT attribution.mode, count() AS n
  FROM recall_log
  WHERE ts > time::now() - 7d
  GROUP BY attribution.mode;
  ```

  Expected healthy distribution after a week of `'hybrid'`: bulk of rows in `citation` + `similarity`, low single-digit-% in `fallback_no_reply` / `fallback_zero_used`, near-zero `hit_missing`-dominated rows. Spikes in `fallback_no_reply` indicate transcript-capture regressions (see §7.1); spikes in `hit_missing` indicate aggressive compaction (see §7.7).
- **Rollback (operational).** ``UPDATE runtime:`reinforcement.config` SET value.attribution_mode = 'off';`` is the **fast** rollback — instant, no migration. The `evaluated_no_used` enum value persists on `recall_log.outcome`'s `ASSERT` list either way; rolling back the schema *enum* requires a new migration (you cannot `REMOVE` an enum value if any row holds it), so the runtime-flag rollback is the only one operators should reach for in practice.

### introspection
**Daemon-boot integrity check against the install-time manifest baseline.** Unchanged from v1.

### recall (hybrid retrieval — alpha.15+)
**Two retrievers, RRF-fused.** Vector kNN over the active embedder's per-surface HNSW index runs in parallel with BM25 over the `*_content_fts` / `*_name_fts` FULLTEXT indexes; reciprocal rank fusion combines the rankings.
- Files: `system/cognition/memory/store.js` (`_surfaceSearch`, `_bm25Retrieve`), `system/cognition/intuition/fusion.js` (`rrfFuse`, `padDistances`), `system/cognition/intuition/rank.js` (composite score).
- Adaptive over-fetch on the kNN side: `knnK = limit × (base + filters × per_filter)`. Mitigates post-filter shrinkage when callers narrow by `kind`/`scope`/`tags`/`since`.
- BM25-only hits get a neutral cosine distance (`0.5`) so `rank.score()` doesn't underrank them. Re-embedding would cost an extra embed call per recall on the intuition path (every UserPromptSubmit); the pad is the cheap, defensible choice. `recall_log` records `_sources: ['knn', 'bm25']` per hit so we can see how often the BM25 lane carries weight.
- Tunables in `runtime:recall.value` (5s-cached): `rrf_k`, `knn_overfetch_base`, `knn_overfetch_per_filter`, `mmr_threshold`. Tweak without code change.
- BM25 fails-soft: if FULLTEXT indexes aren't available (e.g., upgraded engine), vector-only recall keeps working.

### evidence (alpha.16, Theme 2a)
**Confidence as a derivable signal.** `evidence_ledger` accumulates
corroboration / refutation rows per memo. `fn::derived_confidence` blends
the initial confidence as a prior (`prior_weight` votes) with the
accumulated evidence to compute a current value in [0, 1].
- Producers: reinforcement loop (corroborate on `reinforced`, refute on
  `corrected`), `store.relate(..., 'contradicts')` auto-emits two refutes,
  biographer optional `evidence_signals[]` output, MCP `endorse`/`refute`.
- Update path: `step-confidence-recompute` (nightly) recomputes
  `memos.confidence` for memos with ledger activity since the last
  `meta.evidence_recomputed_at` marker.
- Tunables in `runtime:evidence.config`: `prior_weight` (default 3.0),
  `biographer_weight` (0.5), `manual_weight` (2.0).
- Inspect via Theme 4 MCP tool `explain_belief({memo_id})` — returns the
  ledger replay + derivation formula.

### belief (alpha.17, Cognition D3)
**Read-only "should I assert this?" gate.** The `belief({query, domain?, k?})`
MCP tool aggregates evidence-backed confidence over recalled `kind='knowledge'`
memos and returns a recommendation: `assert | soften | unknown`. Pure
aggregation — zero new LLM tokens, zero extra embeds beyond the recall.
- Input schema (`additionalProperties: false`): `query` (required, ≤500 chars),
  `domain` (optional, ≤80 chars), `k` (optional integer 1–20, default 8).
- Output: `aggregate_confidence`, `calibrated_confidence`, `evidence[]`
  (`memo_id`, `content_snippet`, `derived_confidence`, `last_observed`,
  `weight`), `calibration` (when applied), `recommendation`, `meta`
  (k_requested/k_returned, dropped counters, elapsed_ms, fallback_path,
  shadow flag).
- Pipeline: recall (kind='knowledge', overfetched) → privacy filter (direct
  + transitive `derived_from` to private memos) → batched structural weights
  (`signal_count × decay`, supersedes → 0) → `fn::derived_confidence` → pure
  `aggregateBelief` (weighted average; weight = `signal_count × decay ×
  relevance`, NO confidence multiplier) → `readCalibration` (meta-narrative
  memo wins over `persona:singleton.calibration`) → `calibrateAdjust` (linear
  with clamp) → threshold gate.
- Privacy: stricter than `recall` — drops hits whose scope is private OR
  whose lineage touches a private memo. No `refusals` row per drop;
  aggregate `meta.hits_dropped_private` is the right granularity.
- Telemetry: writes `cadence_telemetry` rows with `step='belief.call'` and
  `meta.sample_rate` (1.0 in shadow, 0.1 after flip). Sampled deterministically
  on `hash(query)`. The C3 hot-bridge rolls up `step LIKE 'belief.%'`.
- Shadow rollout: ships behind `runtime:belief.config.value.shadow_mode=true`.
  In shadow the gate is computed and logged via
  `meta.shadow_recommendation_would_have_been` but the public
  `recommendation` is forced `'unknown'`. Flip to active by setting
  `shadow_mode = false`.
- Tunables in `runtime:belief.config.value` (5s-cached): `default_threshold`
  (0.6), `soften_floor` (0.4), `domain_thresholds`, `relevance_threshold`
  (0.30), `confidence_floor` (0.05), `belief_overfetch_factor` (2.0),
  `min_calibration_samples` (5), `calibration_adjustment_gain` (1.0),
  `expected_accuracy_baseline` (0.75), `shadow_mode`, `telemetry_sample_rate`.
- Pairs with the **weekly meta-calibration narrative writer** (`30 5 * * 0`,
  Sunday 05:30 local, staggered 30 min after D2). Produces one
  `kind='reasoning'`, `meta.dimension='calibration'`, `meta.domain=…` memo
  per domain summarising brier + drift + trend over the past 7 days, prior
  7 days for trend, and prior 21 days for sustained-drift detection.
  Idempotent on `(meta.dimension, meta.domain, meta.week_starting)`. When
  drift sign is large (`>= meta_narrative_rule_threshold`, default 0.15) and
  sustained over `meta_narrative_rule_min_weeks` consecutive weeks (default
  2), emits a `rule_candidates` row with `kind='behavior'` and
  `payload.source='meta_cognition_calibration'` (discriminator lives on
  `payload`, not `meta` — `rule_candidates` is SCHEMAFULL and undeclared
  `meta` is silently dropped).

### cadence (alpha.16, Theme 3)
**Triggered cognition with cost-budget enforcement.** Three steps —
`reflection`, `comm-style`, `calibration` — can fire on triggers, drastically
cutting latency from the next-night dream run to the next 60s heartbeat.
- Files: `system/cognition/dream/{cursors,budget,dispatch}.js`,
  `system/runtime/daemon/cadence-consumer.js`.
- Producers: `reinforcement.js` (on `corrected` → reflection trigger),
  `foresight.resolve` (prediction resolved → calibration trigger).
- Consumer: heartbeat 60s tick drains `dream_triggers`, enforces debounce
  / hourly cap / daily cap / daily token budget (with live decrement).
  Marks each trigger with `outcome` (ran|debounced|capped|budget_exceeded|error|expired).
- Budget: 7-day rolling median of daily `cadence_telemetry` token sums
  × `(1 - safety_margin)`. Per-step cost estimated from median of last 10
  successful runs.
- Tunables in `runtime:cadence.config`: per-step `trigger_eligible`,
  `debounce_minutes`, `max_per_hour`, `max_per_day`, plus global
  `daily_token_budget`, `budget_safety_margin`, `trigger_ttl_days`,
  `consume_batch_size`.

### action-trust (audit + decay + escalation, alpha.16, Theme 2b)
**Every state change leaves an audit trail.** `action_trust_ledger` rows
emitted by `setActionTrust`, `recordOutcome`, `runActionTrustDecay`, and
the auto-block path. Decay sweep (6h heartbeat) demotes stale `AUTO`
classes. Three consecutive corrections with no `success` between → state
escalates to `DENY` automatically.
- Files: `system/cognition/jobs/action-trust.js`.
- Inspect via Theme 4 MCP tool `explain_action_trust({class})`.

### arcs (alpha.16, Theme 1b)
**Multi-episode containers.** Activity arcs cluster related episodes by
shared participating entities. State machine: active → paused (idle
14d) → closed (idle 60d). Created automatically by `step-arcs`
(nightly), deduped against existing active|paused arcs by entity-set
Jaccard similarity. Manual MCP access via `list_arcs` and `get_arc`.
- Files: `system/cognition/memory/arcs.js`, `system/cognition/dream/step-arcs.js`,
  `system/cognition/jobs/internal/close-stale-episodes.js`.

### compaction (alpha.16, Theme 1a)
**Hot/archive two-tier memory.** `step-compaction` runs nightly after
`step-scope-cleanup`:
- **Dedup pass** groups `kind='knowledge'` memos by `content_hash` and
  emits `supersedes` edges from the canonical to the rest (existing
  `fn::freshness` returns 0 for superseded).
- **Archive pass** moves aged-out, low-signal memos to `archive_memos` +
  incident edges to `archive_edges` + audit to `archive_log`. Recall
  structurally cannot reach archive (no FTS / vector index).
- Restore via `restoreMemo(db, archived_id)` round-trips content + edges.

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

### introspection (alpha.16, Theme 4)
**Eight read-only MCP tools** for "why did Robin do X?":
- `explain_recall` — recall_log + score components + sources (private redacted).
- `explain_belief` — evidence_ledger replay + derivation formula.
- `explain_action_trust` — current state + full ledger history.
- `explain_state_inference` — Latest state_inference memo for a source, supersedes chain, calibration replay.
- `show_pending_triggers` — queue depth.
- `show_step_health` — cadence_telemetry rollup per step.
- `recent_refusals` — discretion refusals listing.
- `archive_history` — archive_log filtered by memo.

Plus `robin doctor --health` — status rollups (token budget, pending
triggers, pending recall_log > 7d, dream freshness, faculty errors,
state-inference activity). Exit codes 0/1/2 for cron monitoring. `--json`
for machine-readable output.

### telemetry (Cognition C3, post-alpha.16)

Two-tier classification:

- **Hot** (rolled up hourly into `telemetry_hourly`):
  - `intuition_telemetry` → `faculty='intuition'`, `event_kind='recall'`.
    Dimensions: `source`, `mmr_path`. Metric sums: `latency_ms_sum`,
    `tokens_injected_sum`, `hits_sum`, `query_chars_sum`.
  - `recall_log` (via `evaluated_at` cursor) → `faculty='intuition'`,
    `event_kind='recall_attribution'` (dimensions: `mode`, `source`,
    `focus_block_present`; metric sums: `used_count_sum`, `total_sum`,
    `dropped_hits_sum`, `elapsed_ms_sum`, `focus_block_tokens_sum`) AND
    `faculty='reinforcement'`, `event_kind='evaluate'` (dimensions:
    `outcome`).
  - `cadence_telemetry` (hot prefixes `belief.%`, `dream.%`) →
    `faculty='belief'` / `event_kind='<sub_step>'` and `faculty='dream'`
    / `event_kind='<sub_step>'`. Dimensions: `success`.
  - `meta_cognition_telemetry` → `faculty='meta_cognition'`,
    `event_kind='run'`. Dimensions: `outcome`.

- **Cold** (raw only — query directly): `compaction_telemetry`,
  `state_inference_telemetry`, `recall_eval_runs`, non-hot
  `cadence_telemetry`.

**`show_telemetry_rollup` MCP tool.** Read-only window query over
`telemetry_hourly`. Default window `PT24H`; filter by `faculty` and/or
`event_kind`. Behind `runtime:telemetry.config.shadow_mode` for the first
week after migration — the tool returns an explanatory error until the
operator flips `shadow_mode=false`.

**`recordTelemetry()` contract for new faculties.** New telemetry writers
use `system/cognition/telemetry/recorder.js`:

```js
await recordTelemetry({
  db,
  faculty: 'intuition',
  event_kind: 'recall',
  dimensions: { source: 'intuition', mmr_path: 'cosine' }, // string|bool|int; ≤64 chars; charset [A-Za-z0-9_.-]
  metrics: { latency_ms: 18, contradictions_suppressed_by_rule: { low_confidence: 3 } }, // object metrics fan out (≤16 keys)
  meta: { query: 'free text goes here' }, // FLEXIBLE per-row extras — never in dimensions
});
```

Existing recorders (`intuition_telemetry`, `recall_log`, `cadence_telemetry`)
are grandfathered — they continue to write directly. The aggregator
translates their column shape into the umbrella row family at rollup time.

## See also

- [`architecture.md`](architecture.md) — how faculties fit into the request lifecycle
- [`development.md`](development.md) — adding a new memo kind, edge kind, or integration
- `docs/superpowers/specs/2026-05-11-robin-v2-database-and-memory-redesign-design.md` — design rationale
