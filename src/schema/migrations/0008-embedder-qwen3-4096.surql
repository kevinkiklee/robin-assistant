-- Phase 3a: pluggable embedder profile — qwen3-4096 (qwen3-embedding:8b via Ollama, 4096-dim)
-- Supersedes Phase 1's 0002 (DIMENSION 384). Migration runner picks the 0008 file
-- matching the active embedder profile in user-data/config.json.

-- events: embedding stays option<array<float>> per 0006 (allows null for embed-skip integrations).
REMOVE INDEX events_vec ON events;
REMOVE FIELD embedding ON events;
DEFINE FIELD embedding ON events TYPE option<array<float>>
  ASSERT $value IS NONE OR array::len($value) = 4096;
DEFINE INDEX events_vec ON events FIELDS embedding
  HNSW DIMENSION 4096 DIST COSINE TYPE F32 EFC 200 M 16;

-- knowledge: embedding stays array<float> non-option per 0005.
REMOVE INDEX knowledge_vec ON knowledge;
REMOVE FIELD embedding ON knowledge;
DEFINE FIELD embedding ON knowledge TYPE array<float>
  ASSERT array::len($value) = 4096;
DEFINE INDEX knowledge_vec ON knowledge FIELDS embedding
  HNSW DIMENSION 4096 DIST COSINE TYPE F32 EFC 200 M 16;

-- entities: embedding stays array<float> non-option per 0003.
REMOVE INDEX entities_vec ON entities;
REMOVE FIELD embedding ON entities;
DEFINE FIELD embedding ON entities TYPE array<float>
  ASSERT array::len($value) = 4096;
DEFINE INDEX entities_vec ON entities FIELDS embedding
  HNSW DIMENSION 4096 DIST COSINE TYPE F32 EFC 200 M 16;

-- recall_events.query_vec: feedback-loop query embeddings (0004).
REMOVE FIELD query_vec ON recall_events;
DEFINE FIELD query_vec ON recall_events TYPE array<float>
  ASSERT array::len($value) = 4096;

-- runtime:embedder row — used by daemon-boot drift detection (Task 7).
UPSERT type::record('runtime', 'embedder') CONTENT {
  value: {
    profile: 'qwen3-4096',
    dimension: 4096,
    model_id: 'qwen3-embedding:8b',
    applied_at: time::now()
  }
};
