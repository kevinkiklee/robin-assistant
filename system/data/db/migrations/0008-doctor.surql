-- ============================================================================
-- Theme 4: observability + introspection. Config row only — read layer is code.
-- ============================================================================

UPSERT runtime:`doctor.config` SET value = {
  budget_warn_pct: 0.85,
  budget_fail_pct: 0.98,
  pending_triggers_warn: 50,
  faculty_error_rate_warn: 0.01,
  faculty_error_rate_fail: 0.05,
  stale_dream_warn_hours: 30
};
