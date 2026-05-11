-- Cognition D1-default-on: state_inference flag from 'shadow' → true.
-- After this migration, the focus block surfaces in the intuition path.
-- Operators can disable per-host via:
--   UPDATE runtime:`state_inference.config` SET value.enabled = false;
-- No restart required (5-second cfg cache).

UPSERT runtime:`state_inference.config` SET value.enabled = true;
