// tests/unit/list-open-predictions-tool.test.js
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { close, connect } from '../../data/db/client.js';
import { runMigrations } from '../../data/db/migrate.js';
import { recordPrediction, resolvePrediction } from '../../cognition/jobs/predictions.js';
import { createListOpenPredictionsTool } from '../../io/mcp/tools/list-open-predictions.js';
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

// 1. Empty DB → {predictions: []}
test('list_open_predictions returns empty array on empty DB', async () => {
  const db = await fresh();
  const tool = createListOpenPredictionsTool({ db });
  const result = await tool.handler({});
  assert.deepEqual(result, { predictions: [] });
  await close(db);
});

// 2. Seed 2 open + 1 resolved → returns only the 2 open
test('list_open_predictions excludes resolved predictions', async () => {
  const db = await fresh();
  const tool = createListOpenPredictionsTool({ db });

  await recordPrediction(db, {
    statement: 'Open prediction A',
    kind: 'duration',
    confidence: 0.8,
  });
  await recordPrediction(db, {
    statement: 'Open prediction B',
    kind: 'preference_guess',
    confidence: 0.6,
  });
  const { id: idResolved } = await recordPrediction(db, {
    statement: 'Resolved prediction',
    kind: 'fact_recall',
    confidence: 0.9,
  });
  await resolvePrediction(db, { id: idResolved, correct: true });

  const result = await tool.handler({});
  assert.equal(result.predictions.length, 2, 'should return 2 open predictions');

  // Verify projected fields present, resolved fields absent
  for (const p of result.predictions) {
    assert.ok('id' in p, 'id should be present');
    assert.ok('statement' in p, 'statement should be present');
    assert.ok('kind' in p, 'kind should be present');
    assert.ok('confidence' in p, 'confidence should be present');
    assert.ok('predicted_at' in p, 'predicted_at should be present');
    assert.ok('expected_resolution_at' in p, 'expected_resolution_at should be present');
    assert.ok(!('resolved_at' in p), 'resolved_at should be absent');
    assert.ok(!('correct' in p), 'correct should be absent');
    assert.ok(!('actual_outcome' in p), 'actual_outcome should be absent');
  }

  // Verify none of the returned ids match the resolved one
  const ids = result.predictions.map((p) => p.id);
  assert.ok(!ids.includes(idResolved), 'resolved id should not appear');

  await close(db);
});

// 3. kind filter → seed 2 different kinds → returns only matching kind
test('list_open_predictions filters by kind', async () => {
  const db = await fresh();
  const tool = createListOpenPredictionsTool({ db });

  await recordPrediction(db, {
    statement: 'Duration prediction',
    kind: 'duration',
    confidence: 0.75,
  });
  await recordPrediction(db, {
    statement: 'Preference prediction',
    kind: 'preference_guess',
    confidence: 0.5,
  });

  const result = await tool.handler({ kind: 'duration' });
  assert.equal(result.predictions.length, 1, 'should return 1 prediction matching kind');
  assert.equal(result.predictions[0].kind, 'duration');
  assert.equal(result.predictions[0].statement, 'Duration prediction');

  await close(db);
});
