-- ============================================================================
-- Cognition C3 — telemetry umbrella.
-- One rollup table + one config row + one cursor row + two recall_log
-- indexes + a one-time legacy backfill. Existing per-faculty raw tables
-- (intuition_telemetry, recall_log, cadence_telemetry, …) stay; this
-- migration is purely additive.
-- ============================================================================

-- §6.2 precondition: A3 adds `meta` to intuition_telemetry. A3 may or may
-- not have shipped yet (its migration is 0010-recall-eval-and-mmr.surql).
-- We add the field idempotently: if A3 has landed, this is a no-op via
-- IF NOT EXISTS; if A3 hasn't landed, C3's rollup SELECT against
-- `meta.from` / `meta.mmr_path` still works (returns null for those keys),
-- and A3's later migration will UPSERT-like define it again.
DEFINE FIELD IF NOT EXISTS meta ON intuition_telemetry TYPE option<object> FLEXIBLE;

-- ============================================================================
-- telemetry_hourly: the one rollup destination.
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

-- Compound index for "filter by (faculty, event_kind), order by hour".
DEFINE INDEX telemetry_hourly_key  ON telemetry_hourly FIELDS faculty, event_kind, hour;
-- Secondary index for time-window scans (doctor, MCP default window).
DEFINE INDEX telemetry_hourly_hour ON telemetry_hourly FIELDS hour;

-- ============================================================================
-- recall_log indexes required by the recall_log_eval cursor SELECT (§4.2).
-- Existing recall_log indexes are recall_log_ts / recall_log_outcome /
-- recall_log_session — none cover `evaluated_at`. Without these, the
-- hourly rollup full-scans recall_log every tick.
-- ============================================================================
DEFINE INDEX recall_log_evaluated_at      ON recall_log FIELDS evaluated_at;
DEFINE INDEX recall_log_outcome_evaluated ON recall_log FIELDS outcome, evaluated_at;

-- ============================================================================
-- One-time backfill: pre-B1 recall_log rows have `outcome` set but
-- `evaluated_at IS NONE` (the field was added by B1). The cursor's
-- `WHERE evaluated_at IS NOT NONE` filter would silently drop them.
-- Stamp legacy rows with their original `ts` so the first rollup picks
-- them up. Pending rows untouched.
-- ============================================================================
UPDATE recall_log SET evaluated_at = ts
  WHERE outcome != 'pending' AND evaluated_at IS NONE;

-- ============================================================================
-- Config + cursor seeds. Ship with shadow_mode=true (§8.1) so rollups
-- accumulate silently for one week before the MCP tool surfaces them.
-- ============================================================================
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

-- Initialise the cursor row empty; the aggregator falls back to
-- `now - cursor_fallback_window_hours` on first tick per cursor key.
UPSERT runtime:`telemetry.cursor` SET value = {};
