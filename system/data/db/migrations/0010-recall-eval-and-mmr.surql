-- ============================================================================
-- Cognition A3 + A1 + A2 — recall eval harness, real-cosine MMR, entity boost
-- ============================================================================

-- A3: per-run rollup table.
--
-- Schema choice: SCHEMAFULL for the top-level identifying/window/count
-- columns + INDEX coverage; `metrics` and `per_source` are object
-- FLEXIBLE so new per-k or per-bucket keys land without DDL. The
-- per-focus-block stratification, replay_kendall_mean, and
-- rows_with_null_session_* counters are nested under `metrics` rather
-- than declared as top-level fields — SCHEMAFULL would otherwise
-- reject them.
DEFINE TABLE recall_eval_runs SCHEMAFULL TYPE NORMAL;
DEFINE FIELD ts            ON recall_eval_runs TYPE datetime DEFAULT time::now() READONLY;
DEFINE FIELD profile       ON recall_eval_runs TYPE string;
DEFINE FIELD window_start  ON recall_eval_runs TYPE datetime;
DEFINE FIELD window_end    ON recall_eval_runs TYPE datetime;
DEFINE FIELD source_filter ON recall_eval_runs TYPE string DEFAULT 'all';
DEFINE FIELD replay        ON recall_eval_runs TYPE bool DEFAULT false;
DEFINE FIELD rows_scored   ON recall_eval_runs TYPE int;
DEFINE FIELD rows_pending  ON recall_eval_runs TYPE int;
DEFINE FIELD rows_skipped  ON recall_eval_runs TYPE int;
DEFINE FIELD metrics       ON recall_eval_runs TYPE object FLEXIBLE;
DEFINE FIELD per_source    ON recall_eval_runs TYPE option<object> FLEXIBLE;
DEFINE FIELD config_digest ON recall_eval_runs TYPE option<object> FLEXIBLE;
DEFINE FIELD git_sha       ON recall_eval_runs TYPE option<string>;
DEFINE INDEX recall_eval_runs_ts      ON recall_eval_runs FIELDS ts;
DEFINE INDEX recall_eval_runs_profile ON recall_eval_runs FIELDS profile, ts;

-- A1+A2 telemetry: intuition_telemetry needs FLEXIBLE meta. Today its columns
-- are fixed (0001-init.surql:279-286). Add an option<object> FLEXIBLE meta
-- field; existing rows get NONE.
DEFINE FIELD meta ON intuition_telemetry TYPE option<object> FLEXIBLE;

-- A3: thresholds for exit-code gating. Tune after first baseline run.
UPSERT runtime:`recall_eval.thresholds` CONTENT {
  value: {
    min_rows: 100,
    precision_at_6_min: 0.20,
    ndcg_at_6_min: 0.35,
    no_signal_rate_max: 0.30,
    mean_rank_of_neg_at_10_min: 4.0,
    default_window_days: 30,
    default_k: 6,
    default_limit: 5000
  }
};

-- A1+A2: extend runtime:recall.value with new keys. Field-path UPDATE
-- preserves the existing rrf_k / knn_overfetch_* / mmr_threshold keys set by
-- the hybrid-retrieval migration. The `?? <default>` form is idempotent on
-- re-run.
--
-- We reuse the existing `mmr_threshold` key for both paths. Substring
-- and cosine treat `0.92` as different distributions (substring is a
-- Jaccard-style overlap; cosine is a vector similarity). Only one path
-- fires per call; `mmr_use_cosine` picks the path. Splitting into
-- `mmr_threshold_cosine`/`mmr_threshold_substring` is a future task,
-- gated on telemetry showing distinct optimal defaults — until then the
-- single key plus `_legacy_substring` fallback is the contract.
UPDATE runtime:recall SET
  value.mmr_threshold = value.mmr_threshold ?? 0.92,
  value.mmr_threshold_legacy_substring = value.mmr_threshold_legacy_substring ?? 0.85,
  value.mmr_use_cosine = value.mmr_use_cosine ?? true,
  value.entity_boost_enabled = value.entity_boost_enabled ?? true,
  value.entity_boost_per_overlap = value.entity_boost_per_overlap ?? 0.10,
  value.entity_boost_max = value.entity_boost_max ?? 1.25,
  value.entity_catalog_size = value.entity_catalog_size ?? 500,
  value.entity_catalog_ttl_seconds = value.entity_catalog_ttl_seconds ?? 60;
