-- 0026-telemetry-add-faculties.surql
--
-- Add `biographer` and `state_inference` to the telemetry rollup's
-- faculties_enabled set, and seed cursor rows for their raw-table entries
-- so the next telemetry-rollup tick projects them into telemetry_hourly.
--
-- Background: faculties_enabled was seeded by 0017 with the original five
-- (intuition, reinforcement, belief, dream, meta_cognition). The biographer
-- and state-inference faculties write per-call telemetry into their own raw
-- tables but lacked rollup-registry entries (added in the same commit). With
-- both halves in place, the aggregator picks them up automatically on its
-- next tick — no migration-driven backfill required; older raw rows past the
-- 7-day retention horizon stay unrolled by design.

UPSERT runtime:`telemetry.config` SET value = {
  enabled: enabled ?? true,
  shadow_mode: shadow_mode ?? false,
  raw_retention_days: raw_retention_days ?? 7,
  hourly_retention_days: hourly_retention_days ?? 90,
  daily_retention_days: daily_retention_days ?? 365,
  cutoff_safety_seconds: cutoff_safety_seconds ?? 60,
  cursor_fallback_window_hours: cursor_fallback_window_hours ?? 24,
  faculties_enabled: array::distinct(array::concat(
    faculties_enabled ?? ['intuition', 'reinforcement', 'belief', 'dream', 'meta_cognition'],
    ['biographer', 'state_inference', 'dream_layer']
  )),
  cadence_hot_steps: cadence_hot_steps ?? ['belief.', 'dream.'],
  pending_recall_log_hard_ceiling_days: pending_recall_log_hard_ceiling_days ?? 30
};
