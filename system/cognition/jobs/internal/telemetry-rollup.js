// telemetry-rollup.js — heartbeat-driven aggregator entry. Combines:
//   Stage 1: rollupHotTelemetry (registry → telemetry_hourly UPSERTs)
//   Stage 2: pruneRawTelemetry for intuition_telemetry, recall_log (non-pending)
//   Stage 2b: pending recall_log hard ceiling
//   Stage 3: telemetry_hourly retention
//
// Fail-soft per stage. Always exits cleanly so the heartbeat dispatcher
// doesn't get stuck.

import { readTelemetryConfig } from '../../telemetry/config.js';
import { recordTelemetry } from '../../telemetry/recorder.js';
import { pruneRawTelemetry } from '../../telemetry/retention.js';
import { rollupHotTelemetry } from '../../telemetry/rollup.js';

export default async function telemetryRollup({ db }) {
  const cfg = await readTelemetryConfig(db);
  if (!cfg.enabled) return JSON.stringify({ skipped: 'disabled' });

  const result = { rollup: {}, prune: {} };

  // Stage 1 — rollup.
  try {
    result.rollup = await rollupHotTelemetry({ db, cfg });
  } catch (e) {
    result.rollup = { error: e.message };
  }

  // Stage 2 — raw retention.
  for (const table of ['intuition_telemetry', 'recall_log']) {
    try {
      const before = new Date(Date.now() - cfg.raw_retention_days * 86_400_000);
      const where = table === 'recall_log' ? 'outcome != "pending"' : null;
      result.prune[table] = await pruneRawTelemetry({ db, table, before, where });
    } catch (e) {
      result.prune[table] = { error: e.message };
    }
  }

  // Stage 2b — pending hard ceiling.
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
        // Advisory.
      }
    }
    result.prune.recall_log_pending = deleted;
  } catch (e) {
    result.prune.recall_log_pending = { error: e.message };
  }

  // Stage 3 — hourly retention.
  try {
    const before = new Date(Date.now() - cfg.hourly_retention_days * 86_400_000);
    result.prune.telemetry_hourly = await pruneRawTelemetry({
      db,
      table: 'telemetry_hourly',
      before,
      timestampField: 'hour',
    });
  } catch (e) {
    result.prune.telemetry_hourly = { error: e.message };
  }

  return JSON.stringify(result);
}
