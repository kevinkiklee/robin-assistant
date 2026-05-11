-- ============================================================================
-- C2: Dream DAG + parallelism. Seed runtime:`dream.config` with parallelism
-- disabled by default. The dreamProcess wrapper reads this row on every call
-- via dream-budget.readDreamConfig(); when value.parallelism_enabled is false
-- (the default), the pipeline takes the verbatim-serial branch — no behaviour
-- change relative to alpha.17.
--
-- The grouping record id  runtime:`dream.config`  is distinct from
-- runtime:dream (the per-run ledger written by dreamProcess on every run).
-- Two rows, two semantics. See spec §7 "Two `runtime` rows, two semantics".
--
-- runtime:dream.value MAY also carry, on top of existing keys:
--   last_layers : [{ names: [string], duration_ms: int }]    -- per-run layer ledger
--   last_halted : option<string>                              -- 'budget_exhausted' | 'scheduler_error' | NONE
-- These are additive; runtime.value is FLEXIBLE so no DEFINE FIELD edit is
-- required.
-- ============================================================================

UPSERT runtime:`dream.config` SET value = {
  parallelism_enabled: false,
  max_concurrent: NONE,
  budget_check_enabled: true,
  budget_floor: NONE
}
WHERE value IS NONE;

-- Idempotent fill-in for installs whose runtime:`dream.config` row already
-- exists with partial keys. Each UPDATE is a no-op once its key is present.
UPDATE runtime:`dream.config`
   SET value.parallelism_enabled = false
 WHERE value.parallelism_enabled IS NONE;

UPDATE runtime:`dream.config`
   SET value.max_concurrent = NONE
 WHERE value.max_concurrent IS NONE;

UPDATE runtime:`dream.config`
   SET value.budget_check_enabled = true
 WHERE value.budget_check_enabled IS NONE;

UPDATE runtime:`dream.config`
   SET value.budget_floor = NONE
 WHERE value.budget_floor IS NONE;
