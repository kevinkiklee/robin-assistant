// config.js — 5s in-process cache of runtime:`belief.config`.

const TTL_MS = 5_000;
let cache = null;
let cachedAt = 0;

const DEFAULTS = Object.freeze({
  default_threshold: 0.6,
  soften_floor: 0.4,
  domain_thresholds: {},
  relevance_threshold: 0.3,
  confidence_floor: 0.05,
  belief_overfetch_factor: 2.0,
  min_calibration_samples: 5,
  calibration_adjustment_gain: 1.0,
  expected_accuracy_baseline: 0.75,
  domain_entity_types: ['topic', 'project', 'library'],
  shadow_mode: true,
  telemetry_enabled: true,
  telemetry_sample_rate: 1.0,
  meta_narrative_enabled: true,
  meta_narrative_min_samples: 5,
  meta_narrative_drift_threshold: 0.15,
  meta_narrative_window_days: 7,
  meta_narrative_rule_threshold: 0.15,
  meta_narrative_rule_min_weeks: 2,
});

export async function readBeliefConfig(db) {
  const now = Date.now();
  if (cache && now - cachedAt < TTL_MS) return cache;
  let value = null;
  try {
    const [rows] = await db.query('SELECT VALUE value FROM runtime:`belief.config`').collect();
    value = rows?.[0] ?? null;
  } catch {
    // fall through to defaults
  }
  cache = { ...DEFAULTS, ...(value ?? {}) };
  cachedAt = now;
  return cache;
}

export function _resetBeliefConfigCacheForTests() {
  cache = null;
  cachedAt = 0;
}
