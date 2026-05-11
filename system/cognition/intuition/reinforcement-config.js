// reinforcement-config.js — single-row read for runtime:`reinforcement.config`.
// Returns a merged object: any missing keys fall back to defaults so callers
// never need to null-check individual fields. Caller is responsible for
// caching per evaluatePending tick.

const DEFAULTS = Object.freeze({
  attribution_mode: 'off',
  similarity_threshold: 0.35,
  jaccard_min_overlap_tokens: 2,
  citation_date_window_days: 2,
  fallback_when_no_reply: true,
  fallback_when_zero_used: true,
  reply_lookup_window_ms: 600000,
});

export async function readReinforcementConfig(db) {
  try {
    const [rows] = await db
      .query('SELECT VALUE value FROM runtime:`reinforcement.config`')
      .collect();
    const v = rows?.[0];
    if (!v || typeof v !== 'object') return { ...DEFAULTS };
    return { ...DEFAULTS, ...v };
  } catch {
    return { ...DEFAULTS };
  }
}

export const REINFORCEMENT_DEFAULTS = DEFAULTS;
