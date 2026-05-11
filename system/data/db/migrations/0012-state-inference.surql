-- ============================================================================
-- Cognition D1-initial-off: state_inference activation (schema + dark-launch)
--
-- Adds:
--   1. memos_state_inference_source — composite index for `latestForSource` lookups
--      filtered by (kind, meta.source, derived_at).
--   2. state_inference_telemetry — per-tick outcome table consumed by
--      show_step_health and the rollout decision (spec §3.3).
--   3. runtime:state_inference.config — config row seeded with enabled=false
--      (three-valued: false | 'shadow' | true).
--
-- No DDL changes to memos: `state_inference` is already a valid kind
-- (kind-registry.js lines 31–37).
--
-- NOTE: fn::freshness mirror is intentionally deferred (spec §3.4) — the
-- recall pipeline never sorts state_inference by server-side freshness; the
-- client-side decay.js mirror is authoritative. A TODO comment near the
-- HALF_LIFE_BY_KIND_MS function in 0001-init.surql tracks the pairing.
-- ============================================================================

DEFINE INDEX memos_state_inference_source ON memos FIELDS kind, meta.source, derived_at;

DEFINE TABLE state_inference_telemetry SCHEMAFULL TYPE NORMAL;
DEFINE FIELD ts          ON state_inference_telemetry TYPE datetime DEFAULT time::now() READONLY;
DEFINE FIELD source      ON state_inference_telemetry TYPE string;
DEFINE FIELD outcome     ON state_inference_telemetry TYPE string;
  -- 'wrote' | 'skipped_unchanged' | 'skipped_disabled' | 'dropped_thin' | 'error'
DEFINE FIELD signal_hash ON state_inference_telemetry TYPE option<string>;
DEFINE FIELD tokens_in   ON state_inference_telemetry TYPE option<int>;
DEFINE FIELD tokens_out  ON state_inference_telemetry TYPE option<int>;
DEFINE FIELD latency_ms  ON state_inference_telemetry TYPE option<int>;
DEFINE FIELD reason      ON state_inference_telemetry TYPE option<string>;
DEFINE INDEX si_tel_ts        ON state_inference_telemetry FIELDS ts;
DEFINE INDEX si_tel_source_ts ON state_inference_telemetry FIELDS source, ts;

UPSERT runtime:`state_inference.config` SET value = {
  enabled: false,
  tick_ms: 300000,
  attention_window_min: 90,
  refresh_after_minutes: 30,
  min_events_for_inference: 2,
  max_sources_per_tick: 4,
  min_confidence_to_surface: 0.5,
  stale_after_minutes: 120,
  pivot_weight: 1.0,
  corroborate_weight: 1.0
};
