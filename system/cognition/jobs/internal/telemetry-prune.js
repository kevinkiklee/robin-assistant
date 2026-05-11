// telemetry-prune.js — standalone retention enforcer. Belt-and-suspenders:
// runs even if the rollup stage is disabled or failing. Fail-soft per
// stage so the heartbeat dispatcher never gets stuck.

import { readTelemetryConfig } from '../../telemetry/config.js';
import { recordTelemetry } from '../../telemetry/recorder.js';
import { pruneRawTelemetry } from '../../telemetry/retention.js';

export default async function telemetryPrune({ db }) {
  const cfg = await readTelemetryConfig(db);
  if (!cfg.enabled) return JSON.stringify({ skipped: 'disabled' });

  const result = {};

  // Stage 2 — raw retention (intuition_telemetry, recall_log non-pending).
  for (const table of ['intuition_telemetry', 'recall_log']) {
    try {
      const before = new Date(Date.now() - cfg.raw_retention_days * 86_400_000);
      const where = table === 'recall_log' ? 'outcome != "pending"' : null;
      result[table] = await pruneRawTelemetry({ db, table, before, where });
    } catch (e) {
      result[table] = { error: e.message };
    }
  }

  // Stage 2b — pending hard ceiling (recall_log pending rows past 30d).
  try {
    const cutoff = new Date(
      Date.now() - cfg.pending_recall_log_hard_ceiling_days * 86_400_000,
    );
    const deleted = await pruneRawTelemetry({
      db,
      table: 'recall_log',
      before: cutoff,
      where: 'outcome = "pending"',
    });
    if (deleted.count > 0) {
      try {
        await recordTelemetry({
          db,
          faculty: 'reinforcement',
          event_kind: 'pending_recall_log_force_pruned',
          dimensions: {},
          metrics: { count: deleted.count },
        });
      } catch {
        // Warning emission is advisory; don't fail the job.
      }
    }
    result.recall_log_pending = deleted;
  } catch (e) {
    result.recall_log_pending = { error: e.message };
  }

  // Stage 3 — hourly retention (telemetry_hourly past 90d).
  try {
    const before = new Date(Date.now() - cfg.hourly_retention_days * 86_400_000);
    result.telemetry_hourly = await pruneRawTelemetry({
      db,
      table: 'telemetry_hourly',
      before,
      timestampField: 'hour',
    });
  } catch (e) {
    result.telemetry_hourly = { error: e.message };
  }

  return JSON.stringify(result);
}
