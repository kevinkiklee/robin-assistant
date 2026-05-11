-- 0002-embeddings-gemini-3072.surql — per-surface embedding tables for the
-- gemini-3072 profile.

DEFINE TABLE embeddings_gemini_3072_events SCHEMAFULL TYPE NORMAL;
DEFINE FIELD record  ON embeddings_gemini_3072_events TYPE record<events>;
DEFINE FIELD vector  ON embeddings_gemini_3072_events TYPE array<float>
  ASSERT array::len($value) = 3072;
DEFINE FIELD ts      ON embeddings_gemini_3072_events TYPE datetime DEFAULT time::now();
DEFINE INDEX embeddings_gemini_3072_events_record ON embeddings_gemini_3072_events FIELDS record UNIQUE;
DEFINE INDEX embeddings_gemini_3072_events_vec    ON embeddings_gemini_3072_events FIELDS vector
  HNSW DIMENSION 3072 DIST COSINE TYPE F32 EFC 200 M 16;

DEFINE TABLE embeddings_gemini_3072_memos SCHEMAFULL TYPE NORMAL;
DEFINE FIELD record  ON embeddings_gemini_3072_memos TYPE record<memos>;
DEFINE FIELD vector  ON embeddings_gemini_3072_memos TYPE array<float>
  ASSERT array::len($value) = 3072;
DEFINE FIELD ts      ON embeddings_gemini_3072_memos TYPE datetime DEFAULT time::now();
DEFINE INDEX embeddings_gemini_3072_memos_record ON embeddings_gemini_3072_memos FIELDS record UNIQUE;
DEFINE INDEX embeddings_gemini_3072_memos_vec    ON embeddings_gemini_3072_memos FIELDS vector
  HNSW DIMENSION 3072 DIST COSINE TYPE F32 EFC 200 M 16;

DEFINE TABLE embeddings_gemini_3072_entities SCHEMAFULL TYPE NORMAL;
DEFINE FIELD record  ON embeddings_gemini_3072_entities TYPE record<entities>;
DEFINE FIELD vector  ON embeddings_gemini_3072_entities TYPE array<float>
  ASSERT array::len($value) = 3072;
DEFINE FIELD ts      ON embeddings_gemini_3072_entities TYPE datetime DEFAULT time::now();
DEFINE INDEX embeddings_gemini_3072_entities_record ON embeddings_gemini_3072_entities FIELDS record UNIQUE;
DEFINE INDEX embeddings_gemini_3072_entities_vec    ON embeddings_gemini_3072_entities FIELDS vector
  HNSW DIMENSION 3072 DIST COSINE TYPE F32 EFC 200 M 16;

UPSERT runtime:embedder CONTENT {
  value: {
    active_profile: 'gemini-3072',
    read_profile: 'gemini-3072',
    dimension: 3072,
    available_profiles: ['gemini-3072'],
    applied_at: time::now()
  }
};
