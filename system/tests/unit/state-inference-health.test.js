import assert from 'node:assert/strict';
import { mkdirSync as __mk } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { writeConfig } from '../../config/paths.js';
import { close, connect } from '../../data/db/client.js';
import { runMigrations } from '../../data/db/migrate.js';
import { rollupStateInference } from '../../runtime/cli/health.js';

const HOME = join(tmpdir(), `robin-h-${process.pid}-${Math.random().toString(36).slice(2)}`);
__mk(HOME, { recursive: true });
process.env.ROBIN_HOME = HOME;
await writeConfig({ embedder_profile: 'mxbai-1024' });

async function fresh() {
  const db = await connect({ engine: 'mem://' });
  await runMigrations(db, resolve(import.meta.dirname, '../../data/db/migrations'));
  return db;
}

test('rollupStateInference: 0 errors → ok', async () => {
  const db = await fresh();
  const r = await rollupStateInference(db);
  assert.equal(r.status, 'ok');
  await close(db);
});

test('rollupStateInference: ≥1 error in last 1h → warn', async () => {
  const db = await fresh();
  await db
    .query(`CREATE state_inference_telemetry CONTENT { source: 'x', outcome: 'error' }`)
    .collect();
  const r = await rollupStateInference(db);
  assert.equal(r.status, 'warn');
  await close(db);
});

test('rollupStateInference: ≥3 errors in last 1h → fail', async () => {
  const db = await fresh();
  for (let i = 0; i < 3; i++) {
    await db
      .query(`CREATE state_inference_telemetry CONTENT { source: 'x', outcome: 'error' }`)
      .collect();
  }
  const r = await rollupStateInference(db);
  assert.equal(r.status, 'fail');
  await close(db);
});
