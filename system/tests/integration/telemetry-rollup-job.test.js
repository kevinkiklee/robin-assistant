// Integration tests for the rollup job behavior — idempotency, cursor
// advance / fallback, pending-not-rolled-up, per-cursor fail-soft.

import assert from 'node:assert/strict';
import { mkdirSync as __robinMkdirSync } from 'node:fs';
import { tmpdir as __robinTmpdir } from 'node:os';
import { join as __robinJoin, resolve } from 'node:path';
import { test } from 'node:test';
import { surql } from 'surrealdb';
import { readTelemetryConfig } from '../../cognition/telemetry/config.js';
import { rollupHotTelemetry } from '../../cognition/telemetry/rollup.js';
import { writeConfig as __robinWriteConfig } from '../../config/paths.js';
import { close, connect } from '../../data/db/client.js';
import { runMigrations } from '../../data/db/migrate.js';

const __robinTestHome = __robinJoin(
  __robinTmpdir(),
  `robin-test-${process.pid}-${Math.random().toString(36).slice(2)}`,
);
__robinMkdirSync(__robinTestHome, { recursive: true });
process.env.ROBIN_HOME = __robinTestHome;
await __robinWriteConfig({ embedder_profile: 'mxbai-1024' });

async function fresh() {
  const db = await connect({ engine: 'mem://' });
  const dir = resolve(import.meta.dirname, '../../data/db/migrations');
  await runMigrations(db, dir);
  return db;
}

test('aggregator is idempotent: running twice yields the same telemetry_hourly state', async () => {
  const db = await fresh();
  const hour = new Date('2026-05-11T14:00:00Z');
  for (let i = 0; i < 4; i++) {
    await db
      .query(
        surql`CREATE intuition_telemetry CONTENT {
          ts: ${new Date(hour.getTime() + i * 60_000)},
          latency_ms: ${10 * (i + 1)},
          tokens_injected: 50,
          hits: 1,
          query_chars: 30,
          meta: { from: 'intuition', mmr_path: 'cosine' }
        }`,
      )
      .collect();
  }
  const cfg = await readTelemetryConfig(db);
  await rollupHotTelemetry({
    db,
    cfg,
    nowFn: () => new Date(hour.getTime() + 65 * 60_000),
  });
  const [first] = await db
    .query(
      `SELECT count, metric_sums FROM telemetry_hourly
        WHERE faculty='intuition' AND event_kind='recall'`,
    )
    .collect();
  // Re-run: the cursor has advanced past these rows, but on re-aggregation
  // from cursor=$cutoff there should be no new rows to roll up. UPSERT
  // semantics guarantee that even if the same window is re-scanned, the
  // row state is identical.
  // Force a re-scan by resetting the cursor and running again.
  await db.query('UPSERT runtime:`telemetry.cursor` SET value = {}').collect();
  await rollupHotTelemetry({
    db,
    cfg,
    nowFn: () => new Date(hour.getTime() + 65 * 60_000),
  });
  const [second] = await db
    .query(
      `SELECT count, metric_sums FROM telemetry_hourly
        WHERE faculty='intuition' AND event_kind='recall'`,
    )
    .collect();
  assert.deepEqual(first, second);
  await close(db);
});

test('cursor advances after a successful tick; second tick stays at the same cutoff', async () => {
  const db = await fresh();
  const hour = new Date('2026-05-11T14:00:00Z');
  await db
    .query(
      surql`CREATE intuition_telemetry CONTENT {
        ts: ${hour}, latency_ms: 10, tokens_injected: 0, hits: 0, query_chars: 0,
        meta: { from: 'intuition', mmr_path: 'cosine' }
      }`,
    )
    .collect();
  const cfg = await readTelemetryConfig(db);
  const now = new Date(hour.getTime() + 65 * 60_000);
  await rollupHotTelemetry({ db, cfg, nowFn: () => now });
  const [c1] = await db.query('SELECT VALUE value FROM runtime:`telemetry.cursor`').collect();
  assert.ok(c1?.[0]?.intuition_telemetry, 'cursor populated');
  const cur1Date = new Date(c1[0].intuition_telemetry);
  // Cursor should be at most `now - cutoff_safety_seconds`.
  assert.ok(cur1Date.getTime() <= now.getTime() - 30_000);

  await rollupHotTelemetry({ db, cfg, nowFn: () => now });
  const [c2] = await db.query('SELECT VALUE value FROM runtime:`telemetry.cursor`').collect();
  const cur2Date = new Date(c2[0].intuition_telemetry);
  assert.equal(cur1Date.toISOString(), cur2Date.toISOString());
  await close(db);
});

test('cursor fallback when row is missing → uses now - cursor_fallback_window_hours', async () => {
  const db = await fresh();
  // Wipe out the cursor row entirely.
  await db.query('DELETE runtime:`telemetry.cursor`').collect();
  const cfg = await readTelemetryConfig(db);
  await rollupHotTelemetry({ db, cfg });
  const [c] = await db.query('SELECT VALUE value FROM runtime:`telemetry.cursor`').collect();
  // Row recreated, cursor populated.
  assert.ok(c?.[0]?.intuition_telemetry);
  await close(db);
});

test('pending recall_log is NOT rolled up; rolls up after evaluated_at is set', async () => {
  const db = await fresh();
  const hour = new Date('2026-05-11T14:00:00Z');
  // Seed a pending row WITHOUT evaluated_at.
  await db
    .query(
      surql`CREATE recall_log CONTENT {
        ts: ${hour},
        query: 'q1',
        k: 6,
        ranked_hits: [],
        outcome: 'pending',
        session_id: 's1',
        attribution: { mode: 'citation', used_count: 1, total: 2, dropped_hits: 0, elapsed_ms: 10 },
        meta: { from: 'intuition' }
      }`,
    )
    .collect();
  const cfg = await readTelemetryConfig(db);
  await rollupHotTelemetry({
    db,
    cfg,
    nowFn: () => new Date(hour.getTime() + 65 * 60_000),
  });
  const [r1] = await db
    .query(
      `SELECT count() AS n FROM telemetry_hourly
        WHERE event_kind='recall_attribution' GROUP ALL`,
    )
    .collect();
  assert.equal(r1?.[0]?.n ?? 0, 0);

  // Now evaluate the row.
  const evaluated = new Date(hour.getTime() + 6 * 60_000);
  await db
    .query(surql`UPDATE recall_log SET outcome='reinforced', evaluated_at=${evaluated}`)
    .collect();
  // Reset the cursor so the next tick re-scans.
  await db.query('UPSERT runtime:`telemetry.cursor` SET value = {}').collect();
  await rollupHotTelemetry({
    db,
    cfg,
    nowFn: () => new Date(hour.getTime() + 70 * 60_000),
  });
  const [r2] = await db
    .query(
      `SELECT count() AS n FROM telemetry_hourly
        WHERE event_kind='recall_attribution' GROUP ALL`,
    )
    .collect();
  assert.equal(r2?.[0]?.n ?? 0, 1);
  await close(db);
});

test('per-entry fail-soft: a missing meta_cognition_telemetry table does not block intuition rollup', async () => {
  const db = await fresh();
  // Simulate a missing source by dropping the meta_cognition_telemetry
  // table (D2 created it, but the rollup must still degrade gracefully if
  // a future migration removes it or it gets corrupted).
  await db.query('REMOVE TABLE IF EXISTS meta_cognition_telemetry').collect();
  const hour = new Date('2026-05-11T14:00:00Z');
  await db
    .query(
      surql`CREATE intuition_telemetry CONTENT {
        ts: ${hour}, latency_ms: 10, tokens_injected: 0, hits: 0, query_chars: 0,
        meta: { from: 'intuition' }
      }`,
    )
    .collect();
  const cfg = await readTelemetryConfig(db);
  const res = await rollupHotTelemetry({
    db,
    cfg,
    nowFn: () => new Date(hour.getTime() + 65 * 60_000),
  });
  assert.equal(res.per_entry.intuition_telemetry.ok, true);
  assert.equal(res.per_entry.meta_cognition_telemetry.ok, false);
  // Intuition cursor still advances even though meta_cognition failed.
  const [cur] = await db.query('SELECT VALUE value FROM runtime:`telemetry.cursor`').collect();
  assert.ok(cur?.[0]?.intuition_telemetry, 'intuition cursor advanced');
  await close(db);
});
