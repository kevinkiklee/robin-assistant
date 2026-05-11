-- ============================================================================
-- Cognition D3: belief() gating tool config + meta-narrative writer config.
-- Additive. Seeds a single runtime config row and adds `meta` to
-- cadence_telemetry so belief.call telemetry can carry sample_rate +
-- recommendation breakdown for the C3 hot-bridge rollup.
-- ============================================================================

DEFINE FIELD IF NOT EXISTS meta ON cadence_telemetry TYPE option<object> FLEXIBLE;

UPSERT runtime:`belief.config` SET value = {
  default_threshold:              0.6,
  soften_floor:                   0.4,
  domain_thresholds:              {},
  relevance_threshold:            0.30,
  confidence_floor:               0.05,
  belief_overfetch_factor:        2.0,
  min_calibration_samples:        5,
  calibration_adjustment_gain:    1.0,
  expected_accuracy_baseline:     0.75,
  domain_entity_types:            ['topic', 'project', 'library'],
  shadow_mode:                    true,
  telemetry_enabled:              true,
  telemetry_sample_rate:          1.0,

  meta_narrative_enabled:         true,
  meta_narrative_min_samples:     5,
  meta_narrative_drift_threshold: 0.15,
  meta_narrative_window_days:     7,
  meta_narrative_rule_threshold:  0.15,
  meta_narrative_rule_min_weeks:  2
};
