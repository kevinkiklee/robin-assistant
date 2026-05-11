// tests/unit/predictions-helpers.test.js
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { close, connect } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import {
  computeCalibration,
  getCalibration,
  getPrediction,
  listOpenPredictions,
  recordPrediction,
  resolvePrediction,
  setCalibration,
} from '../../src/jobs/predictions.js';
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

// 1. recordPrediction creates row, returns string id
test('recordPrediction creates row and returns string id', async () => {
  const db = await fresh();
  const result = await recordPrediction(db, {
    statement: 'This task will take 30 minutes',
    kind: 'duration',
    confidence: 0.8,
  });
  assert.equal(typeof result.id, 'string');
  assert.match(result.id, /^predictions:/);
  await close(db);
});

// 2. getPrediction reads back the row
test('getPrediction reads the row back', async () => {
  const db = await fresh();
  const { id } = await recordPrediction(db, {
    statement: 'You prefer terse output',
    kind: 'preference_guess',
    confidence: 0.7,
  });
  const row = await getPrediction(db, id);
  assert.ok(row, 'row should exist');
  assert.equal(row.statement, 'You prefer terse output');
  assert.equal(row.kind, 'preference_guess');
  assert.equal(row.confidence, 0.7);
  await close(db);
});

// 3. recordPrediction with expected_resolution_at persists the date
test('recordPrediction persists expected_resolution_at', async () => {
  const db = await fresh();
  const future = new Date(Date.now() + 7 * 86_400_000).toISOString();
  const { id } = await recordPrediction(db, {
    statement: 'Meeting will be cancelled',
    kind: 'event_timing',
    confidence: 0.6,
    expected_resolution_at: future,
  });
  const row = await getPrediction(db, id);
  assert.ok(row.expected_resolution_at, 'expected_resolution_at should be set');
  await close(db);
});

// 4. resolvePrediction flips fields (resolved_at, correct, actual_outcome)
test('resolvePrediction flips resolved_at, correct, actual_outcome', async () => {
  const db = await fresh();
  const { id } = await recordPrediction(db, {
    statement: 'Build will finish in 10 minutes',
    kind: 'duration',
    confidence: 0.9,
  });
  const result = await resolvePrediction(db, {
    id,
    correct: true,
    actual_outcome: 'Finished in 9 minutes',
  });
  assert.deepEqual(result, { ok: true });
  const row = await getPrediction(db, id);
  assert.ok(row.resolved_at, 'resolved_at should be set');
  assert.equal(row.correct, true);
  assert.equal(row.actual_outcome, 'Finished in 9 minutes');
  await close(db);
});

// 5. resolvePrediction on already-resolved returns {ok:false, reason:'already_resolved'}
test('resolvePrediction on already-resolved returns already_resolved', async () => {
  const db = await fresh();
  const { id } = await recordPrediction(db, {
    statement: 'The deploy will succeed',
    kind: 'fact_recall',
    confidence: 0.85,
  });
  await resolvePrediction(db, { id, correct: true });
  const result = await resolvePrediction(db, { id, correct: false });
  assert.deepEqual(result, { ok: false, reason: 'already_resolved' });
  await close(db);
});

// 6. resolvePrediction on unknown id returns {ok:false, reason:'not_found'}
test('resolvePrediction on unknown id returns not_found', async () => {
  const db = await fresh();
  const result = await resolvePrediction(db, {
    id: 'predictions:nonexistent',
    correct: true,
  });
  assert.deepEqual(result, { ok: false, reason: 'not_found' });
  await close(db);
});

// 7. listOpenPredictions returns only unresolved; kind filter narrows; older_than_days filter narrows
test('listOpenPredictions filters correctly', async () => {
  const db = await fresh();
  // Create 3 predictions: 2 duration, 1 preference_guess
  const { id: id1 } = await recordPrediction(db, {
    statement: 'Task A takes 1h',
    kind: 'duration',
    confidence: 0.8,
  });
  await recordPrediction(db, {
    statement: 'Task B takes 2h',
    kind: 'duration',
    confidence: 0.7,
  });
  await recordPrediction(db, {
    statement: 'Prefers bullets',
    kind: 'preference_guess',
    confidence: 0.6,
  });
  // Resolve id1
  await resolvePrediction(db, { id: id1, correct: false });

  // All open: should be 2 (id2 + id3)
  const allOpen = await listOpenPredictions(db);
  assert.equal(allOpen.length, 2);

  // Filter by kind=duration: should be 1 (id2)
  const durationOpen = await listOpenPredictions(db, { kind: 'duration' });
  assert.equal(durationOpen.length, 1);
  assert.equal(durationOpen[0].kind, 'duration');

  // older_than_days=365: none are older than 365 days, should return 0
  const oldOpen = await listOpenPredictions(db, { older_than_days: 365 });
  assert.equal(oldOpen.length, 0);

  await close(db);
});

// 8. computeCalibration math
test('computeCalibration math: 2 correct + 1 incorrect for duration, another kind tracked separately', async () => {
  const db = await fresh();
  // duration: 2 correct, 1 incorrect => accuracy ~0.667
  const { id: d1 } = await recordPrediction(db, {
    statement: 'D1',
    kind: 'duration',
    confidence: 0.8,
  });
  const { id: d2 } = await recordPrediction(db, {
    statement: 'D2',
    kind: 'duration',
    confidence: 0.7,
  });
  const { id: d3 } = await recordPrediction(db, {
    statement: 'D3',
    kind: 'duration',
    confidence: 0.6,
  });
  // fact_recall: 1 correct
  const { id: f1 } = await recordPrediction(db, {
    statement: 'F1',
    kind: 'fact_recall',
    confidence: 0.9,
  });
  // 1 open (unresolved)
  await recordPrediction(db, { statement: 'Open', kind: 'preference_guess', confidence: 0.5 });

  await resolvePrediction(db, { id: d1, correct: true });
  await resolvePrediction(db, { id: d2, correct: true });
  await resolvePrediction(db, { id: d3, correct: false });
  await resolvePrediction(db, { id: f1, correct: true });

  const cal = await computeCalibration(db);

  assert.ok(cal.by_kind.duration, 'duration kind should exist');
  assert.equal(cal.by_kind.duration.resolved, 3);
  assert.equal(cal.by_kind.duration.correct, 2);
  assert.ok(
    Math.abs(cal.by_kind.duration.accuracy - 2 / 3) < 0.001,
    `Expected accuracy ~0.667, got ${cal.by_kind.duration.accuracy}`,
  );

  assert.ok(cal.by_kind.fact_recall, 'fact_recall kind should exist');
  assert.equal(cal.by_kind.fact_recall.resolved, 1);
  assert.equal(cal.by_kind.fact_recall.correct, 1);
  assert.equal(cal.by_kind.fact_recall.accuracy, 1);

  assert.equal(cal.total_open, 1);
  assert.equal(cal.total_resolved, 4);
  assert.ok(cal.last_computed_at instanceof Date);

  await close(db);
});

// 9. getCalibration returns null when unset; returns shape after setCalibration
test('getCalibration returns null when unset; returns shape after setCalibration', async () => {
  const db = await fresh();
  const nullResult = await getCalibration(db);
  assert.equal(nullResult, null);

  const calibration = {
    by_kind: { duration: { resolved: 3, correct: 2, accuracy: 0.667 } },
    total_open: 1,
    total_resolved: 3,
    last_computed_at: new Date(),
  };
  await setCalibration(db, calibration);

  const stored = await getCalibration(db);
  assert.ok(stored, 'calibration should be set');
  assert.ok(stored.by_kind, 'by_kind should exist');
  assert.ok(stored.by_kind.duration, 'duration kind should exist');
  assert.equal(stored.by_kind.duration.resolved, 3);
  assert.equal(stored.total_open, 1);
  assert.equal(stored.total_resolved, 3);

  await close(db);
});
