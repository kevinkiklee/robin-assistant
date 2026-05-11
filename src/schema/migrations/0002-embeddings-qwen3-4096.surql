-- 0002-embeddings-qwen3-4096.surql — per-surface embedding tables for the
-- qwen3-4096 profile.

DEFINE TABLE embeddings_qwen3_4096_events SCHEMAFULL TYPE NORMAL;
DEFINE FIELD record  ON embeddings_qwen3_4096_events TYPE record<events>;
DEFINE FIELD vector  ON embeddings_qwen3_4096_events TYPE array<float>
  ASSERT array::len($value) = 4096;
DEFINE FIELD ts      ON embeddings_qwen3_4096_events TYPE datetime DEFAULT time::now();
DEFINE INDEX embeddings_qwen3_4096_events_record ON embeddings_qwen3_4096_events FIELDS record UNIQUE;
DEFINE INDEX embeddings_qwen3_4096_events_vec    ON embeddings_qwen3_4096_events FIELDS vector
  HNSW DIMENSION 4096 DIST COSINE TYPE F32 EFC 200 M 16;

DEFINE TABLE embeddings_qwen3_4096_memos SCHEMAFULL TYPE NORMAL;
DEFINE FIELD record  ON embeddings_qwen3_4096_memos TYPE record<memos>;
DEFINE FIELD vector  ON embeddings_qwen3_4096_memos TYPE array<float>
  ASSERT array::len($value) = 4096;
DEFINE FIELD ts      ON embeddings_qwen3_4096_memos TYPE datetime DEFAULT time::now();
DEFINE INDEX embeddings_qwen3_4096_memos_record ON embeddings_qwen3_4096_memos FIELDS record UNIQUE;
DEFINE INDEX embeddings_qwen3_4096_memos_vec    ON embeddings_qwen3_4096_memos FIELDS vector
  HNSW DIMENSION 4096 DIST COSINE TYPE F32 EFC 200 M 16;

DEFINE TABLE embeddings_qwen3_4096_entities SCHEMAFULL TYPE NORMAL;
DEFINE FIELD record  ON embeddings_qwen3_4096_entities TYPE record<entities>;
DEFINE FIELD vector  ON embeddings_qwen3_4096_entities TYPE array<float>
  ASSERT array::len($value) = 4096;
DEFINE FIELD ts      ON embeddings_qwen3_4096_entities TYPE datetime DEFAULT time::now();
DEFINE INDEX embeddings_qwen3_4096_entities_record ON embeddings_qwen3_4096_entities FIELDS record UNIQUE;
DEFINE INDEX embeddings_qwen3_4096_entities_vec    ON embeddings_qwen3_4096_entities FIELDS vector
  HNSW DIMENSION 4096 DIST COSINE TYPE F32 EFC 200 M 16;

UPSERT runtime:embedder CONTENT {
  value: {
    active_profile: 'qwen3-4096',
    read_profile: 'qwen3-4096',
    dimension: 4096,
    available_profiles: ['qwen3-4096'],
    applied_at: time::now()
  }
};
