-- ============================================================================
-- Theme 3: cognition cadence
-- Trigger queue + per-step cost telemetry + per-step processing cursors.
-- ============================================================================

DEFINE TABLE dream_triggers SCHEMAFULL TYPE NORMAL;
DEFINE FIELD step         ON dream_triggers TYPE string;
DEFINE FIELD reason       ON dream_triggers TYPE string;
DEFINE FIELD source_id    ON dream_triggers TYPE option<record>;
DEFINE FIELD requested_at ON dream_triggers TYPE datetime DEFAULT time::now() READONLY;
DEFINE FIELD processed_at ON dream_triggers TYPE option<datetime>;
DEFINE FIELD outcome      ON dream_triggers TYPE option<string>;
DEFINE FIELD meta         ON dream_triggers TYPE option<object> FLEXIBLE;
DEFINE INDEX dt_pending   ON dream_triggers FIELDS processed_at, requested_at;
DEFINE INDEX dt_step      ON dream_triggers FIELDS step, requested_at;

DEFINE TABLE cadence_telemetry SCHEMAFULL TYPE NORMAL;
DEFINE FIELD step         ON cadence_telemetry TYPE string;
DEFINE FIELD trigger_id   ON cadence_telemetry TYPE option<record<dream_triggers>>;
DEFINE FIELD ts           ON cadence_telemetry TYPE datetime DEFAULT time::now() READONLY;
DEFINE FIELD tokens_in    ON cadence_telemetry TYPE int DEFAULT 0;
DEFINE FIELD tokens_out   ON cadence_telemetry TYPE int DEFAULT 0;
DEFINE FIELD duration_ms  ON cadence_telemetry TYPE int DEFAULT 0;
DEFINE FIELD success      ON cadence_telemetry TYPE bool DEFAULT true;
DEFINE FIELD error        ON cadence_telemetry TYPE option<string>;
DEFINE INDEX ct_step_ts   ON cadence_telemetry FIELDS step, ts;
DEFINE INDEX ct_ts        ON cadence_telemetry FIELDS ts;

UPSERT runtime:`cadence.config` SET value = {
  daily_token_budget: 0,
  budget_safety_margin: 0.20,
  trigger_consumer_enabled: true,
  trigger_ttl_days: 7,
  consume_batch_size: 20,
  steps: {
    reflection:    { trigger_eligible: true,  debounce_minutes: 5,  max_per_hour: 4, max_per_day: 12 },
    'comm-style':  { trigger_eligible: true,  debounce_minutes: 30, max_per_hour: 2, max_per_day: 6 },
    calibration:   { trigger_eligible: true,  debounce_minutes: 60, max_per_hour: 1, max_per_day: 4 },
    knowledge:     { trigger_eligible: false },
    patterns:      { trigger_eligible: false },
    threads:       { trigger_eligible: false },
    profile:       { trigger_eligible: false },
    'scope-cleanup': { trigger_eligible: false },
    compaction:    { trigger_eligible: false }
  }
};

UPSERT runtime:`cadence.cursors` SET value = {};
