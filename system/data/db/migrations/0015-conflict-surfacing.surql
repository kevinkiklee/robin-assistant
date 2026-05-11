-- ============================================================================
-- Cognition B2 — contradiction surfacing at recall
-- ============================================================================
-- Additive across THREE surfaces:
--   1. runtime:recall — extend the existing config singleton with 7 new keys
--      (without overwriting the legacy hybrid-recall keys seeded by 0001).
--   2. intuition_telemetry — 8 new option<...> fields for B2 metrics, plus a
--      DEFINE FIELD IF NOT EXISTS meta precondition piggy-backed from A3.
--   3. recall_log.meta — no DDL needed; meta is already option<object> FLEXIBLE
--      per 0001-init.surql:302. Documented here for discoverability.
-- ============================================================================

-- Extend runtime:recall. The original 0001-init seed uses CONTENT which would
-- wipe legacy keys; we use field-level SET so rrf_k / knn_overfetch_* /
-- mmr_threshold are preserved. value is object FLEXIBLE (0001-init:217) so
-- dotted-path SET is supported. UPSERT (not UPDATE) is defensive: if 0001
-- didn't run, the row gets created with these keys and getRecallConfig will
-- fall back to HYBRID_DEFAULTS for the missing legacy keys.
UPSERT runtime:recall SET
  value.conflict_surfacing_enabled   = false,
  value.conflict_min_confidence      = 0.4,
  value.conflict_max_age_days        = 30,
  value.conflict_max_pairs_surfaced  = 3,
  value.conflict_max_pairs_hydrated  = 24,
  value.conflict_block_token_budget  = 300,
  value.relevant_memory_token_budget = 1500;

-- intuition_telemetry is SCHEMAFULL TYPE NORMAL (0001-init:279). New keys
-- must be explicitly DEFINE'd. All option<...> so flag-off rows (which never
-- write these keys) remain schema-valid.
--
-- Precondition for A3 cross-spec coordination: A3 owns adding
-- `DEFINE FIELD meta ON intuition_telemetry`. If A3 has not landed first,
-- B2 must include it so any future B2 write to meta.* lands on a valid
-- schema. IF NOT EXISTS makes the duplication safe in either order.
DEFINE FIELD IF NOT EXISTS meta ON intuition_telemetry TYPE option<object> FLEXIBLE;

DEFINE FIELD conflicts_surfaced            ON intuition_telemetry TYPE option<int>;
DEFINE FIELD conflicts_block_tokens        ON intuition_telemetry TYPE option<int>;
DEFINE FIELD conflicts_hydrated_precap     ON intuition_telemetry TYPE option<int>;
DEFINE FIELD conflicts_hydrated_postcap    ON intuition_telemetry TYPE option<int>;
DEFINE FIELD conflicts_hydration_capped    ON intuition_telemetry TYPE option<bool>;
DEFINE FIELD conflicts_suppressed_by_rule  ON intuition_telemetry TYPE option<object> FLEXIBLE;
DEFINE FIELD conflicts_redacted_one_side   ON intuition_telemetry TYPE option<int>;
DEFINE FIELD conflicts_block_truncated     ON intuition_telemetry TYPE option<bool>;

-- recall_log.meta is already option<object> FLEXIBLE (0001-init:302). No DDL
-- needed for meta.conflicts_surfaced — the FLEXIBLE container accepts it.
