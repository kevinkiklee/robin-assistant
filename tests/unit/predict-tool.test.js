// tests/unit/predict-tool.test.js
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { close, connect } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { getPrediction } from '../../src/jobs/predictions.js';
import { createPredictTool } from '../../src/mcp/tools/predict.js';
import { writeConfig as __wc } from '../../src/runtime/config.js';

const __h = join(tmpdir(), `robin-test-${process.pid}-${Math.random().toString(36).slice(2)}`);
mkdirSync(__h, { recursive: true });
process.env.ROBIN_HOME = __h;
await __wc({ embedder_profile: 'mxbai-1024' });

async function fresh() {
  const db = await connect({ engine: 'mem://' });
  await runMigrations(db, resolve(import.meta.dirname, '../../src/schema/migrations'));
  return db;
}

// 1. Happy path: returns {ok: true, id} and row is persisted in DB
test('predict tool happy path: returns {ok: true, id} and row in DB', async () => {
  const db = await fresh();
  const tool = createPredictTool({ db });
  const result = await tool.handler({
    statement: 'This task will take about 30 minutes',
    kind: 'duration',
    confidence: 0.8,
  });
  assert.equal(result.ok, true);
  assert.equal(typeof result.id, 'string');
  assert.match(result.id, /^predictions:/);

  const row = await getPrediction(db, result.id);
  assert.ok(row, 'row should exist in DB');
  assert.equal(row.statement, 'This task will take about 30 minutes');
  assert.equal(row.kind, 'duration');
  assert.equal(row.confidence, 0.8);

  await close(db);
});

// 2. Missing required field: handler refuses with {ok: false, reason: 'missing_arg'}
test('predict tool refuses with missing_arg when required field is absent', async () => {
  const db = await fresh();
  const tool = createPredictTool({ db });

  // missing statement
  const r1 = await tool.handler({ kind: 'duration', confidence: 0.7 });
  assert.deepEqual(r1, { ok: false, reason: 'missing_arg' });

  // missing kind
  const r2 = await tool.handler({ statement: 'X will happen', confidence: 0.7 });
  assert.deepEqual(r2, { ok: false, reason: 'missing_arg' });

  // missing confidence
  const r3 = await tool.handler({ statement: 'X will happen', kind: 'event_timing' });
  assert.deepEqual(r3, { ok: false, reason: 'missing_arg' });

  await close(db);
});

// 3. Confidence out of range: handler refuses with {ok: false, reason: 'invalid_confidence'}
test('predict tool refuses with invalid_confidence when confidence is out of [0, 1]', async () => {
  const db = await fresh();
  const tool = createPredictTool({ db });

  const r1 = await tool.handler({ statement: 'X', kind: 'duration', confidence: 1.5 });
  assert.deepEqual(r1, { ok: false, reason: 'invalid_confidence' });

  const r2 = await tool.handler({ statement: 'X', kind: 'duration', confidence: -0.1 });
  assert.deepEqual(r2, { ok: false, reason: 'invalid_confidence' });

  await close(db);
});
