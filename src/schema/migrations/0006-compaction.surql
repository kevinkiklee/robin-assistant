-- ============================================================================
-- Theme 1a: compaction & forgetting
-- archive_memos (cold tier), archive_edges (relocated incident edges),
-- archive_log (audit), compaction_telemetry (per-run summary).
-- step-compaction runs in dream after step-scope-cleanup.
-- ============================================================================

DEFINE TABLE archive_memos SCHEMAFULL TYPE NORMAL;
DEFINE FIELD kind            ON archive_memos TYPE string;
DEFINE FIELD content         ON archive_memos TYPE string;
DEFINE FIELD content_hash    ON archive_memos TYPE option<string>;
DEFINE FIELD confidence      ON archive_memos TYPE float DEFAULT 0.5;
DEFINE FIELD signal_count    ON archive_memos TYPE int DEFAULT 1;
DEFINE FIELD decay_anchor    ON archive_memos TYPE datetime DEFAULT time::now();
DEFINE FIELD derived_by      ON archive_memos TYPE string;
DEFINE FIELD derived_at      ON archive_memos TYPE datetime DEFAULT time::now();
DEFINE FIELD updated_at      ON archive_memos TYPE datetime DEFAULT time::now();
DEFINE FIELD last_active     ON archive_memos TYPE datetime DEFAULT time::now();
DEFINE FIELD scope           ON archive_memos TYPE string DEFAULT 'global';
DEFINE FIELD tags            ON archive_memos TYPE array<string> DEFAULT [];
DEFINE FIELD meta            ON archive_memos TYPE option<object> FLEXIBLE;
DEFINE FIELD archived_at     ON archive_memos TYPE datetime DEFAULT time::now() READONLY;
DEFINE FIELD archive_reason  ON archive_memos TYPE string;
DEFINE INDEX archive_memos_kind         ON archive_memos FIELDS kind;
DEFINE INDEX archive_memos_archived_at  ON archive_memos FIELDS archived_at;
DEFINE INDEX archive_memos_chash        ON archive_memos FIELDS content_hash;

DEFINE TABLE archive_edges SCHEMAFULL TYPE RELATION;
-- in/out are auto-defined by TYPE RELATION as TYPE record; don't redefine.
DEFINE FIELD kind         ON archive_edges TYPE string;
DEFINE FIELD weight       ON archive_edges TYPE option<float>;
DEFINE FIELD last_seen    ON archive_edges TYPE option<datetime>;
DEFINE FIELD context      ON archive_edges TYPE option<string>;
DEFINE FIELD created_at   ON archive_edges TYPE datetime DEFAULT time::now() READONLY;
DEFINE FIELD meta         ON archive_edges TYPE option<object> FLEXIBLE;
DEFINE INDEX archive_edges_kind_in   ON archive_edges FIELDS kind, in;
DEFINE INDEX archive_edges_kind_out  ON archive_edges FIELDS kind, out;

DEFINE TABLE archive_log SCHEMAFULL TYPE NORMAL;
DEFINE FIELD memo_id  ON archive_log TYPE record;
DEFINE FIELD action   ON archive_log TYPE string;
DEFINE FIELD reason   ON archive_log TYPE string;
DEFINE FIELD ts       ON archive_log TYPE datetime DEFAULT time::now() READONLY;
DEFINE FIELD meta     ON archive_log TYPE option<object> FLEXIBLE;
DEFINE INDEX archive_log_memo_ts ON archive_log FIELDS memo_id, ts;

DEFINE TABLE compaction_telemetry SCHEMAFULL TYPE NORMAL;
DEFINE FIELD ts             ON compaction_telemetry TYPE datetime DEFAULT time::now() READONLY;
DEFINE FIELD dedup_clusters ON compaction_telemetry TYPE int DEFAULT 0;
DEFINE FIELD dedup_merged   ON compaction_telemetry TYPE int DEFAULT 0;
DEFINE FIELD archived       ON compaction_telemetry TYPE int DEFAULT 0;
DEFINE FIELD by_kind        ON compaction_telemetry TYPE object FLEXIBLE DEFAULT {};
DEFINE FIELD duration_ms    ON compaction_telemetry TYPE int DEFAULT 0;
DEFINE FIELD errors         ON compaction_telemetry TYPE array<string> DEFAULT [];
DEFINE INDEX compaction_telemetry_ts ON compaction_telemetry FIELDS ts;

UPSERT runtime:`compaction.config` SET value = {
  semantic_threshold: 0.93,
  cluster_max_size: 8,
  dedup_enabled: true,
  archive_enabled: true,
  archive_thresholds: {
    knowledge:  { age_days: 360, signal_max: 1 },
    habit:      { age_days: 120, signal_max: 1 },
    thread:     { age_days: 60 },
    prediction: { resolved_age_days: 730 }
  }
};
