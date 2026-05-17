-- 0032-triggers.surql
--
-- Substrate for the event-driven trigger engine (M1).
--
-- `trigger_fires` records every attempted fire — succeeded, skipped (cooldown
-- or condition_false), or failed. The cooldown query reads the most recent
-- row per name; the engine treats absence as "fire freely".
--
-- The polling cursor lives in `runtime` as `(runtime, trigger_cursor)` with
-- value = { last_event_ts: datetime, last_event_id: string }. Polling reads
-- events WHERE ts > last_event_ts ORDER BY ts ASC LIMIT 100 each tick.
--
-- No events-table changes in M1: the engine's in-process triggered_by_chain
-- cycle protection covers direct chaining. Whole-database loop protection
-- (where an action writes an event that fires another trigger) is deferred
-- until M3 adds the chain field to event writers.

DEFINE TABLE trigger_fires SCHEMAFULL TYPE NORMAL;
DEFINE FIELD name        ON trigger_fires TYPE string;
DEFINE FIELD fired_at    ON trigger_fires TYPE datetime DEFAULT time::now() READONLY;
DEFINE FIELD event_id    ON trigger_fires TYPE option<string>;
DEFINE FIELD status      ON trigger_fires TYPE string
  ASSERT $value IN ['ok', 'skipped', 'failed'];
DEFINE FIELD reason      ON trigger_fires TYPE option<string>;
DEFINE FIELD duration_ms ON trigger_fires TYPE option<int>;
DEFINE FIELD error       ON trigger_fires TYPE option<string>;
DEFINE FIELD dedup_hash  ON trigger_fires TYPE option<string>;
DEFINE INDEX tf_name_fired ON trigger_fires FIELDS name, fired_at;
DEFINE INDEX tf_status     ON trigger_fires FIELDS status;
