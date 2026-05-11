// calibration.js — read + apply calibration drift for belief().
// Spec §3. Day-1 path: persona:singleton.calibration. Upgrade path: a
// recent kind='reasoning', meta.dimension='calibration' memo wins when
// present (the weekly meta-narrative writer fills these).

import { surql } from 'surrealdb';

/**
 * Apply linear-with-clamp calibration adjustment.
 *
 * drift > 0 → over-confident → push agg DOWN.
 * drift < 0 → under-confident → push agg UP.
 * Returns agg unchanged when calibration is missing/thin/invalid.
 */
export function calibrateAdjust(agg, cal, cfg) {
  if (!cal) return agg;
  if ((cal.samples_count ?? 0) < (cfg.min_calibration_samples ?? 5)) return agg;
  if (typeof cal.drift !== 'number' || Number.isNaN(cal.drift)) return agg;
  const gain = cfg.calibration_adjustment_gain ?? 1.0;
  const adjusted = agg - cal.drift * gain;
  if (adjusted < 0) return 0;
  if (adjusted > 1) return 1;
  return adjusted;
}

/**
 * Cross-kind aggregate fallback when domain is absent or unmatched.
 * Returns null on empty input.
 */
export function aggregateAcrossKinds(by_kind, ts, cfg) {
  let total = 0;
  let correct = 0;
  for (const v of Object.values(by_kind ?? {})) {
    total += v?.resolved ?? 0;
    correct += v?.correct ?? 0;
  }
  if (total === 0) return null;
  const accuracy = correct / total;
  const baseline = cfg.expected_accuracy_baseline ?? 0.75;
  return {
    domain: null,
    samples_count: total,
    accuracy,
    drift: baseline - accuracy,
    as_of: ts ?? null,
    source: 'persona.calibration',
  };
}

/**
 * Read calibration for a domain. Prefers a recent meta-narrative memo
 * (spec §3.4); falls back to persona:singleton.calibration; falls back
 * to aggregateAcrossKinds when the persona has no matching statement_kind.
 *
 * Returns null when no calibration data is available at all.
 */
export async function readCalibration(db, domain, cfg) {
  // §3.4 — try the meta-narrative override first (cheap; bounded by kind+derived_at).
  if (domain) {
    const [memoRows] = await db
      .query(
        surql`SELECT meta, derived_at FROM memos
              WHERE kind = 'reasoning'
                AND meta.dimension = 'calibration'
                AND meta.domain = ${domain}
                AND derived_at >= time::now() - 14d
              ORDER BY derived_at DESC
              LIMIT 1`,
      )
      .collect();
    const memo = memoRows?.[0];
    if (memo?.meta && typeof memo.meta.drift === 'number') {
      return {
        domain,
        samples_count: memo.meta.samples ?? cfg.min_calibration_samples ?? 5,
        accuracy: memo.meta.accuracy ?? null,
        drift: memo.meta.drift,
        brier: memo.meta.brier ?? null,
        as_of: memo.derived_at ?? null,
        source: 'meta_narrative',
      };
    }
  }

  // §3.2 — day-1 path: persona:singleton.calibration.
  const [personaRows] = await db.query('SELECT calibration FROM persona:singleton').collect();
  const cal = personaRows?.[0]?.calibration;
  if (!cal?.by_kind) return null;

  if (domain) {
    const key = Object.keys(cal.by_kind).find(
      (k) => k.toLowerCase() === String(domain).toLowerCase(),
    );
    if (key) {
      const v = cal.by_kind[key];
      const baseline = cfg.expected_accuracy_baseline ?? 0.75;
      return {
        domain: key,
        samples_count: v?.resolved ?? 0,
        accuracy: v?.accuracy ?? 0,
        drift: baseline - (v?.accuracy ?? 0),
        as_of: cal.last_computed_at ?? null,
        source: 'persona.calibration',
      };
    }
  }

  // No domain match → cross-kind aggregate.
  return aggregateAcrossKinds(cal.by_kind, cal.last_computed_at, cfg);
}
