-- 0027-self-improvement-v2.surql
--
-- Substrate for the self-improvement v2 introspection faculty (Phase 1).
--
-- Defines `task_close_queue`: a TTL-shaped work queue whose rows are written
-- by the introspection emitter when a task closes (task_type, task_id,
-- event_id) and consumed by the introspection processor. claimed_by +
-- expires_at give safe multi-restart claim semantics — a claimer that dies
-- mid-flight leaves a row whose expires_at drifts past "now", allowing
-- another worker to claim it on the next tick.
--
-- No side-effects on existing tables. The six new VALID_SOURCES strings
-- (explicit_correction, task_outcome, playbook_proposed, playbook_applied,
-- introspection_sample, confidence_resolved) are gated by the application
-- layer (record-event.js) and require no schema change here.

DEFINE TABLE task_close_queue SCHEMAFULL;
DEFINE FIELD task_type   ON task_close_queue TYPE string;
DEFINE FIELD task_id     ON task_close_queue TYPE string;
DEFINE FIELD event_id    ON task_close_queue TYPE record<events>;
DEFINE FIELD payload     ON task_close_queue TYPE option<object> FLEXIBLE;
DEFINE FIELD enqueued_at ON task_close_queue TYPE datetime DEFAULT time::now();
DEFINE FIELD claimed_at  ON task_close_queue TYPE option<datetime>;
DEFINE FIELD claimed_by  ON task_close_queue TYPE option<string>;
DEFINE FIELD expires_at  ON task_close_queue TYPE datetime;
DEFINE INDEX task_close_queue_unclaimed ON task_close_queue FIELDS claimed_at, expires_at;
DEFINE INDEX task_close_queue_task_type ON task_close_queue FIELDS task_type;
