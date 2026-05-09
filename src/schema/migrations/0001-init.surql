DEFINE DATABASE IF NOT EXISTS main STRICT;

DEFINE TABLE _migrations SCHEMAFULL TYPE NORMAL;
DEFINE FIELD version    ON _migrations TYPE int;
DEFINE FIELD name       ON _migrations TYPE string;
DEFINE FIELD checksum   ON _migrations TYPE string;
DEFINE FIELD applied_at ON _migrations TYPE datetime DEFAULT time::now() READONLY;
DEFINE INDEX _migrations_version ON _migrations FIELDS version UNIQUE;

DEFINE TABLE events SCHEMAFULL TYPE NORMAL;
DEFINE FIELD source       ON events TYPE string
  ASSERT $value IN ['cli', 'stop_hook', 'manual', 'sync', 'biographer', 'ingest', 'discord', 'migration'];
DEFINE FIELD content      ON events TYPE string ASSERT string::len($value) > 0;
DEFINE FIELD content_hash ON events TYPE string;
DEFINE FIELD ts           ON events TYPE datetime DEFAULT time::now() READONLY;
DEFINE FIELD meta         ON events TYPE option<object> FLEXIBLE;
DEFINE FIELD embedding    ON events TYPE array<float>
  ASSERT array::len($value) = 768;
DEFINE INDEX events_ts     ON events FIELDS ts;
DEFINE INDEX events_source ON events FIELDS source;
DEFINE INDEX events_chash  ON events FIELDS content_hash;
DEFINE INDEX events_vec    ON events FIELDS embedding
  HNSW DIMENSION 768 DIST COSINE TYPE F32 EFC 200 M 16;

DEFINE TABLE runtime SCHEMAFULL TYPE NORMAL;
DEFINE FIELD value      ON runtime TYPE object FLEXIBLE;
DEFINE FIELD updated_at ON runtime TYPE datetime VALUE time::now();
