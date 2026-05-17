// tests/unit/predict-tool.test.js
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { getPrediction } from '../../cognition/jobs/predictions.js';
import { writeConfig as __wc } from '../../config/paths.js';
import { close, connect } from '../../data/db/client.js';
import { runMigrations } from '../../data/db/migrate.js';
import { createPredictTool } from '../../io/mcp/tools/predict.js';

const __h = join(tmpdir(), `robin-test-${process.pid}-${Math.random().toString(36).slice(2)}`);
mkdirSync(__h, { recursive: true });
process.env.ROBIN_HOME = __h;
await __wc({ embedder_profile: 'mxbai-1024' });

async function fresh() {
  const db = await connect({ engine: 'mem://' });
  await runMigrations(db, resolve(import.meta.dirname, '../../data/db/migrations'));
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
  assert.match(result.id, /^memos:/);

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

// 4. Embedder dim mismatch: with no embedder injected the mock falls back to
// 1024-d; under a 3072-d active profile the embedding insert fails. The memo
// row must still be created and the tool must return {ok: true}. Regression
// against the silent-write-failure bug where predict() was throwing
// InternalError for every call on Kevin's gemini-3072 instance.
test('predict tool succeeds when embedder mismatch crashes the embedding write', async () => {
  // Build a fresh DB but flip the active profile to 3072-d so the mock
  // 1024-d embedder triggers a vector::len constraint violation.
  const db = await connect({ engine: 'mem://' });
  await runMigrations(db, resolve(import.meta.dirname, '../../data/db/migrations'));
  await db
    .query(
      "UPSERT runtime:embedder CONTENT { value: { profile: 'gemini-3072', active_profile: 'gemini-3072' } }",
    )
    .collect();
  await db
    .query(`
    DEFINE TABLE embeddings_gemini_3072_memos SCHEMAFULL TYPE NORMAL;
    DEFINE FIELD record ON embeddings_gemini_3072_memos TYPE record<memos>;
    DEFINE FIELD vector ON embeddings_gemini_3072_memos TYPE array<number> ASSERT array::len($value) = 3072;
    DEFINE FIELD ts ON embeddings_gemini_3072_memos TYPE datetime DEFAULT time::now();
  `)
    .collect();

  const tool = createPredictTool({ db });
  const result = await tool.handler({
    statement: 'mismatch should not poison the write path',
    kind: 'duration',
    confidence: 0.6,
  });
  assert.equal(result.ok, true);
  assert.match(result.id, /^memos:/);

  const row = await getPrediction(db, result.id);
  assert.ok(row, 'memo row must persist even when embedding fails');
  assert.equal(row.confidence, 0.6);

  await close(db);
});
