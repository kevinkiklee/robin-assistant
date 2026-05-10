-- Phase 4a: daily-use safety floor — sessions, tamper state, auto-recall telemetry, refusals direction.

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

-- runtime:tamper_state — singleton row written by daemon-boot tamper-check.
DEFINE TABLE runtime_tamper_state SCHEMAFULL TYPE NORMAL;
DEFINE FIELD checked_at ON runtime_tamper_state TYPE datetime DEFAULT time::now();
DEFINE FIELD ok         ON runtime_tamper_state TYPE bool DEFAULT true;
DEFINE FIELD findings   ON runtime_tamper_state TYPE array DEFAULT [];
DEFINE FIELD findings.* ON runtime_tamper_state TYPE object FLEXIBLE;

-- runtime:auto_recall_telemetry — append-only per-fire telemetry for tuning.
-- Pruning to 30 days happens in dream/maintenance (4d work); for now unbounded.
DEFINE TABLE runtime_auto_recall_telemetry SCHEMAFULL TYPE NORMAL;
DEFINE FIELD ts              ON runtime_auto_recall_telemetry TYPE datetime DEFAULT time::now() READONLY;
DEFINE FIELD query_chars     ON runtime_auto_recall_telemetry TYPE int;
DEFINE FIELD hits            ON runtime_auto_recall_telemetry TYPE int;
DEFINE FIELD tokens_injected ON runtime_auto_recall_telemetry TYPE int;
DEFINE FIELD latency_ms      ON runtime_auto_recall_telemetry TYPE int;
DEFINE FIELD truncated       ON runtime_auto_recall_telemetry TYPE bool DEFAULT false;
DEFINE INDEX runtime_auto_recall_telemetry_ts ON runtime_auto_recall_telemetry FIELDS ts;

-- outbound_refusals.direction — distinguish inbound (PII guard refused a memory write)
-- from outbound (existing behavior: refused an outbound write). Default 'outbound'
-- keeps existing rows compatible.
DEFINE FIELD direction ON outbound_refusals TYPE string DEFAULT 'outbound'
  ASSERT $value IN ['inbound', 'outbound'];
DEFINE INDEX outbound_refusals_direction ON outbound_refusals FIELDS direction;
