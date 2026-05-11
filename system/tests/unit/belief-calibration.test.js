import assert from 'node:assert/strict';
import { mkdirSync as __mk } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import {
  aggregateAcrossKinds,
  calibrateAdjust,
  readCalibration,
} from '../../cognition/belief/calibration.js';
import { writeConfig } from '../../config/paths.js';
import { close, connect } from '../../data/db/client.js';
import { runMigrations } from '../../data/db/migrate.js';

const HOME = join(tmpdir(), `robin-cal-${process.pid}-${Math.random().toString(36).slice(2)}`);
__mk(HOME, { recursive: true });
process.env.ROBIN_HOME = HOME;
await writeConfig({ embedder_profile: 'mxbai-1024' });

const CFG = {
  min_calibration_samples: 5,
  calibration_adjustment_gain: 1.0,
  expected_accuracy_baseline: 0.75,
};

async function fresh() {
  const db = await connect({ engine: 'mem://' });
  await runMigrations(db, resolve(import.meta.dirname, '../../data/db/migrations'));
  return db;
}

test('calibrateAdjust: drift>0 (over-confident) pushes agg DOWN', () => {
  // agg=0.75, drift=0.15, gain=1.0 → adjusted = 0.60.
  assert.ok(Math.abs(calibrateAdjust(0.75, { drift: 0.15, samples_count: 10 }, CFG) - 0.6) < 1e-9);
});

test('calibrateAdjust: drift<0 (under-confident) pushes agg UP', () => {
  // agg=0.75, drift=-0.10, gain=1.0 → adjusted = 0.85.
  assert.ok(Math.abs(calibrateAdjust(0.75, { drift: -0.1, samples_count: 10 }, CFG) - 0.85) < 1e-9);
});

test('calibrateAdjust: clamps result to [0, 1]', () => {
  assert.equal(calibrateAdjust(0.5, { drift: 0.9, samples_count: 10 }, CFG), 0);
  assert.equal(calibrateAdjust(0.5, { drift: -0.9, samples_count: 10 }, CFG), 1);
});

test('calibrateAdjust: no calibration → returns agg unchanged', () => {
  assert.equal(calibrateAdjust(0.75, null, CFG), 0.75);
});

test('calibrateAdjust: samples_count < min → returns agg unchanged', () => {
  assert.equal(calibrateAdjust(0.75, { drift: 0.2, samples_count: 3 }, CFG), 0.75);
});

test('calibrateAdjust: NaN drift → returns agg unchanged', () => {
  assert.equal(calibrateAdjust(0.75, { drift: NaN, samples_count: 10 }, CFG), 0.75);
});

test('readCalibration: persona missing → returns null', async () => {
  const db = await fresh();
  const r = await readCalibration(db, 'photography', CFG);
  assert.equal(r, null);
  await close(db);
});

test('readCalibration: domain matches statement_kind, case-insensitive', async () => {
  const db = await fresh();
  await db
    .query(`UPSERT persona:singleton SET calibration = {
    by_kind: { Photography: { resolved: 10, correct: 6, accuracy: 0.6 } },
    last_computed_at: '2026-05-10T05:02:11Z',
  }`)
    .collect();
  const r = await readCalibration(db, 'photography', CFG);
  assert.equal(r.domain, 'Photography');
  assert.equal(r.samples_count, 10);
  // drift = 0.75 - 0.6 = 0.15.
  assert.ok(Math.abs(r.drift - 0.15) < 1e-9);
  assert.equal(r.source, 'persona.calibration');
  await close(db);
});

test('readCalibration: domain unmatched → aggregateAcrossKinds', async () => {
  const db = await fresh();
  await db
    .query(`UPSERT persona:singleton SET calibration = {
    by_kind: {
      prediction: { resolved: 8, correct: 6, accuracy: 0.75 },
      forecast:   { resolved: 4, correct: 3, accuracy: 0.75 },
    },
    last_computed_at: '2026-05-10T05:02:11Z',
  }`)
    .collect();
  const r = await readCalibration(db, 'photography', CFG);
  assert.equal(r.domain, null);
  assert.equal(r.samples_count, 12); // 8+4
  // accuracy = 9/12 = 0.75; drift = 0.75 - 0.75 = 0.
  assert.ok(Math.abs(r.drift) < 1e-9);
  await close(db);
});

test('readCalibration: meta-narrative memo override (source=meta_narrative)', async () => {
  const db = await fresh();
  await db
    .query(`UPSERT persona:singleton SET calibration = {
    by_kind: { photography: { resolved: 10, correct: 6, accuracy: 0.6 } },
    last_computed_at: '2026-05-10T05:02:11Z',
  }`)
    .collect();
  // Seed a recent meta-narrative memo for photography.
  await db
    .query(`CREATE memos CONTENT {
    kind: 'reasoning',
    content: 'Calibration drift for photography this week.',
    derived_by: 'auto',
    scope: 'global',
    confidence: 0.8,
    signal_count: 1,
    derived_at: time::now(),
    decay_anchor: time::now(),
    meta: {
      dimension: 'calibration',
      from_signal: 'meta_cognition',
      domain: 'photography',
      brier: 0.10,
      drift: -0.05,
      samples: 17,
    },
  }`)
    .collect();
  const r = await readCalibration(db, 'photography', CFG);
  assert.equal(r.source, 'meta_narrative');
  assert.equal(r.drift, -0.05);
  await close(db);
});

test('aggregateAcrossKinds: empty → null', () => {
  assert.equal(aggregateAcrossKinds({}, new Date(), CFG), null);
});

test('aggregateAcrossKinds: weighted accuracy across kinds', () => {
  const r = aggregateAcrossKinds(
    {
      a: { resolved: 10, correct: 6 },
      b: { resolved: 20, correct: 16 },
    },
    new Date(),
    CFG,
  );
  assert.equal(r.samples_count, 30);
  // accuracy = 22/30; drift = 0.75 - 22/30.
  assert.ok(Math.abs(r.accuracy - 22 / 30) < 1e-9);
  assert.ok(Math.abs(r.drift - (0.75 - 22 / 30)) < 1e-9);
  assert.equal(r.source, 'persona.calibration');
});
