// cost-monitor.js — 6-hour sub-tick cost monitoring for Phase 2.
//
// Spec §6 "Phase 2 — soft launch":
//   "Monitor show_cost_rollup every 6h for the first 3 days."
//
// Implementation:
//   - Runs on the 5-min heartbeat but gates internally: skips if < 6 h since
//     last run (stored in runtime:`self-improvement-v2`.value.cost_monitor_last_run_at).
//   - Reads cost_usd from cadence_telemetry for the trailing 6 h, filtering
//     to introspection and dream faculties.
//   - Projects daily cost (× 4).
//   - If projected > 2× daily_budget, writes a watch-list event to the DB
//     (source='agent_internal', meta.surface_in_brief=true) so the daily brief
//     picks it up.
//
// Gate: isSelfImprovementV2Enabled — no-op when false.

import { BoundQuery } from 'surrealdb';
import { isSelfImprovementV2Enabled } from '../../runtime/config/self-improvement-v2.js';
import { INTROSPECTION_DEFAULTS } from '../introspection/inference-rules.js';

const V2_RECORD_SQL = 'runtime:`self-improvement-v2`';

// Sub-tick gate: 6 hours between runs.
export const COST_MONITOR_INTERVAL_MS = 6 * 60 * 60_000;

// Steps belonging to introspection and dream faculties.
// Matches the cadence_telemetry `step` prefixes used by each faculty.
const MONITORED_STEP_PREFIXES = ['introspection.', 'dream.'];

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Cost-monitor tick body.  Called by the 5-min heartbeat bucket in server.js.
 * Has an internal 6-hour sub-tick gate — skips unless 6 h has elapsed since
 * the last run.
 *
 * @param {{ db: object }} opts
 * @returns {Promise<string>} summary for job tracking
 */
export async function runCostMonitor({ db }) {
  if (!(await isSelfImprovementV2Enabled(db))) {
    return 'skipped=flag_off';
  }

  const v2 = await readV2Value(db);
  const lastRunAt = v2.cost_monitor_last_run_at
    ? new Date(v2.cost_monitor_last_run_at).getTime()
    : 0;

  if (Date.now() - lastRunAt < COST_MONITOR_INTERVAL_MS) {
    return 'skipped=too_soon';
  }

  // Stamp the run time before doing work so concurrent ticks can't double-fire.
  await upsertV2Field(db, 'cost_monitor_last_run_at', new Date().toISOString());

  const windowEnd = new Date();
  const windowStart = new Date(windowEnd.getTime() - COST_MONITOR_INTERVAL_MS);

  const costUsd = await queryCostUsd(db, windowStart, windowEnd);
  const projectedDailyUsd = costUsd * 4; // 6 h × 4 = 24 h

  // Budget: introspection ($0.50) + dream per-night steps approx.
  // Use the introspection daily budget as a floor; spec sets combined at ~$2/day.
  // We surface when projected > 2× daily budget.
  const dailyBudget = await readDailyBudget(db);
  const threshold = 2 * dailyBudget;

  if (projectedDailyUsd > threshold) {
    const msg = `WARNING: projected daily LLM cost $${projectedDailyUsd.toFixed(4)} > 2x budget $${dailyBudget.toFixed(4)} (measured over 6h window ending ${windowEnd.toISOString()})`;
    await writeWatchListEvent(db, msg);
    console.warn(`[cost-monitor] ${msg}`);
    return `alert=true projected=$${projectedDailyUsd.toFixed(4)} budget=$${dailyBudget.toFixed(4)}`;
  }

  return `ok cost_6h=$${costUsd.toFixed(4)} projected_daily=$${projectedDailyUsd.toFixed(4)} budget=$${dailyBudget.toFixed(4)}`;
}

export default runCostMonitor;

// ---------------------------------------------------------------------------
// DB helpers
// ---------------------------------------------------------------------------

async function readV2Value(db) {
  try {
    const [rows] = await db.query(`SELECT VALUE value FROM ${V2_RECORD_SQL}`).collect();
    const v = rows?.[0];
    return v && typeof v === 'object' ? v : {};
  } catch {
    return {};
  }
}

async function upsertV2Field(db, key, value) {
  await db
    .query(`UPSERT ${V2_RECORD_SQL} SET value.${key} = ${JSON.stringify(value)}`)
    .collect();
}

/**
 * Sum cost_usd from cadence_telemetry (introspection + dream steps) in the
 * given time window.
 *
 * cadence_telemetry rows don't have a direct cost_usd field.  The introspection
 * faculty records cost in memos.meta.signals.self_grade.cost_usd.  For a
 * lightweight cost proxy, use tokens × a fixed per-token rate if cost_usd is
 * unavailable in cadence_telemetry.
 *
 * We try two sources in order:
 *   1. telemetry_hourly WHERE faculty IN ('introspection','dream') AND
 *      event_kind='llm_call' (populated once the rollup runs).
 *   2. cadence_telemetry fallback: sum(tokens_in + tokens_out) × rate.
 *
 * Either gives an approximation sufficient for the 2× budget guard.
 */
async function queryCostUsd(db, windowStart, windowEnd) {
  // Source 1: telemetry_hourly (populated by the rollup job).
  try {
    const sql = `
      SELECT math::sum(metric_sums.cost_usd_sum ?? 0) AS total
      FROM telemetry_hourly
      WHERE faculty IN ['introspection', 'dream']
        AND event_kind = 'llm_call'
        AND hour >= $start
        AND hour < $end
      GROUP ALL
    `;
    const [rows] = await db
      .query(new BoundQuery(sql, { start: windowStart, end: windowEnd }))
      .collect();
    const v = rows?.[0]?.total;
    if (typeof v === 'number' && v > 0) return v;
  } catch {
    // Fall through to source 2.
  }

  // Source 2: cadence_telemetry token-sum fallback.
  // ~$0.000002/token (Haiku blended; order-of-magnitude guard only).
  const TOKEN_COST_RATE = 0.000_002;
  try {
    const orClauses = MONITORED_STEP_PREFIXES.map(
      (_, i) => `string::starts_with(step, $p${i})`,
    ).join(' OR ');
    const params = { start: windowStart, end: windowEnd };
    MONITORED_STEP_PREFIXES.forEach((p, i) => {
      params[`p${i}`] = p;
    });
    const sql = `
      SELECT math::sum(tokens_in + tokens_out) AS total_tokens
      FROM cadence_telemetry
      WHERE ts >= $start AND ts < $end
        AND (${orClauses})
      GROUP ALL
    `;
    const [rows] = await db.query(new BoundQuery(sql, params)).collect();
    const tokens = rows?.[0]?.total_tokens ?? 0;
    return tokens * TOKEN_COST_RATE;
  } catch {
    return 0;
  }
}

/**
 * Read the introspection daily budget.  Falls back to $0.50 (INTROSPECTION_DEFAULTS)
 * if the config row is absent.  The combined budget per spec is ~$2/day; using
 * introspection's as the floor is conservative (wider alert window).
 */
async function readDailyBudget(db) {
  try {
    const [rows] = await db
      .query('SELECT VALUE value FROM runtime:`introspection.config`')
      .collect();
    const v = rows?.[0];
    const d = v?.daily_cost_budget_usd;
    return typeof d === 'number' && d > 0 ? d : INTROSPECTION_DEFAULTS.daily_cost_budget_usd;
  } catch {
    return INTROSPECTION_DEFAULTS.daily_cost_budget_usd;
  }
}

/**
 * Write a watch-list event to the events table so the daily brief picks it up.
 * Uses source='agent_internal' (a VALID_SOURCES member).
 * meta.surface_in_brief=true marks it for watch-list inclusion.
 */
async function writeWatchListEvent(db, msg) {
  try {
    await db
      .query(
        new BoundQuery(
          `CREATE events CONTENT {
            source: 'agent_internal',
            content: $content,
            meta: { surface_in_brief: true, kind: 'cost_monitor_alert' }
          }`,
          { content: msg },
        ),
      )
      .collect();
  } catch (e) {
    // Non-fatal — the console.warn above is sufficient for operator awareness.
    console.warn(`[cost-monitor] failed to write watch-list event: ${e.message}`);
  }
}
