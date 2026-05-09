-- Phase 2c: dream + memory shapes + heuristic loop

-- Extend events
DEFINE FIELD dreamed_at ON events TYPE option<datetime>;
DEFINE INDEX events_dreamed ON events FIELDS dreamed_at;

-- knowledge
DEFINE TABLE knowledge SCHEMAFULL TYPE NORMAL;
DEFINE FIELD content         ON knowledge TYPE string ASSERT string::len($value) > 0;
DEFINE FIELD content_hash    ON knowledge TYPE string;
DEFINE FIELD subject_id      ON knowledge TYPE option<record<entities>>;
DEFINE FIELD confidence      ON knowledge TYPE float ASSERT $value >= 0 AND $value <= 1;
DEFINE FIELD source_events   ON knowledge TYPE array<record<events>>;
DEFINE FIELD source_episodes ON knowledge TYPE array<record<episodes>>;
DEFINE FIELD created_at      ON knowledge TYPE datetime DEFAULT time::now() READONLY;
DEFINE FIELD updated_at      ON knowledge TYPE datetime VALUE time::now();
DEFINE FIELD embedding       ON knowledge TYPE array<float> ASSERT array::len($value) = 384;
DEFINE FIELD meta            ON knowledge TYPE option<object> FLEXIBLE;
DEFINE INDEX knowledge_subject ON knowledge FIELDS subject_id;
DEFINE INDEX knowledge_chash   ON knowledge FIELDS content_hash;
DEFINE INDEX knowledge_vec     ON knowledge FIELDS embedding HNSW DIMENSION 384 DIST COSINE TYPE F32 EFC 200 M 16;

-- patterns
DEFINE TABLE patterns SCHEMAFULL TYPE NORMAL;
DEFINE FIELD name          ON patterns TYPE string ASSERT string::len($value) > 0;
DEFINE FIELD description   ON patterns TYPE string;
DEFINE FIELD signal_count  ON patterns TYPE int DEFAULT 1;
DEFINE FIELD last_signal   ON patterns TYPE datetime DEFAULT time::now();
DEFINE FIELD strength      ON patterns TYPE float DEFAULT 1.0;
DEFINE FIELD source_events ON patterns TYPE array<record<events>>;
DEFINE FIELD created_at    ON patterns TYPE datetime DEFAULT time::now() READONLY;
DEFINE FIELD meta          ON patterns TYPE option<object> FLEXIBLE;
DEFINE INDEX patterns_name ON patterns FIELDS name;

-- profile
DEFINE TABLE profile SCHEMAFULL TYPE NORMAL;
DEFINE FIELD name         ON profile TYPE option<string>;
DEFINE FIELD display_name ON profile TYPE option<string>;
DEFINE FIELD pronouns     ON profile TYPE option<string>;
DEFINE FIELD timezone     ON profile TYPE option<string>;
DEFINE FIELD interests    ON profile TYPE option<array<string>>;
DEFINE FIELD updated_at   ON profile TYPE datetime VALUE time::now();
DEFINE FIELD meta         ON profile TYPE option<object> FLEXIBLE;

-- threads
DEFINE TABLE threads SCHEMAFULL TYPE NORMAL;
DEFINE FIELD title       ON threads TYPE option<string>;
DEFINE FIELD started_at  ON threads TYPE datetime DEFAULT time::now() READONLY;
DEFINE FIELD last_active ON threads TYPE datetime DEFAULT time::now();
DEFINE FIELD episode_ids ON threads TYPE array<record<episodes>>;
DEFINE FIELD entity_ids  ON threads TYPE array<record<entities>>;
DEFINE FIELD summary     ON threads TYPE option<string>;
DEFINE FIELD meta        ON threads TYPE option<object> FLEXIBLE;
DEFINE INDEX threads_last_active ON threads FIELDS last_active;

-- rule_candidates
DEFINE TABLE rule_candidates SCHEMAFULL TYPE NORMAL;
DEFINE FIELD content          ON rule_candidates TYPE string;
DEFINE FIELD kind             ON rule_candidates TYPE string
  ASSERT $value IN ['behavior', 'profile_update', 'conflict_warning'];
DEFINE FIELD signal_events    ON rule_candidates TYPE array<record<events>>;
DEFINE FIELD payload          ON rule_candidates TYPE option<object> FLEXIBLE;
DEFINE FIELD confidence       ON rule_candidates TYPE float ASSERT $value >= 0 AND $value <= 1;
DEFINE FIELD status           ON rule_candidates TYPE string
  ASSERT $value IN ['pending', 'approved', 'rejected', 'expired'];
DEFINE FIELD created_at       ON rule_candidates TYPE datetime DEFAULT time::now() READONLY;
DEFINE FIELD reviewed_at      ON rule_candidates TYPE option<datetime>;
DEFINE FIELD rejected_reason  ON rule_candidates TYPE option<string>;
DEFINE INDEX rule_candidates_status  ON rule_candidates FIELDS status;
DEFINE INDEX rule_candidates_created ON rule_candidates FIELDS created_at;

-- rules
DEFINE TABLE rules SCHEMAFULL TYPE NORMAL;
DEFINE FIELD content          ON rules TYPE string;
DEFINE FIELD kind             ON rules TYPE string
  ASSERT $value IN ['behavior', 'profile_update'];
DEFINE FIELD payload          ON rules TYPE option<object> FLEXIBLE;
DEFINE FIELD source_candidate ON rules TYPE option<record<rule_candidates>>;
DEFINE FIELD priority         ON rules TYPE int DEFAULT 50;
DEFINE FIELD active           ON rules TYPE bool DEFAULT true;
DEFINE FIELD created_at       ON rules TYPE datetime DEFAULT time::now() READONLY;
DEFINE FIELD updated_at       ON rules TYPE datetime VALUE time::now();
DEFINE FIELD meta             ON rules TYPE option<object> FLEXIBLE;
DEFINE INDEX rules_active     ON rules FIELDS active, priority;
