-- Phase 2b: reflection feedback table (recall events)

DEFINE TABLE recall_events SCHEMAFULL TYPE NORMAL;
DEFINE FIELD query_text     ON recall_events TYPE string;
DEFINE FIELD query_vec      ON recall_events TYPE array<float>
  ASSERT array::len($value) = 384;
DEFINE FIELD hit_ids        ON recall_events TYPE array<record<events>>;
DEFINE FIELD hit_dists      ON recall_events TYPE array<float>;
DEFINE FIELD hit_used       ON recall_events TYPE array<bool>;
DEFINE FIELD session_id     ON recall_events TYPE option<string>;
DEFINE FIELD ts             ON recall_events TYPE datetime DEFAULT time::now() READONLY;
DEFINE FIELD meta           ON recall_events TYPE option<object> FLEXIBLE;
DEFINE INDEX recall_events_ts ON recall_events FIELDS ts;
DEFINE INDEX recall_events_session ON recall_events FIELDS session_id, ts;
