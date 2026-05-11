// Integration tests for rollupHotTelemetry — hour bucket math, metric sums,
// empty window, null dimension grouping.

import assert from 'node:assert/strict';
import { mkdirSync as __robinMkdirSync } from 'node:fs';
import { tmpdir as __robinTmpdir } from 'node:os';
import { join as __robinJoin, resolve } from 'node:path';
import { test } from 'node:test';
import { surql } from 'surrealdb';
import { writeConfig as __robinWriteConfig } from '../../config/paths.js';
import { readTelemetryConfig } from '../../cognition/telemetry/config.js';
import { rollupHotTelemetry } from '../../cognition/telemetry/rollup.js';
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

test('rollupHotTelemetry: 6 intuition_telemetry rows across 2 hours → 2 rollup rows', async () => {
  const db = await fresh();
  const h1 = new Date('2026-05-11T14:00:00Z');
  const h2 = new Date('2026-05-11T15:00:00Z');
  const data = [
    [h1, 10],
    [h1, 20],
    [h1, 30],
    [h2, 40],
    [h2, 50],
    [h2, 60],
  ];
  for (const [hour, lat] of data) {
    const ts = new Date(hour.getTime() + 60_000);
    await db
      .query(
        surql`CREATE intuition_telemetry CONTENT {
          ts: ${ts},
          latency_ms: ${lat},
          tokens_injected: 100,
          hits: 2,
          query_chars: 50,
          meta: { from: 'intuition', mmr_path: 'cosine' }
        }`,
      )
      .collect();
  }
  const cfg = await readTelemetryConfig(db);
  // Use a nowFn far enough in the future that both hours are inside the
  // cutoff window.
  await rollupHotTelemetry({
    db,
    cfg,
    nowFn: () => new Date(h2.getTime() + 65 * 60_000),
  });
  const [rows] = await db
    .query(
      `SELECT * FROM telemetry_hourly
        WHERE faculty='intuition' AND event_kind='recall'
        ORDER BY hour`,
    )
    .collect();
  assert.equal(rows.length, 2);
  // First hour aggregates: count=3, latency_ms_sum=60.
  assert.equal(rows[0].count, 3);
  assert.equal(rows[0].metric_sums.latency_ms_sum, 60);
  // Second hour: count=3, latency_ms_sum=150.
  assert.equal(rows[1].count, 3);
  assert.equal(rows[1].metric_sums.latency_ms_sum, 150);
  await close(db);
});

test('rollupHotTelemetry: metric_sums exactness (no float drift)', async () => {
  const db = await fresh();
  const hour = new Date('2026-05-11T14:00:00Z');
  for (const lat of [123, 456, 789]) {
    await db
      .query(
        surql`CREATE intuition_telemetry CONTENT {
          ts: ${hour},
          latency_ms: ${lat},
          tokens_injected: 0,
          hits: 0,
          query_chars: 0,
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
  const [rows] = await db
    .query(`SELECT metric_sums FROM telemetry_hourly WHERE faculty='intuition'`)
    .collect();
  assert.equal(rows[0].metric_sums.latency_ms_sum, 1368);
  await close(db);
});

test('rollupHotTelemetry: empty window leaves no rollup rows but advances cursors', async () => {
  const db = await fresh();
  const cfg = await readTelemetryConfig(db);
  await rollupHotTelemetry({ db, cfg });
  const [rows] = await db
    .query(`SELECT count() AS n FROM telemetry_hourly GROUP ALL`)
    .collect();
  assert.equal(rows?.[0]?.n ?? 0, 0);
  // Cursor row should now have a populated `intuition_telemetry` cursor.
  const [cur] = await db
    .query('SELECT VALUE value FROM runtime:`telemetry.cursor`')
    .collect();
  assert.ok(cur?.[0]?.intuition_telemetry, 'cursor advanced');
  await close(db);
});

test('rollupHotTelemetry: missing dimension groups into null bucket (not dropped)', async () => {
  const db = await fresh();
  const hour = new Date('2026-05-11T14:00:00Z');
  // Row with no meta.mmr_path:
  await db
    .query(
      surql`CREATE intuition_telemetry CONTENT {
        ts: ${hour},
        latency_ms: 10,
        tokens_injected: 0,
        hits: 0,
        query_chars: 0,
        meta: { from: 'intuition' }
      }`,
    )
    .collect();
  // Row with meta.mmr_path='cosine':
  await db
    .query(
      surql`CREATE intuition_telemetry CONTENT {
        ts: ${hour},
        latency_ms: 20,
        tokens_injected: 0,
        hits: 0,
        query_chars: 0,
        meta: { from: 'intuition', mmr_path: 'cosine' }
      }`,
    )
    .collect();
  const cfg = await readTelemetryConfig(db);
  await rollupHotTelemetry({
    db,
    cfg,
    nowFn: () => new Date(hour.getTime() + 65 * 60_000),
  });
  const [rows] = await db
    .query(
      `SELECT dimensions, count FROM telemetry_hourly
        WHERE faculty='intuition' AND event_kind='recall'`,
    )
    .collect();
  assert.equal(rows.length, 2);
  const nullBucket = rows.find((r) => r.dimensions.mmr_path == null);
  const cosineBucket = rows.find((r) => r.dimensions.mmr_path === 'cosine');
  assert.ok(nullBucket, 'null bucket present');
  assert.ok(cosineBucket, 'cosine bucket present');
  assert.equal(nullBucket.count, 1);
  assert.equal(cosineBucket.count, 1);
  await close(db);
});
