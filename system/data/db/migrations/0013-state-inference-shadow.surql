-- Cognition D1-shadow-flip: state_inference flag from false → 'shadow'.
-- After this migration, the faculty runs end-to-end (including LLM calls)
-- but does not write memos; telemetry rows are still emitted. The intuition
-- path continues to suppress the focus block until enabled === true.

UPSERT runtime:`state_inference.config` SET value.enabled = 'shadow';
