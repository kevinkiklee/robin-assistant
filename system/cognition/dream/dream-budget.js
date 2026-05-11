// dream-budget.js — config read + shouldHalt for the parallel dream
// scheduler. Spec §5 / §5.1. Reuses currentBudget(db, cfg) and
// readCadenceConfig from ./budget.js so the 24-h consumed sum is the
// unified cadence + dream picture.

import { currentBudget, readCadenceConfig } from './budget.js';

const DEFAULTS = {
  parallelism_enabled: false,
  max_concurrent: null,
  budget_check_enabled: true,
  budget_floor: null, // null → defaultFloor(cadenceCfg) = 20% reserve
};

/**
 * Read runtime:`dream.config`. Returns DEFAULTS if the row is missing or
 * the query throws (e.g., pre-migration smoke).
 */
export async function readDreamConfig(db) {
  try {
    const [rows] = await db.query('SELECT VALUE value FROM runtime:`dream.config`').collect();
    const stored = rows?.[0];
    if (!stored || typeof stored !== 'object') return { ...DEFAULTS };
    return { ...DEFAULTS, ...stored };
  } catch {
    return { ...DEFAULTS };
  }
}

/**
 * 20% of daily_token_budget; floors at zero on missing/zero input.
 */
export function defaultFloor(cadenceCfg) {
  const daily = cadenceCfg?.daily_token_budget ?? 0;
  if (!Number.isFinite(daily) || daily <= 0) return 0;
  return Math.floor(daily * 0.2);
}

/**
 * Layer-boundary halt check. Returns true when the 24-h rolling sum is
 * about to push remaining headroom below the cadence reserve.
 */
export async function shouldHalt(db, cfg, cadenceCfg) {
  if (cfg?.budget_check_enabled === false) return false;
  const effectiveCadenceCfg = cadenceCfg ?? (await readCadenceConfig(db));
  const { remaining } = await currentBudget(db, effectiveCadenceCfg ?? {});
  const floor =
    cfg?.budget_floor === null || cfg?.budget_floor === undefined
      ? defaultFloor(effectiveCadenceCfg)
      : cfg.budget_floor;
  return remaining <= floor;
}
