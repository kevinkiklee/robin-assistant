-- ============================================================================
-- Drop the evidence system (was Theme 2a).
--
-- Removed:
--   * evidence_ledger table + its three indexes
--   * fn::derived_confidence (no callers remain after removing the belief MCP
--     tool and dream's step-confidence-recompute)
--   * runtime:evidence.config (consumers gone)
--
-- Retained:
--   * memos.confidence stays as a static field. It's read by inject.js's
--     recall surfacing (min_confidence_to_surface) and decay.js's scoring.
--     Memos seed it at creation with the schema default (0.5).
-- ============================================================================

REMOVE TABLE IF EXISTS evidence_ledger;
REMOVE FUNCTION IF EXISTS fn::derived_confidence;
DELETE runtime:`evidence.config`;
