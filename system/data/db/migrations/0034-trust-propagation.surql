-- 0034-trust-propagation.surql
-- Adds derived_from_trust to all tables biographer/dream populate.
-- Default 'trusted' preserves existing-row behavior; backfill is a
-- separate manual script (system/scripts/backfill-derived-trust.js).

DEFINE FIELD derived_from_trust ON entities TYPE string DEFAULT 'trusted';
DEFINE FIELD derived_from_trust ON memos    TYPE string DEFAULT 'trusted';
DEFINE FIELD derived_from_trust ON edges    TYPE string DEFAULT 'trusted';
DEFINE FIELD derived_from_trust ON episodes TYPE string DEFAULT 'trusted';
DEFINE FIELD derived_from_trust ON arcs     TYPE string DEFAULT 'trusted';

DEFINE INDEX entities_derived_from_trust ON entities FIELDS derived_from_trust;
DEFINE INDEX memos_derived_from_trust    ON memos    FIELDS derived_from_trust;
DEFINE INDEX edges_derived_from_trust    ON edges    FIELDS derived_from_trust;
DEFINE INDEX episodes_derived_from_trust ON episodes FIELDS derived_from_trust;
DEFINE INDEX arcs_derived_from_trust     ON arcs     FIELDS derived_from_trust;
