// budget.js — daily cost budget tracking for the introspection faculty.
//
// Exports:
//   - initBudgetConfig()           — ensure the KV row exists with defaults
//   - readBudgetConfig()           — return current config (daily_cost_budget_usd etc.)
//   - readBudgetState()            — return daily spend so far
//   - decrementBudget(cost)        — record spend (legacy; use tryReserveCost instead)
//   - tryReserveCost(db, cost)     — atomic check + reserve; returns {ok, remaining}
//   - recordActualCost(db, actual) — correct the spend after LLM call completes
//   - isStratumAllowed(...)        — strata-priority gate (spec §2)
//   - autoTuneTurnSamplePct(db, cfg) — recompute turn_sample_pct from 7d history
//
// The KV key is runtime:introspection.config and runtime:introspection.value.
// Config is written once (init) and stays hot-reloadable; value tracks
// mutable runtime state (spend, crash_count, turn_sample_pct).
//
// Budget strata (spec §2):
//   1. Predictions + explicit corrections — always, free.
//   2. Outbound writes — always up to exhaustion, structural only.
//   3. Jobs — always up to budget.
//   4. Recall queries — 100% until 25% remaining, then 25%.
//   5. Assistant turns — auto-tuned turn_sample_pct; 0 below 10% remaining.

import { surql } from 'surrealdb';
import { INTROSPECTION_DEFAULTS } from './inference-rules.js';

// KV keys in the `runtime` table (same pattern as runtime:biographer,
// runtime:embedder, runtime:`self-improvement-v2`).
// Config: runtime:`introspection.config`
// Value:  runtime:`introspection.value`
const CONFIG_RECORD_SQL = 'runtime:`introspection.config`';
const VALUE_RECORD_SQL = 'runtime:`introspection.value`';

// ── Config (daily_cost_budget_usd etc.) ─────────────────────────────────────

/**
 * Ensure the introspection config KV row exists.  Creates it with spec
 * defaults if absent; no-ops otherwise.  Call once at faculty start().
 */
export async function initBudgetConfig(db) {
  const [rows] = await db.query(`SELECT * FROM ${CONFIG_RECORD_SQL}`).collect();
  const existing = Array.isArray(rows) ? rows[0] : rows;
  if (existing?.value && typeof existing.value === 'object') {
    // Row present — nothing to do.
    return { created: false };
  }
  const defaults = {
    daily_cost_budget_usd: INTROSPECTION_DEFAULTS.daily_cost_budget_usd,
    turn_sample_pct_floor: INTROSPECTION_DEFAULTS.turn_sample_pct_floor,
    turn_sample_pct_ceiling: INTROSPECTION_DEFAULTS.turn_sample_pct_ceiling,
    target_turn_spend_fraction: INTROSPECTION_DEFAULTS.target_turn_spend_fraction,
    budget_remaining_thresholds: INTROSPECTION_DEFAULTS.budget_remaining_thresholds,
    enabled: true,
  };
  await db.query(surql`UPSERT runtime:\`introspection.config\` SET value = ${defaults}`).collect();
  return { created: true };
}

/**
 * Read the current budget config.  Returns defaults if row absent.
 */
export async function readBudgetConfig(db) {
  try {
    const [rows] = await db.query(`SELECT VALUE value FROM ${CONFIG_RECORD_SQL}`).collect();
    const v = Array.isArray(rows) ? rows[0] : rows;
    if (!v || typeof v !== 'object') return { ...INTROSPECTION_DEFAULTS };
    return {
      daily_cost_budget_usd:
        v.daily_cost_budget_usd ?? INTROSPECTION_DEFAULTS.daily_cost_budget_usd,
      turn_sample_pct_floor:
        v.turn_sample_pct_floor ?? INTROSPECTION_DEFAULTS.turn_sample_pct_floor,
      turn_sample_pct_ceiling:
        v.turn_sample_pct_ceiling ?? INTROSPECTION_DEFAULTS.turn_sample_pct_ceiling,
      target_turn_spend_fraction:
        v.target_turn_spend_fraction ?? INTROSPECTION_DEFAULTS.target_turn_spend_fraction,
      budget_remaining_thresholds:
        v.budget_remaining_thresholds ?? INTROSPECTION_DEFAULTS.budget_remaining_thresholds,
      enabled: v.enabled !== false, // default true
    };
  } catch {
    return { ...INTROSPECTION_DEFAULTS };
  }
}

// ── Value (mutable runtime state) ───────────────────────────────────────────

/**
 * Read mutable runtime state (daily spend, crash_count, turn_sample_pct).
 * Returns zeros if row absent.
 */
export async function readBudgetState(db) {
  try {
    const [rows] = await db.query(`SELECT VALUE value FROM ${VALUE_RECORD_SQL}`).collect();
    const v = Array.isArray(rows) ? rows[0] : rows;
    if (!v || typeof v !== 'object')
      return { daily_spend_usd: 0, crash_count: 0, turn_sample_pct: 25 };
    return {
      daily_spend_usd: v.daily_spend_usd ?? 0,
      crash_count: v.crash_count ?? 0,
      turn_sample_pct: v.turn_sample_pct ?? 25,
    };
  } catch {
    return { daily_spend_usd: 0, crash_count: 0, turn_sample_pct: 25 };
  }
}

/**
 * Decrement the daily budget by `costUsd`.
 * Legacy helper — prefer tryReserveCost for new callers.
 * Atomic increment via SurrealDB += semantics.
 */
export async function decrementBudget(db, costUsd) {
  if (typeof costUsd !== 'number' || costUsd <= 0) return;
  await db.query(`UPSERT ${VALUE_RECORD_SQL} SET value.daily_spend_usd += ${costUsd}`).collect();
}

/**
 * Atomically check + reserve budget for one LLM call.
 *
 * Reads current spent_today + daily limit, checks that the estimated
 * cost fits, then increments spend by the estimated amount.
 *
 * Because SurrealDB doesn't expose a CAS primitive, this is two queries
 * (read + write). Two concurrent callers can both pass the check and
 * over-spend by at most one call's worth — an acceptable trade for Phase 1.
 *
 * @param {object} db
 * @param {number} estimatedCostUsd
 * @returns {Promise<{ok: boolean, remaining: number, reason?: string}>}
 */
export async function tryReserveCost(db, estimatedCostUsd) {
  if (typeof estimatedCostUsd !== 'number' || estimatedCostUsd < 0) {
    estimatedCostUsd = 0;
  }

  let cfg, state;
  try {
    cfg = await readBudgetConfig(db);
    state = await readBudgetState(db);
  } catch {
    // DB error — fail open (don't block grading due to budget read failure)
    return { ok: true, remaining: 0 };
  }

  const limit = cfg.daily_cost_budget_usd;
  const spent = state.daily_spend_usd ?? 0;
  const remaining = Math.max(0, limit - spent);

  if (estimatedCostUsd > 0 && spent + estimatedCostUsd > limit) {
    return { ok: false, remaining, reason: 'exhausted' };
  }

  // Reserve the estimated cost.
  if (estimatedCostUsd > 0) {
    try {
      await db
        .query(`UPSERT ${VALUE_RECORD_SQL} SET value.daily_spend_usd += ${estimatedCostUsd}`)
        .collect();
    } catch {
      // Reserve write failed — return ok:false so the caller doesn't proceed
      // and then refund an amount that was never incremented (would produce a
      // negative daily_spend_usd via recordActualCost's delta correction).
      return { ok: false, remaining, reason: 'reserve_write_failed' };
    }
  }

  return { ok: true, remaining: remaining - estimatedCostUsd };
}

/**
 * Correct the budget after an LLM call completes.
 *
 * `tryReserveCost` pre-charged the estimated amount.  After the call,
 * record the difference between actual and estimated (can be negative if
 * the call was cheaper than estimated).
 *
 * @param {object} db
 * @param {number} actualCostUsd
 * @param {number} estimatedCostUsd — the amount previously reserved
 */
export async function recordActualCost(db, actualCostUsd, estimatedCostUsd) {
  if (typeof actualCostUsd !== 'number' || !Number.isFinite(actualCostUsd)) return;
  if (typeof estimatedCostUsd !== 'number' || !Number.isFinite(estimatedCostUsd)) {
    estimatedCostUsd = 0;
  }
  const delta = actualCostUsd - estimatedCostUsd;
  if (Math.abs(delta) < 1e-9) return; // no meaningful difference
  try {
    await db
      .query(`UPSERT ${VALUE_RECORD_SQL} SET value.daily_spend_usd += ${delta}`)
      .collect();
  } catch {
    // Best-effort correction; non-fatal.
  }
}

/**
 * Increment the leaky-bucket crash counter.
 * Decrement (decay) is scheduled per INTROSPECTION_DEFAULTS.leaky_bucket_decay_per_sec.
 */
export async function incrementCrashCount(db) {
  await db.query(`UPSERT ${VALUE_RECORD_SQL} SET value.crash_count += 1`).collect();
}

/**
 * Reset crash_count to 0.
 * Called at restart entry so the leaky-bucket can't immediately re-fire.
 */
export async function resetCrashCount(db) {
  await db.query(`UPSERT ${VALUE_RECORD_SQL} SET value.crash_count = 0`).collect();
}

/**
 * Decrement crash_count by 1 (leaky-bucket decay tick).
 * Clamps to 0 via max([0, current - 1]).
 */
export async function decrementCrashCount(db) {
  await db
    .query(
      `UPDATE ${VALUE_RECORD_SQL}
       SET value.crash_count = math::max([0, <int>(value.crash_count ?? 0) - 1])`,
    )
    .collect();
}

/**
 * Check whether the given stratum is allowed given current budget state.
 *
 * Strata priority (spec §2):
 *   1. 'predictions' — always allowed (free, no LLM).
 *   2. 'outbound'    — always up to exhaustion.
 *   3. 'jobs'        — always up to exhaustion.
 *   4. 'recall'      — 100% until 25% remaining, then 25% sample rate.
 *                      Returns { allowed: true, samplePct: 25 } in throttle zone.
 *   5. 'turns'       — at turn_sample_pct; drops to 0% below 10% remaining.
 *
 * @param {'predictions'|'outbound'|'jobs'|'recall'|'turns'} stratum
 * @param {object} cfg   — from readBudgetConfig()
 * @param {object} state — from readBudgetState()
 * @returns {{ allowed: boolean, samplePct?: number }}
 *   `samplePct` present only for 'recall' and 'turns'; indicates probabilistic
 *   sampling rate.  Callers must perform their own Math.random() < samplePct/100
 *   check when `allowed=true` and samplePct < 100.
 */
export function isStratumAllowed(stratum, cfg, state) {
  const limit = cfg?.daily_cost_budget_usd ?? INTROSPECTION_DEFAULTS.daily_cost_budget_usd;
  const spent = state?.daily_spend_usd ?? 0;
  const remaining = Math.max(0, limit - spent);
  const remainingFraction = limit > 0 ? remaining / limit : 0;

  const thresholds =
    cfg?.budget_remaining_thresholds ?? INTROSPECTION_DEFAULTS.budget_remaining_thresholds;
  const recallThrottle = thresholds.recall_throttle_at ?? 0.25;
  const turnCutoff = thresholds.turn_sample_cutoff_at ?? 0.10;

  switch (stratum) {
    case 'predictions':
      // Always — no LLM spend, structural only.
      return { allowed: true };

    case 'outbound':
    case 'jobs':
      // Always up to exhaustion.
      return { allowed: remaining > 0 || limit === 0 };

    case 'recall':
      if (remaining <= 0 && limit > 0) return { allowed: false };
      if (remainingFraction <= recallThrottle) {
        // Throttled to 25% sampling.
        return { allowed: true, samplePct: 25 };
      }
      return { allowed: true, samplePct: 100 };

    case 'turns': {
      if (remainingFraction <= turnCutoff) {
        // Below 10% — no turn grading.
        return { allowed: false };
      }
      const pct = state?.turn_sample_pct ?? INTROSPECTION_DEFAULTS.turn_sample_pct_floor;
      return { allowed: true, samplePct: pct };
    }

    default:
      return { allowed: true };
  }
}

/**
 * Auto-tune turn_sample_pct from 7d history.
 *
 * Formula (spec §2):
 *   projected_turn_cost = avg_turn_grade_cost_7d × turns_per_day_7d
 *   target_turn_spend   = daily_cost_budget_usd × target_turn_spend_fraction
 *   turn_sample_pct     = clamp(round(target_turn_spend / projected_turn_cost × 100), floor, ceiling)
 *
 * Cold start (no history): default to INTROSPECTION_DEFAULTS.turn_sample_pct_floor
 * or the first-boot constant (20).
 *
 * Persists result to runtime:introspection.value.turn_sample_pct.
 * Also sets runtime:introspection.value.antecedent_regex_fallback based on
 * whether budget is below 25% remaining.
 *
 * @param {object} db
 * @param {object} cfg — from readBudgetConfig()
 * @returns {Promise<number>} — new turn_sample_pct value
 */
export async function autoTuneTurnSamplePct(db, cfg) {
  const limit = cfg?.daily_cost_budget_usd ?? INTROSPECTION_DEFAULTS.daily_cost_budget_usd;
  const floor = cfg?.turn_sample_pct_floor ?? INTROSPECTION_DEFAULTS.turn_sample_pct_floor;
  const ceiling = cfg?.turn_sample_pct_ceiling ?? INTROSPECTION_DEFAULTS.turn_sample_pct_ceiling;
  const targetFraction =
    cfg?.target_turn_spend_fraction ?? INTROSPECTION_DEFAULTS.target_turn_spend_fraction;
  const thresholds =
    cfg?.budget_remaining_thresholds ?? INTROSPECTION_DEFAULTS.budget_remaining_thresholds;
  const recallThrottle = thresholds.recall_throttle_at ?? 0.25;

  // Query 7d history: collect cost_usd values for LLM-graded turn task_outcomes,
  // then compute avg in JS (math::mean() in SurrealDB v3 requires an array arg,
  // not a column reference, so we aggregate ourselves).
  let avgCostPerGrade = null;
  let turnsPerDay = null;
  try {
    const since7d = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const [rows] = await db
      .query(
        surql`SELECT meta.signals.self_grade.cost_usd AS cost
              FROM memos
              WHERE kind = 'task_outcome'
                AND string::starts_with(meta.task_type, 'turn:')
                AND meta.signals.self_grade IS NOT NULL
                AND derived_at >= ${since7d}`,
      )
      .collect();
    const arr = Array.isArray(rows) ? rows.filter(Boolean) : [];
    if (arr.length > 0) {
      turnsPerDay = arr.length / 7;
      const costs = arr
        .map((r) => (typeof r?.cost === 'number' && Number.isFinite(r.cost) ? r.cost : null))
        .filter((c) => c !== null);
      avgCostPerGrade = costs.length > 0 ? costs.reduce((s, c) => s + c, 0) / costs.length : null;
    }
  } catch {
    // History query failed — use cold-start default.
  }

  let newPct;
  if (avgCostPerGrade !== null && avgCostPerGrade > 0 && turnsPerDay !== null && turnsPerDay > 0) {
    const projectedTurnCost = avgCostPerGrade * turnsPerDay;
    const targetTurnSpend = limit * targetFraction;
    const raw = Math.round((targetTurnSpend / projectedTurnCost) * 100);
    newPct = Math.min(ceiling, Math.max(floor, raw));
  } else {
    // Cold start: use 20 (spec §2 "Phase 1 cold start").
    newPct = Math.min(ceiling, Math.max(floor, 20));
  }

  // Compute antecedent_regex_fallback: true when remaining budget < 25%.
  //
  // FUTURE HOOK (spec 3-B-2): This flag is written here but has no reader yet.
  // correction-inference.js is currently pure-structural (regex only; no Haiku
  // call). When antecedent verification is upgraded to Haiku, the inference
  // module should read this flag and skip the Haiku call when it is true,
  // falling back to pure-regex matching. Until then the flag is a no-op write.
  let antecedentRegexFallback = false;
  try {
    const state = await readBudgetState(db);
    const spent = state.daily_spend_usd ?? 0;
    const remaining = Math.max(0, limit - spent);
    const remainingFraction = limit > 0 ? remaining / limit : 1;
    antecedentRegexFallback = remainingFraction <= recallThrottle;
  } catch {
    // Non-fatal — default false.
  }

  // Persist both values.
  try {
    await db
      .query(
        `UPSERT ${VALUE_RECORD_SQL} SET
           value.turn_sample_pct = ${newPct},
           value.antecedent_regex_fallback = ${antecedentRegexFallback}`,
      )
      .collect();
  } catch {
    // Persist failure is non-fatal; in-memory value still used this tick.
  }

  return newPct;
}
