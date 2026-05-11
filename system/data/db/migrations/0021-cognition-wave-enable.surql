-- Cognition wave default-on flip. Enables every feature whose initial
-- seed shipped in 'off' / 'shadow' / 'false'. Idempotent: each UPSERT
-- writes a field path, no row replacement.
--
-- Already-on flags (no statements here, documented for audit):
--   A1: runtime:recall.value.mmr_use_cosine                (default true via 0010)
--   A2: runtime:recall.value.entity_boost_enabled          (default true via 0010)
--   C1: runtime:biographer.value.batch_config.disable      (default false via 0011)
--   D1: runtime:`state_inference.config`.value.enabled     (true via 0014)
--
-- Operator can revert any individual flag without a new migration:
--   UPDATE runtime:`<key>` SET value.<field> = <old_value>;
-- The 5-second config cache picks up the flip on the next call.

-- B1: per-hit reinforcement — switch from 'off' (counts nothing) to
-- 'hybrid' (explicit → citation → similarity → fallback chain).
UPSERT runtime:`reinforcement.config` SET value.attribution_mode = 'hybrid';

-- B2: contradiction surfacing — emit the <!-- conflicts --> block when
-- live `contradicts` edges intersect the in-view memo hits.
UPSERT runtime:recall SET value.conflict_surfacing_enabled = true;

-- C2: dream DAG parallelism — run independent steps concurrently within
-- each layer of DREAM_DAG_DEPS. Budget enforcement stays on.
UPSERT runtime:`dream.config` SET value.parallelism_enabled = true;

-- C3: telemetry umbrella — flip `show_telemetry_rollup` MCP tool from
-- shadow mode (returns explanatory error) to live reads. The aggregator
-- job has been writing telemetry_hourly all along.
UPSERT runtime:`telemetry.config` SET value.shadow_mode = false;

-- D2: recall-failures meta-cognition — flip from 'false' (job exits at
-- first guard) to true (full path: cluster + LLM + memo + rule_candidates).
UPSERT runtime:`meta_cognition.config` SET value.enabled = true;

-- D3: belief() gating — flip from shadow (recommendation forced
-- 'unknown', shadow_recommendation logged) to live (recommendation
-- reflects calibrated_confidence).
UPSERT runtime:`belief.config` SET value.shadow_mode = false;
