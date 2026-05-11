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
- Files: `system/cognition/intuition/handler.js` (hook entry), `system/cognition/intuition/inject.js` (daemon endpoint), `system/cognition/intuition/rank.js`.
- Behavior: Composes events + memos[kind=knowledge] recall via `store.searchEvents` + `store.searchMemos`. Ranks via `rank.score` (cosine × freshness × contradiction × trust × scope). MMR-lite diversity pass. Writes `intuition_telemetry` + `recall_log{outcome:pending}` rows. Returns a `<!-- relevant memory -->` block under a 1500-token budget.
- Inspect: `SELECT * FROM intuition_telemetry ORDER BY ts DESC LIMIT 20`.

### biographer
**Per-turn consolidation: turns raw events into structured entities, edges, and (rarely) memos.**
- Files: `system/cognition/biographer/pipeline.js`, `system/cognition/biographer/prompt.js`, `system/cognition/biographer/output.js`, `system/cognition/biographer/` (edges/stage1-exact/stage2-embedding/stage3-disambig/upsert-entity).
- Writes: `entities` (upserted via 3-stage cascade), `edges` (mentions/about/works_on/participates_in/occurs_with/before via `store.relateAll`), `events.biographed_at = time::now()`.

### heartbeat
**The 60-second scheduler tick.**
- Dispatches integration syncs, biographer queue, stale-session sweep, quiet-window cursor advance, internal jobs (notably `reinforce-recall`).

### discretion
**Refuses inappropriate writes (inbound), commands (bash), and outbound payloads.** Unchanged from v1 — three sub-mechanisms sharing the `refusals` table.

### dream
**Nightly multi-step consolidation into long-term memory.**
- Pipeline: step-knowledge → step-habits (from edges[kind='occurs_with']) → step-narrative (from edges[kind='mentions']) → step-persona → step-reflection → step-scope-cleanup. Plus comm-style and calibration sub-steps.
- step-knowledge emits `supersedes` edges when promoting contradicting facts (old memo preserved; `fn::freshness` returns 0).
- step-scope-cleanup promotes referenced ephemerals to global; prunes the rest (session: 7d, temp: 24h).

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

### introspection (alpha.16, Theme 4)
**Seven read-only MCP tools** for "why did Robin do X?":
- `explain_recall` — recall_log + score components + sources (private redacted).
- `explain_belief` — evidence_ledger replay + derivation formula.
- `explain_action_trust` — current state + full ledger history.
- `show_pending_triggers` — queue depth.
- `show_step_health` — cadence_telemetry rollup per step.
- `recent_refusals` — discretion refusals listing.
- `archive_history` — archive_log filtered by memo.

Plus `robin doctor --health` — status rollups (token budget, pending
triggers, dream freshness, faculty errors). Exit codes 0/1/2 for cron
monitoring. `--json` for machine-readable output.

## See also

- [`architecture.md`](architecture.md) — how faculties fit into the request lifecycle
- [`development.md`](development.md) — adding a new memo kind, edge kind, or integration
- `docs/superpowers/specs/2026-05-11-robin-v2-database-and-memory-redesign-design.md` — design rationale
