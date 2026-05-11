// tests/integration/predictions-roundtrip.test.js
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import {
  computeCalibration,
  getCalibration,
  setCalibration,
} from '../../cognition/jobs/predictions.js';
import { writeConfig as __wc } from '../../config/paths.js';
import { close, connect } from '../../data/db/client.js';
import { runMigrations } from '../../data/db/migrate.js';
import { createListOpenPredictionsTool } from '../../io/mcp/tools/list-open-predictions.js';
import { createPredictTool } from '../../io/mcp/tools/predict.js';
import { createResolvePredictionTool } from '../../io/mcp/tools/resolve-prediction.js';

const __h = join(tmpdir(), `robin-test-${process.pid}-${Math.random().toString(36).slice(2)}`);
mkdirSync(__h, { recursive: true });
process.env.ROBIN_HOME = __h;
await __wc({ embedder_profile: 'mxbai-1024' });

test('predictions roundtrip: predict → resolve → calibrate', async () => {
  const db = await connect({ engine: 'mem://' });
  await runMigrations(db, resolve(import.meta.dirname, '../../data/db/migrations'));

  const predict = createPredictTool({ db });
  const resolveT = createResolvePredictionTool({ db });
  const listOpen = createListOpenPredictionsTool({ db });

  // Seed 3 predictions via the MCP tool
  const p1 = await predict.handler({
    statement: 'this takes 30min',
    kind: 'duration',
    confidence: 0.7,
  });
  const p2 = await predict.handler({
    statement: 'user prefers terse',
    kind: 'preference_guess',
    confidence: 0.6,
  });
  const p3 = await predict.handler({
    statement: 'meeting at 3pm',
    kind: 'event_timing',
    confidence: 0.9,
  });
  assert.ok(p1.id);
  assert.ok(p2.id);
  assert.ok(p3.id);

  // list_open should return all 3
  const open1 = await listOpen.handler({});
  assert.equal(open1.predictions.length, 3);

  // Resolve p1 correct, p2 incorrect, leave p3 open
  await resolveT.handler({ id: p1.id, correct: true, actual_outcome: 'took 28min' });
  await resolveT.handler({ id: p2.id, correct: false, actual_outcome: 'they wanted verbose' });

  // list_open should now have 1
  const open2 = await listOpen.handler({});
  assert.equal(open2.predictions.length, 1);
  assert.equal(open2.predictions[0].kind, 'event_timing');

  // Compute calibration
  const c = await computeCalibration(db);
  assert.equal(c.total_resolved, 2);
  assert.equal(c.total_open, 1);
  assert.equal(c.by_kind.duration.resolved, 1);
  assert.equal(c.by_kind.duration.correct, 1);
  assert.equal(c.by_kind.duration.accuracy, 1.0);
  assert.equal(c.by_kind.preference_guess.resolved, 1);
  assert.equal(c.by_kind.preference_guess.correct, 0);
  assert.equal(c.by_kind.preference_guess.accuracy, 0);
  // event_timing is still open → not in by_kind
  assert.equal(c.by_kind.event_timing, undefined);

  // Persist + reread
  await setCalibration(db, c);
  const stored = await getCalibration(db);
  assert.equal(stored.total_resolved, 2);
  assert.equal(stored.by_kind.duration.accuracy, 1.0);

  await close(db);
});
