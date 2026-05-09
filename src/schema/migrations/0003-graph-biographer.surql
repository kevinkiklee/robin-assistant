-- Phase 2a: graph + biographer schema

-- Extend events
DEFINE FIELD biographed_at ON events TYPE option<datetime>;
DEFINE FIELD episode_id    ON events TYPE option<record<episodes>>;
DEFINE INDEX events_biographed ON events FIELDS biographed_at;
DEFINE INDEX events_episode    ON events FIELDS episode_id;

-- Episodes table
DEFINE TABLE episodes SCHEMAFULL TYPE NORMAL;
DEFINE FIELD started_at  ON episodes TYPE datetime DEFAULT time::now() READONLY;
DEFINE FIELD ended_at    ON episodes TYPE option<datetime>;
DEFINE FIELD source      ON episodes TYPE string;
DEFINE FIELD summary     ON episodes TYPE option<string>;
DEFINE FIELD meta        ON episodes TYPE option<object> FLEXIBLE;
DEFINE INDEX episodes_started ON episodes FIELDS started_at;
DEFINE INDEX episodes_source  ON episodes FIELDS source;
DEFINE INDEX episodes_active  ON episodes FIELDS source, ended_at;

-- Entities table (HNSW dim 384 to match the pinned events embedder)
DEFINE TABLE entities SCHEMAFULL TYPE NORMAL;
DEFINE FIELD name        ON entities TYPE string ASSERT string::len($value) > 0;
DEFINE FIELD name_lower  ON entities TYPE string VALUE string::lowercase(name) READONLY;
DEFINE FIELD type        ON entities TYPE string
  ASSERT $value IN ['person', 'place', 'project', 'topic', 'thing'];
DEFINE FIELD embedding   ON entities TYPE array<float>
  ASSERT array::len($value) = 384;
DEFINE FIELD created_at  ON entities TYPE datetime DEFAULT time::now() READONLY;
DEFINE FIELD meta        ON entities TYPE option<object> FLEXIBLE;
DEFINE INDEX entities_name_lower ON entities FIELDS name_lower, type;
DEFINE INDEX entities_vec        ON entities FIELDS embedding
  HNSW DIMENSION 384 DIST COSINE TYPE F32 EFC 200 M 16;

-- Edge tables (TYPE RELATION ENFORCED prevents dangling edges)
DEFINE TABLE mentions       SCHEMAFULL TYPE RELATION FROM events TO entities   ENFORCED;
DEFINE FIELD weight  ON mentions TYPE option<float>;
DEFINE FIELD context ON mentions TYPE option<string>;

DEFINE TABLE about          SCHEMAFULL TYPE RELATION FROM events TO entities   ENFORCED;

DEFINE TABLE precedes       SCHEMAFULL TYPE RELATION FROM events TO events     ENFORCED;

DEFINE TABLE works_on        SCHEMAFULL TYPE RELATION FROM entities TO entities ENFORCED;
DEFINE TABLE participates_in SCHEMAFULL TYPE RELATION FROM entities TO entities ENFORCED;

DEFINE TABLE co_occurs_with SCHEMAFULL TYPE RELATION FROM entities TO entities ENFORCED;
DEFINE FIELD strength  ON co_occurs_with TYPE float DEFAULT 1.0;
DEFINE FIELD last_seen ON co_occurs_with TYPE datetime DEFAULT time::now();
