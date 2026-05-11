import assert from 'node:assert/strict';
import { mkdirSync as __robinMkdirSync } from 'node:fs';
import { tmpdir as __robinTmpdir } from 'node:os';
import { join as __robinJoin, resolve } from 'node:path';
import { test } from 'node:test';
import { surql } from 'surrealdb';
import { recordStepTelemetry } from '../../cognition/dream/telemetry.js';
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
  await runMigrations(db, resolve(import.meta.dirname, '../../data/db/migrations'));
  return db;
}

test('writes a success row with the cadence-consumer field shape', async () => {
  const db = await fresh();
  await recordStepTelemetry(db, 'knowledge', 42);
  const [rows] = await db
    .query(surql`SELECT step, duration_ms, success, trigger_id, tokens_in, tokens_out, error
                  FROM cadence_telemetry`)
    .collect();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].step, 'knowledge');
  assert.equal(rows[0].duration_ms, 42);
  assert.equal(rows[0].success, true);
  // option<record<dream_triggers>> with NONE projects to undefined in JS.
  assert.ok(rows[0].trigger_id === null || rows[0].trigger_id === undefined);
  assert.equal(rows[0].tokens_in, 0);
  assert.equal(rows[0].tokens_out, 0);
  assert.ok(!rows[0].error);
  await close(db);
});

test('writes a failure row when err is provided', async () => {
  const db = await fresh();
  await recordStepTelemetry(db, 'compaction', 13, new Error('boom'));
  const [rows] = await db
    .query(surql`SELECT step, success, error FROM cadence_telemetry`)
    .collect();
  assert.equal(rows[0].step, 'compaction');
  assert.equal(rows[0].success, false);
  assert.equal(rows[0].error, 'boom');
  await close(db);
});

test('forwards tokens_in / tokens_out when provided', async () => {
  const db = await fresh();
  await recordStepTelemetry(db, 'reflection', 100, null, { tokens_in: 1234, tokens_out: 56 });
  const [rows] = await db
    .query(surql`SELECT tokens_in, tokens_out FROM cadence_telemetry`)
    .collect();
  assert.equal(rows[0].tokens_in, 1234);
  assert.equal(rows[0].tokens_out, 56);
  await close(db);
});

test('does not throw on a closed/bad db handle (swallows internally)', async () => {
  const db = await fresh();
  await close(db);
  // Should not throw — telemetry failures must never abort the dream run.
  await recordStepTelemetry(db, 'arcs', 7).catch((e) => {
    throw new Error(`expected no throw, got ${e.message}`);
  });
});
