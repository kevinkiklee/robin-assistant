// recommend.js — threshold mapping per spec §2.6.

export function recommendBelief(calibrated, domain, k_returned, cfg) {
  if (k_returned === 0) return 'unknown';
  const t = (domain && cfg.domain_thresholds?.[domain]) ?? cfg.default_threshold ?? 0.6;
  const floor = cfg.soften_floor ?? 0.4;
  if (calibrated <= floor) return 'unknown';
  if (calibrated >= t) return 'assert';
  return 'soften';
}
