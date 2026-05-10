-- Phase 3b: v1 → v2 migrator support — dedup indexes + edge meta + embed_backfill marker.

-- Source-hash indexes for dedup queries on migrated rows
DEFINE FIELD meta.from_v1.source_hash ON events       TYPE option<string>;
DEFINE FIELD meta.from_v1.source_hash ON entities     TYPE option<string>;
DEFINE FIELD meta.from_v1.source_hash ON episodes     TYPE option<string>;
DEFINE INDEX events_from_v1_hash    ON events    FIELDS meta.from_v1.source_hash;
DEFINE INDEX entities_from_v1_hash  ON entities  FIELDS meta.from_v1.source_hash;
DEFINE INDEX episodes_from_v1_hash  ON episodes  FIELDS meta.from_v1.source_hash;

-- participates_in needs a meta field to preserve dropped v1 fields (confidence,
-- archived_at, valid_from/until). v1 mentions does NOT migrate as an edge —
-- it lands as lossy events — so mentions.meta is not added.
DEFINE FIELD meta ON participates_in TYPE option<object> FLEXIBLE;

-- Embed-backfill marker. No index — full scan over the small migrated row set
-- is fine and partial indexes aren't supported in SurrealDB v3.
DEFINE FIELD embedded_at ON events TYPE option<datetime>;
DEFINE FIELD meta.embed_failed ON events TYPE option<bool>;
