// task-outcome-drift-watchdog.js — heartbeat tick (5 min) for Phase 2 monitoring.
//
// Spec §6 "Phase 2 — soft launch":
//   "Auto-flag-off if task_outcome write rate drifts > 50% from baseline
//    (baseline = first 3 days of phase 2)."
//
// Lifecycle:
//   1. When v2 flag first turns true: stamp phase2_started_at.
//   2. After 72 h: lock in baseline_writes_per_hour from the trailing 72 h.
//   3. Every tick: compare trailing-1h write rate to baseline.
//      If |rate - baseline| / baseline > 0.5 → flip flag off + record reason.
//
// Gate: isSelfImprovementV2Enabled — when false, tick is a no-op.

import { BoundQuery } from 'surrealdb';
import { isSelfImprovementV2Enabled } from '../../runtime/config/self-improvement-v2.js';

const V2_RECORD_SQL = 'runtime:`self-improvement-v2`';

// Exposed for testing.
export const BASELINE_WINDOW_MS = 72 * 60 * 60_000; // 72 h
export const TRAILING_WINDOW_MS = 60 * 60_000; // 1 h
export const DRIFT_THRESHOLD = 0.5; // 50 %

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Watchdog tick body.  Called by the 5-min heartbeat bucket in server.js.
 *
 * @param {{ db: object }} opts
 * @returns {Promise<string>} summary for job tracking
 */
export async function runTaskOutcomeDriftWatchdog({ db }) {
  if (!(await isSelfImprovementV2Enabled(db))) {
    return 'skipped=flag_off';
  }

  const cfg = await readV2Value(db);

  // Step 1 — stamp phase2_started_at on first run after flag=true.
  if (!cfg.phase2_started_at) {
    await upsertV2Fields(db, { phase2_started_at: new Date().toISOString() });
    return 'phase2_started_at=stamped';
  }

  const phase2StartedAt = new Date(cfg.phase2_started_at);

  // Step 2 — lock in baseline once 72 h has elapsed.
  if (cfg.baseline_writes_per_hour == null) {
    const elapsed = Date.now() - phase2StartedAt.getTime();
    if (elapsed < BASELINE_WINDOW_MS) {
      const remainingH = Math.ceil((BASELINE_WINDOW_MS - elapsed) / (60 * 60_000));
      return `baseline=pending remaining_h=${remainingH}`;
    }
    // Compute baseline: count task_outcome memos written in the 72 h window.
    const baselineRate = await computeWriteRate(db, phase2StartedAt, new Date(), 72);
    await upsertV2Fields(db, { baseline_writes_per_hour: baselineRate });
    return `baseline=locked writes_per_hour=${baselineRate.toFixed(4)}`;
  }

  const baseline = cfg.baseline_writes_per_hour;

  // No meaningful baseline (zero writes in 72 h) — nothing to compare.
  if (baseline <= 0) {
    return 'baseline=zero_skip';
  }

  // Step 3 — compute trailing-1h rate and compare.
  const windowEnd = new Date();
  const windowStart = new Date(windowEnd.getTime() - TRAILING_WINDOW_MS);
  const current = await computeWriteRate(db, windowStart, windowEnd, 1);

  const drift = Math.abs(current - baseline) / baseline;
  if (drift > DRIFT_THRESHOLD) {
    const reason = `task_outcome write rate drifted ${(drift * 100).toFixed(1)}% from baseline (current=${current.toFixed(4)}/h baseline=${baseline.toFixed(4)}/h)`;
    await upsertV2Fields(db, {
      enabled: false,
      auto_disabled_at: new Date().toISOString(),
      auto_disabled_reason: reason,
    });
    console.warn(`[task-outcome-drift-watchdog] AUTO-DISABLED v2 flag: ${reason}`);
    return `auto_disabled=true drift=${(drift * 100).toFixed(1)}%`;
  }

  return `ok drift=${(drift * 100).toFixed(1)}% current=${current.toFixed(4)}/h baseline=${baseline.toFixed(4)}/h`;
}

export default runTaskOutcomeDriftWatchdog;

// ---------------------------------------------------------------------------
// DB helpers
// ---------------------------------------------------------------------------

/**
 * Read the full `value` object from runtime:`self-improvement-v2`.
 * Returns {} if absent.
 */
async function readV2Value(db) {
  try {
    const [rows] = await db.query(`SELECT VALUE value FROM ${V2_RECORD_SQL}`).collect();
    const v = rows?.[0];
    return v && typeof v === 'object' ? v : {};
  } catch {
    return {};
  }
}

/**
 * Merge `fields` into `runtime:\`self-improvement-v2\`.value` via UPSERT.
 * Each field is set individually so concurrent writes don't stomp each other.
 */
async function upsertV2Fields(db, fields) {
  for (const k of Object.keys(fields)) {
    if (!/^[a-z][a-z0-9_]*$/.test(k)) throw new Error(`upsertV2Fields: bad field key: ${k}`);
  }
  const setClauses = Object.entries(fields)
    .map(([k, v]) => `value.${k} = ${JSON.stringify(v)}`)
    .join(', ');
  await db.query(`UPSERT ${V2_RECORD_SQL} SET ${setClauses}`).collect();
}

/**
 * Count task_outcome memos written between `start` and `end`, divided by
 * `windowHours` to yield writes-per-hour.
 *
 * @param {object} db
 * @param {Date} start
 * @param {Date} end
 * @param {number} windowHours
 * @returns {Promise<number>}
 */
async function computeWriteRate(db, start, end, windowHours) {
  try {
    const sql = `
      SELECT count() AS n FROM memos
      WHERE kind = 'task_outcome'
        AND derived_at >= $start
        AND derived_at < $end
      GROUP ALL
    `;
    const [rows] = await db
      .query(new BoundQuery(sql, { start, end }))
      .collect();
    const n = rows?.[0]?.n ?? 0;
    return n / windowHours;
  } catch {
    return 0;
  }
}
