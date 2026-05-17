// budget.js — daily cost budget read + decrement shell (Phase 1).
//
// Wave 3 wires actual LLM calls into this module.  Phase 1 only provides:
//   - initBudgetConfig()    — ensure the KV row exists with defaults
//   - readBudgetConfig()    — return current config (daily_cost_budget_usd etc.)
//   - readBudgetState()     — return daily spend so far
//   - decrementBudget(cost) — placeholder (always succeeds, cost recorded)
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
//
// LLM hooks (Wave 3) will call `decrementBudget` and check `isStratumAllowed`.

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
 * Phase 1: records spend only; no actual LLM calls happen yet (Wave 3).
 * Atomic increment via SurrealDB += semantics.
 */
export async function decrementBudget(db, costUsd) {
  if (typeof costUsd !== 'number' || costUsd <= 0) return;
  await db.query(`UPSERT ${VALUE_RECORD_SQL} SET value.daily_spend_usd += ${costUsd}`).collect();
}

/**
 * Increment the leaky-bucket crash counter.
 * Decrement (decay) is scheduled per INTROSPECTION_DEFAULTS.leaky_bucket_decay_per_sec.
 */
export async function incrementCrashCount(db) {
  await db.query(`UPSERT ${VALUE_RECORD_SQL} SET value.crash_count += 1`).collect();
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
 * Phase 1: always returns true (no LLM spend yet).
 * Wave 3 will compute fractions from readBudgetState.
 *
 * @param {'predictions'|'outbound'|'jobs'|'recall'|'turns'} stratum
 * @param {object} cfg — from readBudgetConfig()
 * @param {object} state — from readBudgetState()
 */
export function isStratumAllowed(stratum, cfg, state) {
  // Phase 1: all strata allowed (no LLM spend)
  return true;
}
