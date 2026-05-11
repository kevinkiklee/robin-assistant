-- ============================================================================
-- Cognition D2-initial-off: meta-cognition over recall failures (schema +
-- dark-launch). D2 reads `recall_log` and writes one `kind='reasoning'` memo
-- + 0-3 `rule_candidates` per weekly run.
--
-- Allocation map (verify against `system/data/db/migrations/` at land time):
--   0001..0008 — shipped (init, embeddings-{384,1024,3584}, evidence-ledger,
--                action-trust-ledger, cadence, compaction, arcs, doctor).
--   0009       — B1 per-hit-reinforcement.
--   0010       — A3 recall-eval-and-mmr (reserved).
--   0011       — C1 (recall-config consolidation, reserved).
--   0012/0013/0014 — D1 state-inference (reserved).
--   0015/0016  — B2 conflict-surfacing (reserved).
--   0017       — C3 telemetry-umbrella (reserved).
--   0018       — D2 meta-cognition (this migration; initial-off).
--   0019       — D2 shadow-flip (Phase 12, follow-up PR).
--   0020       — D3 meta-cognition-calibration (sibling).
--   0021       — D2 default-on (Phase 12, follow-up PR; gap reserved past D3).
-- ============================================================================

DEFINE TABLE meta_cognition_telemetry SCHEMAFULL TYPE NORMAL;
DEFINE FIELD ts                       ON meta_cognition_telemetry TYPE datetime DEFAULT time::now() READONLY;
DEFINE FIELD outcome                  ON meta_cognition_telemetry TYPE string;
  -- 'skipped_disabled' | 'skipped_below_threshold' | 'no_clusters'
  -- | 'shadow_complete' | 'complete' | 'llm_parse_error' | 'budget_exceeded'
  -- | 'error'
DEFINE FIELD corrected_count          ON meta_cognition_telemetry TYPE option<int>;
DEFINE FIELD unused_count             ON meta_cognition_telemetry TYPE option<int>;
DEFINE FIELD rows_after_privacy       ON meta_cognition_telemetry TYPE option<int>;
DEFINE FIELD dropped_private          ON meta_cognition_telemetry TYPE option<int>;
DEFINE FIELD clusters                 ON meta_cognition_telemetry TYPE option<int>;
DEFINE FIELD rules_proposed           ON meta_cognition_telemetry TYPE option<int>;
DEFINE FIELD rules_dropped_over_cap   ON meta_cognition_telemetry TYPE option<int>;
DEFINE FIELD tokens_in                ON meta_cognition_telemetry TYPE option<int>;
DEFINE FIELD tokens_out               ON meta_cognition_telemetry TYPE option<int>;
DEFINE FIELD duration_ms              ON meta_cognition_telemetry TYPE option<int>;
DEFINE FIELD week_starting            ON meta_cognition_telemetry TYPE option<string>;
DEFINE FIELD reasoning_memo_id        ON meta_cognition_telemetry TYPE option<record<memos>>;
DEFINE FIELD error                    ON meta_cognition_telemetry TYPE option<string>;
DEFINE INDEX mct_ts                   ON meta_cognition_telemetry FIELDS ts;

-- Seed config — ships disabled. Operator flips to 'shadow' then `true` via
-- the rollout migrations (0019, 0021) or via `UPDATE runtime:`meta_cognition.config``.
UPSERT runtime:`meta_cognition.config` SET value = {
  enabled: false,
  min_corrections_threshold: 5,
  lookback_days: 7,
  max_corrected_rows: 200,
  max_unused_rows: 200,
  top_k_clusters: 3,
  min_cluster_size: 2,
  unused_signal_weight: 0.33,
  tier: 'fast',
  max_tokens_in: 3000,
  max_tokens_out: 1200,
  max_rules_per_run: 3,
  weekly_token_budget: 6000,
  private_scope_action: 'drop',
  reasoning_memo_scope: 'global'
};
