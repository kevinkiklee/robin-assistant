-- Phase 2d: integrations framework + outbound discretion

DEFINE FIELD external_id ON events TYPE option<string>;
DEFINE INDEX events_source_external ON events FIELDS source, external_id UNIQUE;

DEFINE FIELD trust ON events TYPE string DEFAULT 'trusted'
  ASSERT $value IN ['trusted', 'untrusted', 'untrusted-mixed'];

REMOVE INDEX events_vec ON events;
REMOVE FIELD embedding ON events;
DEFINE FIELD embedding ON events TYPE option<array<float>>
  ASSERT $value IS NONE OR array::len($value) = 384;
DEFINE INDEX events_vec ON events FIELDS embedding
  HNSW DIMENSION 384 DIST COSINE TYPE F32 EFC 200 M 16;

DEFINE TABLE refusals SCHEMAFULL TYPE NORMAL;
DEFINE FIELD destination ON refusals TYPE string;
DEFINE FIELD reason      ON refusals TYPE string;
DEFINE FIELD payload_hash ON refusals TYPE string;
DEFINE FIELD created_at  ON refusals TYPE datetime DEFAULT time::now() READONLY;
DEFINE INDEX refusals_created ON refusals FIELDS created_at;
