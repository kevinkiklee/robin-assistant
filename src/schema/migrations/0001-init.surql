-- 0001-init.surql — single init for the v2-redesign schema.
-- Replaces 14 v1 migrations (0001-init through 0014-predictions + three 0008-* variants).
-- Spec: docs/superpowers/specs/2026-05-11-robin-v2-database-and-memory-redesign-design.md
--
-- This migration defines the substrate (events, memos, entities, episodes),
-- the single edges table with cascade-on-delete event triggers, the operational
-- tables (persona, runtime, runtime_sessions, runtime_jobs, intuition_telemetry,
-- recall_log, refusals, action_trust, rule_candidates, rules, _migrations), and
-- the fn::freshness SurrealQL function. Per-profile embedding tables live in
-- 0002-embeddings-<profile>.surql, picked by the migration runner based on
-- runtime config.

DEFINE DATABASE IF NOT EXISTS main STRICT;

-- ----------------------------------------------------------------------------
-- _migrations bookkeeping
-- ----------------------------------------------------------------------------

DEFINE TABLE _migrations SCHEMAFULL TYPE NORMAL;
DEFINE FIELD version    ON _migrations TYPE int;
DEFINE FIELD name       ON _migrations TYPE string;
DEFINE FIELD checksum   ON _migrations TYPE string;
DEFINE FIELD applied_at ON _migrations TYPE datetime DEFAULT time::now() READONLY;
DEFINE INDEX _migrations_version ON _migrations FIELDS version UNIQUE;

-- ----------------------------------------------------------------------------
-- Substrate: events
-- ----------------------------------------------------------------------------

DEFINE TABLE events SCHEMAFULL TYPE NORMAL;
DEFINE FIELD source        ON events TYPE string;
DEFINE FIELD content       ON events TYPE string ASSERT string::len($value) > 0;
DEFINE FIELD content_hash  ON events TYPE option<string>;
DEFINE FIELD ts            ON events TYPE datetime DEFAULT time::now() READONLY;
DEFINE FIELD trust         ON events TYPE string DEFAULT 'trusted';
DEFINE FIELD scope         ON events TYPE string DEFAULT 'global';
DEFINE FIELD tags          ON events TYPE array<string> DEFAULT [];
DEFINE FIELD attachments   ON events TYPE array<object> DEFAULT [];
DEFINE FIELD meta          ON events TYPE option<object> FLEXIBLE;
DEFINE FIELD biographed_at ON events TYPE option<datetime>;
DEFINE FIELD dreamed_at    ON events TYPE option<datetime>;
DEFINE FIELD episode_id    ON events TYPE option<record<episodes>>;
DEFINE INDEX events_ts          ON events FIELDS ts;
DEFINE INDEX events_source      ON events FIELDS source;
DEFINE INDEX events_trust       ON events FIELDS trust;
DEFINE INDEX events_scope       ON events FIELDS scope;
DEFINE INDEX events_scope_ts    ON events FIELDS scope, ts;
DEFINE INDEX events_tags        ON events FIELDS tags;
DEFINE INDEX events_chash       ON events FIELDS content_hash;
DEFINE INDEX events_biographed  ON events FIELDS biographed_at;
DEFINE INDEX events_dreamed     ON events FIELDS dreamed_at;
DEFINE INDEX events_episode     ON events FIELDS episode_id;

-- ----------------------------------------------------------------------------
-- Substrate: memos (discriminated by kind; per-kind extras live in meta.*)
-- ----------------------------------------------------------------------------

DEFINE TABLE memos SCHEMAFULL TYPE NORMAL;
DEFINE FIELD kind          ON memos TYPE string;
DEFINE FIELD content       ON memos TYPE string ASSERT string::len($value) > 0;
DEFINE FIELD content_hash  ON memos TYPE option<string>;
DEFINE FIELD confidence    ON memos TYPE float DEFAULT 0.5
  ASSERT $value >= 0 AND $value <= 1;
DEFINE FIELD signal_count  ON memos TYPE int DEFAULT 1;
DEFINE FIELD decay_anchor  ON memos TYPE datetime DEFAULT time::now();
DEFINE FIELD derived_by    ON memos TYPE string;
DEFINE FIELD derived_at    ON memos TYPE datetime DEFAULT time::now() READONLY;
DEFINE FIELD updated_at    ON memos TYPE datetime VALUE time::now();
DEFINE FIELD last_active   ON memos TYPE datetime DEFAULT time::now();
DEFINE FIELD scope         ON memos TYPE string DEFAULT 'global';
DEFINE FIELD tags          ON memos TYPE array<string> DEFAULT [];
DEFINE FIELD meta          ON memos TYPE option<object> FLEXIBLE;
DEFINE INDEX memos_kind              ON memos FIELDS kind;
DEFINE INDEX memos_kind_active       ON memos FIELDS kind, last_active;
DEFINE INDEX memos_kind_derived      ON memos FIELDS kind, derived_at;
DEFINE INDEX memos_kind_scope_active ON memos FIELDS kind, scope, last_active;
DEFINE INDEX memos_chash             ON memos FIELDS content_hash;
DEFINE INDEX memos_scope             ON memos FIELDS scope;
DEFINE INDEX memos_tags              ON memos FIELDS tags;
DEFINE INDEX memos_habit_name        ON memos FIELDS kind, meta.name;
DEFINE INDEX memos_prediction_open   ON memos FIELDS kind, meta.resolved_at;
DEFINE INDEX memos_prediction_kind   ON memos FIELDS kind, meta.statement_kind;

-- ----------------------------------------------------------------------------
-- Substrate: entities
-- ----------------------------------------------------------------------------

DEFINE TABLE entities SCHEMAFULL TYPE NORMAL;
DEFINE FIELD name        ON entities TYPE string ASSERT string::len($value) > 0;
DEFINE FIELD name_lower  ON entities TYPE string VALUE string::lowercase(name) READONLY;
DEFINE FIELD type        ON entities TYPE string;
DEFINE FIELD scope       ON entities TYPE string DEFAULT 'global';
DEFINE FIELD tags        ON entities TYPE array<string> DEFAULT [];
DEFINE FIELD created_at  ON entities TYPE datetime DEFAULT time::now() READONLY;
DEFINE FIELD meta        ON entities TYPE option<object> FLEXIBLE;
DEFINE INDEX entities_name_lower    ON entities FIELDS name_lower, type;
DEFINE INDEX entities_scope         ON entities FIELDS scope;
DEFINE INDEX entities_tags          ON entities FIELDS tags;

-- ----------------------------------------------------------------------------
-- Episodes: narrative containers
-- ----------------------------------------------------------------------------

DEFINE TABLE episodes SCHEMAFULL TYPE NORMAL;
DEFINE FIELD started_at  ON episodes TYPE datetime DEFAULT time::now() READONLY;
DEFINE FIELD ended_at    ON episodes TYPE option<datetime>;
DEFINE FIELD source      ON episodes TYPE string;
DEFINE FIELD scope       ON episodes TYPE string DEFAULT 'global';
DEFINE FIELD summary     ON episodes TYPE option<string>;
DEFINE FIELD meta        ON episodes TYPE option<object> FLEXIBLE;
DEFINE INDEX episodes_started  ON episodes FIELDS started_at;
DEFINE INDEX episodes_source   ON episodes FIELDS source;
DEFINE INDEX episodes_active   ON episodes FIELDS source, ended_at;
DEFINE INDEX episodes_scope    ON episodes FIELDS scope;

-- ----------------------------------------------------------------------------
-- Edges (single generic table replacing 6 v1 per-relation tables)
-- ----------------------------------------------------------------------------

DEFINE TABLE edges SCHEMAFULL TYPE NORMAL;
DEFINE FIELD kind        ON edges TYPE string;
DEFINE FIELD from        ON edges TYPE record;
DEFINE FIELD to          ON edges TYPE record;
DEFINE FIELD weight      ON edges TYPE option<float>;
DEFINE FIELD last_seen   ON edges TYPE option<datetime>;
DEFINE FIELD valid_from  ON edges TYPE option<datetime>;
DEFINE FIELD valid_until ON edges TYPE option<datetime>;
DEFINE FIELD context     ON edges TYPE option<string>;
DEFINE FIELD created_at  ON edges TYPE datetime DEFAULT time::now() READONLY;
DEFINE FIELD meta        ON edges TYPE option<object> FLEXIBLE;
DEFINE INDEX edges_kind_from   ON edges FIELDS kind, from;
DEFINE INDEX edges_kind_to     ON edges FIELDS kind, to;
DEFINE INDEX edges_kind_valid  ON edges FIELDS kind, valid_from, valid_until;

-- Cascade-on-delete via table events: dangling edges removed in the same tx.
DEFINE EVENT cascade_edges_events    ON events    WHEN $event = "DELETE"
  THEN { DELETE edges WHERE from = $before.id OR to = $before.id; };
DEFINE EVENT cascade_edges_entities  ON entities  WHEN $event = "DELETE"
  THEN { DELETE edges WHERE from = $before.id OR to = $before.id; };
DEFINE EVENT cascade_edges_memos     ON memos     WHEN $event = "DELETE"
  THEN { DELETE edges WHERE from = $before.id OR to = $before.id; };
DEFINE EVENT cascade_edges_episodes  ON episodes  WHEN $event = "DELETE"
  THEN { DELETE edges WHERE from = $before.id OR to = $before.id; };

-- ----------------------------------------------------------------------------
-- fn::freshness — server-side decay + supersedes-aware ranking score
-- ----------------------------------------------------------------------------

DEFINE FUNCTION fn::freshness($memo: record<memos>) {
  LET $m = $memo.*;
  LET $superseded = (SELECT count() AS n FROM edges WHERE kind = 'supersedes' AND to = $memo GROUP ALL)[0].n ?? 0;
  IF $superseded > 0 { RETURN 0; };
  LET $half_life_ms = IF $m.kind = 'knowledge' { 15552000000 }
                      ELSE IF $m.kind = 'habit' { 5184000000 }
                      ELSE IF $m.kind = 'thread' { 2592000000 }
                      ELSE IF $m.kind = 'prediction' { 31536000000 }
                      ELSE { 7776000000 };
  LET $age_ms = (time::now() - $m.decay_anchor) / 1ms;
  LET $decay = math::pow(0.5, $age_ms / $half_life_ms);
  LET $reinforced = math::log(1 + $m.signal_count, 2);
  RETURN math::min([1.0, $m.confidence * $decay * $reinforced]);
};

-- ----------------------------------------------------------------------------
-- Persona (singleton; renamed from v1 'profile' table)
-- ----------------------------------------------------------------------------

DEFINE TABLE persona SCHEMAFULL TYPE NORMAL;
DEFINE FIELD name           ON persona TYPE option<string>;
DEFINE FIELD display_name   ON persona TYPE option<string>;
DEFINE FIELD pronouns       ON persona TYPE option<string>;
DEFINE FIELD timezone       ON persona TYPE option<string>;
DEFINE FIELD interests      ON persona TYPE option<array<string>>;
DEFINE FIELD comm_style     ON persona TYPE option<object> FLEXIBLE;
DEFINE FIELD calibration    ON persona TYPE option<object> FLEXIBLE;
DEFINE FIELD updated_at     ON persona TYPE datetime VALUE time::now();
DEFINE FIELD meta           ON persona TYPE option<object> FLEXIBLE;

-- Seed the singleton with an empty meta so persona:singleton always exists.
UPSERT persona:singleton CONTENT { meta: {} } RETURN NONE;

-- ----------------------------------------------------------------------------
-- Runtime KV singletons
-- ----------------------------------------------------------------------------

DEFINE TABLE runtime SCHEMAFULL TYPE NORMAL;
DEFINE FIELD value      ON runtime TYPE object FLEXIBLE;
DEFINE FIELD updated_at ON runtime TYPE datetime VALUE time::now();

-- ----------------------------------------------------------------------------
-- Runtime sessions (host session registry)
-- ----------------------------------------------------------------------------

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

-- ----------------------------------------------------------------------------
-- Runtime jobs (cron-driven internal job state)
-- ----------------------------------------------------------------------------

DEFINE TABLE runtime_jobs SCHEMAFULL TYPE NORMAL;
DEFINE FIELD name              ON runtime_jobs TYPE string;
DEFINE FIELD enabled           ON runtime_jobs TYPE bool;
DEFINE FIELD schedule          ON runtime_jobs TYPE string;
DEFINE FIELD runtime           ON runtime_jobs TYPE string ASSERT $value IN ['agent', 'internal'];
DEFINE FIELD catch_up          ON runtime_jobs TYPE bool;
DEFINE FIELD notify            ON runtime_jobs TYPE string;
DEFINE FIELD notify_on_failure ON runtime_jobs TYPE bool;
DEFINE FIELD timeout_minutes   ON runtime_jobs TYPE int;
DEFINE FIELD manually_runnable ON runtime_jobs TYPE bool DEFAULT true;
DEFINE FIELD last_run_at       ON runtime_jobs TYPE option<datetime>;
DEFINE FIELD last_run_ok       ON runtime_jobs TYPE option<bool>;
DEFINE FIELD last_error        ON runtime_jobs TYPE option<string>;
DEFINE FIELD last_duration_ms  ON runtime_jobs TYPE option<int>;
DEFINE FIELD next_run_at       ON runtime_jobs TYPE option<datetime>;
DEFINE FIELD consecutive_failures ON runtime_jobs TYPE int DEFAULT 0;
DEFINE FIELD in_flight         ON runtime_jobs TYPE bool DEFAULT false;
DEFINE FIELD updated_at        ON runtime_jobs TYPE datetime DEFAULT time::now();
DEFINE INDEX runtime_jobs_name ON runtime_jobs FIELDS name UNIQUE;

-- ----------------------------------------------------------------------------
-- Intuition telemetry (renamed from runtime_intuition_telemetry)
-- ----------------------------------------------------------------------------

DEFINE TABLE intuition_telemetry SCHEMAFULL TYPE NORMAL;
DEFINE FIELD ts              ON intuition_telemetry TYPE datetime DEFAULT time::now() READONLY;
DEFINE FIELD query_chars     ON intuition_telemetry TYPE int;
DEFINE FIELD hits            ON intuition_telemetry TYPE int;
DEFINE FIELD tokens_injected ON intuition_telemetry TYPE int;
DEFINE FIELD latency_ms      ON intuition_telemetry TYPE int;
DEFINE FIELD truncated       ON intuition_telemetry TYPE bool DEFAULT false;
DEFINE INDEX intuition_telemetry_ts ON intuition_telemetry FIELDS ts;

-- ----------------------------------------------------------------------------
-- Recall log (renamed from recall_events; drives the reinforcement loop)
-- ----------------------------------------------------------------------------

DEFINE TABLE recall_log SCHEMAFULL TYPE NORMAL;
DEFINE FIELD ts            ON recall_log TYPE datetime DEFAULT time::now() READONLY;
DEFINE FIELD session_id    ON recall_log TYPE option<string>;
DEFINE FIELD query         ON recall_log TYPE string;
DEFINE FIELD k             ON recall_log TYPE int;
DEFINE FIELD ranked_hits    ON recall_log TYPE array;
DEFINE FIELD ranked_hits[*] ON recall_log TYPE object FLEXIBLE;
DEFINE FIELD outcome       ON recall_log TYPE string DEFAULT 'pending'
  ASSERT $value IN ['pending', 'reinforced', 'corrected', 'evaluated_no_signal'];
DEFINE FIELD evaluated_at  ON recall_log TYPE option<datetime>;
DEFINE FIELD meta          ON recall_log TYPE option<object> FLEXIBLE;
DEFINE INDEX recall_log_ts        ON recall_log FIELDS ts;
DEFINE INDEX recall_log_outcome   ON recall_log FIELDS outcome;
DEFINE INDEX recall_log_session   ON recall_log FIELDS session_id;

-- ----------------------------------------------------------------------------
-- Refusals (discretion log)
-- ----------------------------------------------------------------------------

DEFINE TABLE refusals SCHEMAFULL TYPE NORMAL;
DEFINE FIELD direction   ON refusals TYPE string DEFAULT 'outbound'
  ASSERT $value IN ['inbound', 'outbound'];
DEFINE FIELD content     ON refusals TYPE string;
DEFINE FIELD reason      ON refusals TYPE string;
DEFINE FIELD tool        ON refusals TYPE option<string>;
DEFINE FIELD created_at  ON refusals TYPE datetime DEFAULT time::now() READONLY;
DEFINE FIELD meta        ON refusals TYPE option<object> FLEXIBLE;
DEFINE INDEX refusals_direction  ON refusals FIELDS direction;
DEFINE INDEX refusals_created    ON refusals FIELDS created_at;

-- ----------------------------------------------------------------------------
-- Action trust (per-(tool, action_template) policy ledger)
-- ----------------------------------------------------------------------------

DEFINE TABLE action_trust SCHEMAFULL TYPE NORMAL;
DEFINE FIELD class                ON action_trust TYPE string;
DEFINE FIELD state                ON action_trust TYPE string
  ASSERT $value IN ['AUTO', 'ASK', 'NEVER'];
DEFINE FIELD set_by               ON action_trust TYPE string
  ASSERT $value IN ['user', 'correction', 'default'];
DEFINE FIELD success_count        ON action_trust TYPE int DEFAULT 0;
DEFINE FIELD correction_count     ON action_trust TYPE int DEFAULT 0;
DEFINE FIELD last_used_at         ON action_trust TYPE option<datetime>;
DEFINE FIELD last_state_change_at ON action_trust TYPE datetime DEFAULT time::now();
DEFINE FIELD updated_at           ON action_trust TYPE datetime VALUE time::now();
DEFINE INDEX action_trust_class   ON action_trust FIELDS class UNIQUE;

-- ----------------------------------------------------------------------------
-- Rule candidates + rules (reflection workflow)
-- ----------------------------------------------------------------------------

DEFINE TABLE rule_candidates SCHEMAFULL TYPE NORMAL;
DEFINE FIELD content          ON rule_candidates TYPE string;
DEFINE FIELD kind             ON rule_candidates TYPE string
  ASSERT $value IN ['behavior', 'profile_update', 'conflict_warning', 'reinforce_behavior'];
DEFINE FIELD signal_events    ON rule_candidates TYPE array<record<events>> DEFAULT [];
DEFINE FIELD payload          ON rule_candidates TYPE option<object> FLEXIBLE;
DEFINE FIELD confidence       ON rule_candidates TYPE float
  ASSERT $value >= 0 AND $value <= 1;
DEFINE FIELD status           ON rule_candidates TYPE string
  ASSERT $value IN ['pending', 'approved', 'rejected', 'expired'];
DEFINE FIELD created_at       ON rule_candidates TYPE datetime DEFAULT time::now() READONLY;
DEFINE FIELD reviewed_at      ON rule_candidates TYPE option<datetime>;
DEFINE FIELD rejected_reason  ON rule_candidates TYPE option<string>;
DEFINE INDEX rule_candidates_status  ON rule_candidates FIELDS status;
DEFINE INDEX rule_candidates_created ON rule_candidates FIELDS created_at;

DEFINE TABLE rules SCHEMAFULL TYPE NORMAL;
DEFINE FIELD content          ON rules TYPE string;
DEFINE FIELD kind             ON rules TYPE string
  ASSERT $value IN ['behavior', 'profile_update', 'reinforce_behavior'];
DEFINE FIELD payload          ON rules TYPE option<object> FLEXIBLE;
DEFINE FIELD source_candidate ON rules TYPE option<record<rule_candidates>>;
DEFINE FIELD priority         ON rules TYPE int DEFAULT 50;
DEFINE FIELD active           ON rules TYPE bool DEFAULT true;
DEFINE FIELD created_at       ON rules TYPE datetime DEFAULT time::now() READONLY;
DEFINE FIELD updated_at       ON rules TYPE datetime VALUE time::now();
DEFINE FIELD meta             ON rules TYPE option<object> FLEXIBLE;
DEFINE INDEX rules_active     ON rules FIELDS active, priority;
