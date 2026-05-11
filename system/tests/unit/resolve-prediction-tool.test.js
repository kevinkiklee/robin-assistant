// tests/unit/resolve-prediction-tool.test.js
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { close, connect } from '../../data/db/client.js';
import { runMigrations } from '../../data/db/migrate.js';
import { recordPrediction } from '../../cognition/jobs/predictions.js';
import { createResolvePredictionTool } from '../../io/mcp/tools/resolve-prediction.js';
import { writeConfig as __wc } from '../../config/paths.js';

const __h = join(tmpdir(), `robin-test-${process.pid}-${Math.random().toString(36).slice(2)}`);
mkdirSync(__h, { recursive: true });
process.env.ROBIN_HOME = __h;
await __wc({ embedder_profile: 'mxbai-1024' });

async function fresh() {
  const db = await connect({ engine: 'mem://' });
  await runMigrations(db, resolve(import.meta.dirname, '../../src/schema/migrations'));
  return db;
}

// 1. Happy path: seed + resolve → {ok: true}, resolved_at set in DB
test('resolve_prediction happy path sets resolved_at', async () => {
  const db = await fresh();
  const tool = createResolvePredictionTool({ db });

  const { id } = await recordPrediction(db, {
    statement: 'The deploy will succeed',
    kind: 'outcome',
    confidence: 0.9,
  });

  const result = await tool.handler({ id, correct: true, actual_outcome: 'Deployed cleanly' });
  assert.deepEqual(result, { ok: true });

  // Verify DB row has resolved_at
  const { getPrediction } = await import('../../cognition/jobs/predictions.js');
  const row = await getPrediction(db, id);
  assert.ok(row.resolved_at, 'resolved_at should be set');
  assert.equal(row.correct, true);
  assert.equal(row.actual_outcome, 'Deployed cleanly');

  await close(db);
});

// 2. Not found: invalid id → {ok: false, reason: 'not_found'}
test('resolve_prediction not found returns not_found', async () => {
  const db = await fresh();
  const tool = createResolvePredictionTool({ db });

  const result = await tool.handler({ id: 'predictions:nonexistent', correct: false });
  assert.deepEqual(result, { ok: false, reason: 'not_found' });

  await close(db);
});

// 3. Already resolved: second resolve → {ok: false, reason: 'already_resolved'}
test('resolve_prediction already resolved returns already_resolved', async () => {
  const db = await fresh();
  const tool = createResolvePredictionTool({ db });

  const { id } = await recordPrediction(db, {
    statement: 'The meeting will run long',
    kind: 'duration',
    confidence: 0.6,
  });

  await tool.handler({ id, correct: true });
  const second = await tool.handler({ id, correct: false });
  assert.deepEqual(second, { ok: false, reason: 'already_resolved' });

  await close(db);
});
