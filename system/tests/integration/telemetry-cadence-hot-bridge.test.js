// Integration tests for the cadence_telemetry hot-step bridge (§3.2):
// `belief.*` and `dream.*` rows are rolled up under faculty='belief' and
// faculty='dream'; everything else stays raw.

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

async function seedCadenceRow(db, ts, step, success = true) {
  await db
    .query(
      surql`CREATE cadence_telemetry CONTENT {
        ts: ${ts},
        step: ${step},
        success: ${success},
        duration_ms: 30,
        tokens_in: 200,
        tokens_out: 40
      }`,
    )
    .collect();
}

test('cadence hot-step bridge: belief.call + dream.gather → rolled up; state_inference stays raw', async () => {
  const db = await fresh();
  const hour = new Date('2026-05-11T14:00:00Z');
  for (let i = 0; i < 3; i++) await seedCadenceRow(db, hour, 'belief.call');
  for (let i = 0; i < 5; i++) await seedCadenceRow(db, hour, 'dream.gather');
  for (let i = 0; i < 2; i++) await seedCadenceRow(db, hour, 'state_inference');

  const cfg = await readTelemetryConfig(db);
  await rollupHotTelemetry({
    db,
    cfg,
    nowFn: () => new Date(hour.getTime() + 65 * 60_000),
  });

  const [rows] = await db
    .query('SELECT faculty, event_kind, count FROM telemetry_hourly ORDER BY faculty, event_kind')
    .collect();
  const belief = rows.find((r) => r.faculty === 'belief' && r.event_kind === 'call');
  const dream = rows.find((r) => r.faculty === 'dream' && r.event_kind === 'gather');
  assert.ok(belief, 'belief.call rollup row');
  assert.ok(dream, 'dream.gather rollup row');
  assert.equal(belief.count, 3);
  assert.equal(dream.count, 5);
  // state_inference rows are NOT rolled up.
  const stateRows = rows.filter((r) => r.faculty === 'state_inference');
  assert.equal(stateRows.length, 0);
  await close(db);
});

test('cadence hot-step bridge: cadence_hot_steps config drives the prefix match', async () => {
  const db = await fresh();
  const hour = new Date('2026-05-11T14:00:00Z');
  // Update config to include a new hot prefix.
  await db
    .query(
      `UPDATE runtime:\`telemetry.config\` SET value.cadence_hot_steps = ['belief.', 'dream.', 'foo.']`,
    )
    .collect();
  await seedCadenceRow(db, hour, 'foo.bar');
  await seedCadenceRow(db, hour, 'baz.qux'); // NOT in hot prefix list
  const cfg = await readTelemetryConfig(db);
  await rollupHotTelemetry({
    db,
    cfg,
    nowFn: () => new Date(hour.getTime() + 65 * 60_000),
  });
  const [rows] = await db
    .query("SELECT faculty, event_kind FROM telemetry_hourly WHERE faculty='foo'")
    .collect();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].event_kind, 'bar');
  // baz.qux is NOT rolled up.
  const [bazRows] = await db
    .query("SELECT count() AS n FROM telemetry_hourly WHERE faculty='baz' GROUP ALL")
    .collect();
  assert.equal(bazRows?.[0]?.n ?? 0, 0);
  await close(db);
});

test('cadence hot-step bridge: success=true vs success=false split into separate dimensions', async () => {
  const db = await fresh();
  const hour = new Date('2026-05-11T14:00:00Z');
  await seedCadenceRow(db, hour, 'belief.call', true);
  await seedCadenceRow(db, hour, 'belief.call', true);
  await seedCadenceRow(db, hour, 'belief.call', false);
  const cfg = await readTelemetryConfig(db);
  await rollupHotTelemetry({
    db,
    cfg,
    nowFn: () => new Date(hour.getTime() + 65 * 60_000),
  });
  const [rows] = await db
    .query(
      "SELECT dimensions.success AS succ, count FROM telemetry_hourly WHERE faculty='belief' AND event_kind='call' ORDER BY succ",
    )
    .collect();
  assert.equal(rows.length, 2);
  const succRow = rows.find((r) => r.succ === true);
  const failRow = rows.find((r) => r.succ === false);
  assert.equal(succRow.count, 2);
  assert.equal(failRow.count, 1);
  await close(db);
});
