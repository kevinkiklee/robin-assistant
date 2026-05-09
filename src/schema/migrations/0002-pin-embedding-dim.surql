REMOVE INDEX events_vec ON events;
REMOVE FIELD embedding ON events;
DEFINE FIELD embedding ON events TYPE array<float>
  ASSERT array::len($value) = 384;
DEFINE INDEX events_vec ON events FIELDS embedding
  HNSW DIMENSION 384 DIST COSINE TYPE F32 EFC 200 M 16;
