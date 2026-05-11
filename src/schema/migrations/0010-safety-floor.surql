-- Phase 4a: daily-use safety floor — sessions, introspection state, intuition telemetry, refusals direction.

-- runtime:sessions — host-session registry for multi-session coordination + transcript paths.
DEFINE TABLE runtime_sessions SCHEMAFULL TYPE NORMAL;
DEFINE FIELD session_id      ON runtime_sessions TYPE string;
DEFINE FIELD host            ON runtime_sessions TYPE string
  ASSERT $value IN ['claude-code', 'gemini-cli', 'unknown'];
DEFINE FIELD pid             ON runtime_sessions TYPE option<int>;
DEFINE FIELD transcript_path ON runtime_sessions TYPE option<string>;
DEFINE FIELD started_at      ON runtime_sessions TYPE datetime DEFAULT time::now() READONLY;
DEFINE FIELD last_seen_at    ON runtime_sessions TYPE datetime DEFAULT time::now();
DEFINE FIELD status          ON runtime_sessions TYPE string DEFAULT 'active'
  ASSERT $value IN ['active', 'ended', 'stale'];
DEFINE INDEX runtime_sessions_status   ON runtime_sessions FIELDS status;
DEFINE INDEX runtime_sessions_session  ON runtime_sessions FIELDS session_id UNIQUE;

-- runtime:introspection_state — singleton row written by daemon-boot introspection.
DEFINE TABLE runtime_introspection_state SCHEMAFULL TYPE NORMAL;
DEFINE FIELD checked_at ON runtime_introspection_state TYPE datetime DEFAULT time::now();
DEFINE FIELD ok         ON runtime_introspection_state TYPE bool DEFAULT true;
DEFINE FIELD findings   ON runtime_introspection_state TYPE array DEFAULT [];
DEFINE FIELD findings.* ON runtime_introspection_state TYPE object FLEXIBLE;

-- runtime:intuition_telemetry — append-only per-fire telemetry for tuning.
-- Pruning to 30 days happens in dream/maintenance; for now unbounded.
DEFINE TABLE runtime_intuition_telemetry SCHEMAFULL TYPE NORMAL;
DEFINE FIELD ts              ON runtime_intuition_telemetry TYPE datetime DEFAULT time::now() READONLY;
DEFINE FIELD query_chars     ON runtime_intuition_telemetry TYPE int;
DEFINE FIELD hits            ON runtime_intuition_telemetry TYPE int;
DEFINE FIELD tokens_injected ON runtime_intuition_telemetry TYPE int;
DEFINE FIELD latency_ms      ON runtime_intuition_telemetry TYPE int;
DEFINE FIELD truncated       ON runtime_intuition_telemetry TYPE bool DEFAULT false;
DEFINE INDEX runtime_intuition_telemetry_ts ON runtime_intuition_telemetry FIELDS ts;

-- refusals.direction — distinguish inbound (discretion refused a memory write)
-- from outbound (discretion refused a write to an external system).
DEFINE FIELD direction ON refusals TYPE string DEFAULT 'outbound'
  ASSERT $value IN ['inbound', 'outbound'];
DEFINE INDEX refusals_direction ON refusals FIELDS direction;
