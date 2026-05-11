-- ============================================================================
-- C1: Biographer event batching. Merge default batch_config keys onto the
-- existing runtime:biographer row without overwriting operator-set values.
-- The pipeline.js `ensureRuntime` early-returns when `config` is already set,
-- so installs with existing runtime rows would otherwise never pick up
-- batch_config. This migration adds the defaults idempotently.
-- ============================================================================

-- 1. Seed an empty runtime:biographer row if none exists. The pipeline's
--    ensureRuntime would do this on first call, but pre-seeding lets the
--    merge below run unconditionally and lets fresh installs boot the daemon
--    with batch defaults already present.
UPSERT type::record('runtime', 'biographer')
  SET value = {
    config: {
      stage2_high_threshold: 0.92,
      stage2_low_threshold:  0.8,
      episode_window_minutes: 30,
      catalog_size: 100,
      cooccur_cap: 8
    },
    entity_catalog_version: 0,
    batch_config: {
      max_batch_size: 8,
      debounce_ms: 750,
      max_wait_ms: 3000,
      disable: false
    }
  }
  WHERE value IS NONE;

-- 2. Merge batch_config defaults into existing rows. SET nested fields
--    individually so operator-set values are preserved. The IS NONE guard
--    on each leaf field means re-running this migration is a no-op once
--    keys are present.
UPDATE type::record('runtime', 'biographer')
   SET value.batch_config.max_batch_size = 8
 WHERE value.batch_config.max_batch_size IS NONE;

UPDATE type::record('runtime', 'biographer')
   SET value.batch_config.debounce_ms = 750
 WHERE value.batch_config.debounce_ms IS NONE;

UPDATE type::record('runtime', 'biographer')
   SET value.batch_config.max_wait_ms = 3000
 WHERE value.batch_config.max_wait_ms IS NONE;

UPDATE type::record('runtime', 'biographer')
   SET value.batch_config.disable = false
 WHERE value.batch_config.disable IS NONE;
