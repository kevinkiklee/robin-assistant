-- Phase 2d: integrations framework + outbound policy

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

DEFINE TABLE outbound_refusals SCHEMAFULL TYPE NORMAL;
DEFINE FIELD destination ON outbound_refusals TYPE string;
DEFINE FIELD reason      ON outbound_refusals TYPE string;
DEFINE FIELD payload_hash ON outbound_refusals TYPE string;
DEFINE FIELD created_at  ON outbound_refusals TYPE datetime DEFAULT time::now() READONLY;
DEFINE INDEX outbound_refusals_created ON outbound_refusals FIELDS created_at;
