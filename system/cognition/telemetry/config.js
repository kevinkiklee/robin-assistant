// config.js — read runtime:telemetry.config. The aggregator and the MCP
// tool both invoke this once per tick / per invocation; the result is
// effectively cached for the duration of that call's scope.

/**
 * Returns the parsed telemetry config row with defaults applied for any
 * missing keys. The 0017 migration seeds the row, so the defaults path is
 * defensive (e.g., for early-test DBs that have not yet run all
 * migrations).
 *
 * @param {object} db SurrealDB handle.
 * @returns {Promise<{
 *   enabled: boolean,
 *   shadow_mode: boolean,
 *   raw_retention_days: number,
 *   hourly_retention_days: number,
 *   daily_retention_days: number,
 *   cutoff_safety_seconds: number,
 *   cursor_fallback_window_hours: number,
 *   faculties_enabled: string[],
 *   cadence_hot_steps: string[],
 *   pending_recall_log_hard_ceiling_days: number,
 * }>}
 */
export async function readTelemetryConfig(db) {
  let v = {};
  try {
    const [rows] = await db
      .query('SELECT VALUE value FROM runtime:`telemetry.config`')
      .collect();
    v = rows?.[0] ?? {};
  } catch {
    v = {};
  }
  return {
    enabled: v.enabled ?? false,
    shadow_mode: v.shadow_mode ?? true,
    raw_retention_days: v.raw_retention_days ?? 7,
    hourly_retention_days: v.hourly_retention_days ?? 90,
    daily_retention_days: v.daily_retention_days ?? 365,
    cutoff_safety_seconds: v.cutoff_safety_seconds ?? 60,
    cursor_fallback_window_hours: v.cursor_fallback_window_hours ?? 24,
    faculties_enabled: v.faculties_enabled ?? [],
    cadence_hot_steps: v.cadence_hot_steps ?? ['belief.', 'dream.'],
    pending_recall_log_hard_ceiling_days: v.pending_recall_log_hard_ceiling_days ?? 30,
  };
}
