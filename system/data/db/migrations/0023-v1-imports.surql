-- 0022-v1-imports.surql — ledger for the v1 → v2 markdown migrator.
-- Spec: docs/superpowers/specs/2026-05-11-v1-to-v2-data-migrator-design.md.
--
-- Every row written by `robin import-v1` is paired (in a single transaction)
-- with one row here. The unique content_hash index makes re-runs O(1) skips;
-- the import_session index makes session-scoped rollback fast.

DEFINE TABLE _v1_imports SCHEMAFULL TYPE NORMAL;
DEFINE FIELD source_path    ON _v1_imports TYPE string;
DEFINE FIELD content_hash   ON _v1_imports TYPE string;
DEFINE FIELD target         ON _v1_imports TYPE string;
DEFINE FIELD kind           ON _v1_imports TYPE string
  ASSERT $value IN ['memo', 'entity', 'edge', 'event', 'rule', 'refusal', 'persona_field', 'source_file'];
DEFINE FIELD import_session ON _v1_imports TYPE string;
DEFINE FIELD imported_at    ON _v1_imports TYPE datetime DEFAULT time::now() READONLY;
DEFINE INDEX _v1_imports_hash    ON _v1_imports FIELDS content_hash UNIQUE;
DEFINE INDEX _v1_imports_path    ON _v1_imports FIELDS source_path;
DEFINE INDEX _v1_imports_session ON _v1_imports FIELDS import_session;
