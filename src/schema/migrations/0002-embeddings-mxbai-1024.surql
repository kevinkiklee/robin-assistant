-- 0002-embeddings-mxbai-1024.surql — per-surface embedding tables for the
-- mxbai-1024 profile. Three tables (events, memos, entities), each with a
-- 1024-dim HNSW index. The migration runner applies this file only when the
-- active profile (runtime config) is mxbai-1024.

DEFINE TABLE embeddings_mxbai_1024_events SCHEMAFULL TYPE NORMAL;
DEFINE FIELD record  ON embeddings_mxbai_1024_events TYPE record<events>;
DEFINE FIELD vector  ON embeddings_mxbai_1024_events TYPE array<float>
  ASSERT array::len($value) = 1024;
DEFINE FIELD ts      ON embeddings_mxbai_1024_events TYPE datetime DEFAULT time::now();
DEFINE INDEX embeddings_mxbai_1024_events_record ON embeddings_mxbai_1024_events FIELDS record UNIQUE;
DEFINE INDEX embeddings_mxbai_1024_events_vec    ON embeddings_mxbai_1024_events FIELDS vector
  HNSW DIMENSION 1024 DIST COSINE TYPE F32 EFC 200 M 16;

DEFINE TABLE embeddings_mxbai_1024_memos SCHEMAFULL TYPE NORMAL;
DEFINE FIELD record  ON embeddings_mxbai_1024_memos TYPE record<memos>;
DEFINE FIELD vector  ON embeddings_mxbai_1024_memos TYPE array<float>
  ASSERT array::len($value) = 1024;
DEFINE FIELD ts      ON embeddings_mxbai_1024_memos TYPE datetime DEFAULT time::now();
DEFINE INDEX embeddings_mxbai_1024_memos_record ON embeddings_mxbai_1024_memos FIELDS record UNIQUE;
DEFINE INDEX embeddings_mxbai_1024_memos_vec    ON embeddings_mxbai_1024_memos FIELDS vector
  HNSW DIMENSION 1024 DIST COSINE TYPE F32 EFC 200 M 16;

DEFINE TABLE embeddings_mxbai_1024_entities SCHEMAFULL TYPE NORMAL;
DEFINE FIELD record  ON embeddings_mxbai_1024_entities TYPE record<entities>;
DEFINE FIELD vector  ON embeddings_mxbai_1024_entities TYPE array<float>
  ASSERT array::len($value) = 1024;
DEFINE FIELD ts      ON embeddings_mxbai_1024_entities TYPE datetime DEFAULT time::now();
DEFINE INDEX embeddings_mxbai_1024_entities_record ON embeddings_mxbai_1024_entities FIELDS record UNIQUE;
DEFINE INDEX embeddings_mxbai_1024_entities_vec    ON embeddings_mxbai_1024_entities FIELDS vector
  HNSW DIMENSION 1024 DIST COSINE TYPE F32 EFC 200 M 16;

-- Record the active embedder profile for daemon-boot drift detection.
UPSERT runtime:embedder CONTENT {
  value: {
    active_profile: 'mxbai-1024',
    read_profile: 'mxbai-1024',
    dimension: 1024,
    available_profiles: ['mxbai-1024'],
    applied_at: time::now()
  }
};
