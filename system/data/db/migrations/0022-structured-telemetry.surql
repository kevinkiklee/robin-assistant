-- Cognition wave structured telemetry tables. Additive — existing
-- runtime-row counters (biographer) and cadence_telemetry rows (dream)
-- keep writing for back-compat; these tables provide structured
-- history for downstream tooling that wants per-run rows.

-- C1 follow-up: biographer per-batch telemetry. One row per batch.
DEFINE TABLE biographer_telemetry SCHEMAFULL TYPE NORMAL;
DEFINE FIELD ts            ON biographer_telemetry TYPE datetime DEFAULT time::now() READONLY;
DEFINE FIELD source        ON biographer_telemetry TYPE string;
DEFINE FIELD batch_size    ON biographer_telemetry TYPE int;
DEFINE FIELD via           ON biographer_telemetry TYPE string;
  -- 'batch' (single LLM call) | 'fallback' (per-event loop after batch failure)
DEFINE FIELD input_tokens  ON biographer_telemetry TYPE int DEFAULT 0;
DEFINE FIELD output_tokens ON biographer_telemetry TYPE int DEFAULT 0;
DEFINE FIELD duration_ms   ON biographer_telemetry TYPE int DEFAULT 0;
DEFINE FIELD fallback_reason ON biographer_telemetry TYPE option<string>;
  -- 'network' | 'outer_json' | 'batch_validation' (only present when via='fallback')
DEFINE INDEX bt_ts     ON biographer_telemetry FIELDS ts;
DEFINE INDEX bt_via_ts ON biographer_telemetry FIELDS via, ts;

-- C2 follow-up: dream per-step telemetry. One row per step per run.
-- Distinct from cadence_telemetry: rows here are dream-scoped only and
-- can be queried without filtering on `step` discriminator.
DEFINE TABLE dream_telemetry SCHEMAFULL TYPE NORMAL;
DEFINE FIELD ts           ON dream_telemetry TYPE datetime DEFAULT time::now() READONLY;
DEFINE FIELD step         ON dream_telemetry TYPE string;
DEFINE FIELD layer        ON dream_telemetry TYPE int;
DEFINE FIELD duration_ms  ON dream_telemetry TYPE int DEFAULT 0;
DEFINE FIELD tokens_in    ON dream_telemetry TYPE int DEFAULT 0;
DEFINE FIELD tokens_out   ON dream_telemetry TYPE int DEFAULT 0;
DEFINE FIELD success      ON dream_telemetry TYPE bool DEFAULT true;
DEFINE FIELD error        ON dream_telemetry TYPE option<string>;
DEFINE FIELD parallel     ON dream_telemetry TYPE bool DEFAULT false;
  -- true when the step ran via the parallel scheduler (C2); false on
  -- the serial fallback path. Lets ops compare wall-clock between paths.
DEFINE INDEX dt_step_ts ON dream_telemetry FIELDS step, ts;
DEFINE INDEX dt_ts      ON dream_telemetry FIELDS ts;
