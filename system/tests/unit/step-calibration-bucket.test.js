// step-calibration-bucket.test.js — DB-touching tests for step-calibration-bucket.
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { BoundQuery } from 'surrealdb';
import {
  dreamStepCalibrationBucket,
  runCalibrationBucket,
} from '../../cognition/dream/step-calibration-bucket.js';
import { writeConfig as __wc } from '../../config/paths.js';
import { close, connect } from '../../data/db/client.js';
import { runMigrations } from '../../data/db/migrate.js';
import { setSelfImprovementV2Enabled } from '../../runtime/config/self-improvement-v2.js';

// Setup test home dir once (shared across all tests in this file).
const __h = join(tmpdir(), `robin-test-${process.pid}-${Math.random().toString(36).slice(2)}`);
mkdirSync(__h, { recursive: true });
process.env.ROBIN_HOME = __h;
await __wc({ embedder_profile: 'mxbai-1024' });

const MIGRATIONS_DIR = resolve(import.meta.dirname, '../../data/db/migrations');

async function fresh() {
  const db = await connect({ engine: 'mem://' });
  await runMigrations(db, MIGRATIONS_DIR);
  return db;
}

/**
 * Seed `n` resolved predictions of a given statement_kind.
 * Confidences are spread evenly across [0, 1]; half are correct.
 */
async function seedPredictions(db, { statement_kind, n }) {
  for (let i = 0; i < n; i++) {
    const confidence = n === 1 ? 0.5 : i / (n - 1);
    const correct = i % 2 === 0;
    const fields = {
      kind: 'prediction',
      content: `prediction ${i} for ${statement_kind}`,
      derived_by: 'manual',
      scope: 'global',
      tags: [],
      confidence,
      meta: {
        statement_kind,
        resolved_at: new Date(),
        correct,
      },
    };
    await db.query(new BoundQuery('CREATE memos CONTENT $fields', { fields })).collect();
  }
}

// ---------------------------------------------------------------------------
// Flag-off path
// ---------------------------------------------------------------------------

test('dreamStepCalibrationBucket: flag off → skipped v2_not_enabled', async () => {
  const db = await fresh();
  // Flag is off by default (no UPSERT).
  const r = await dreamStepCalibrationBucket(db);
  assert.deepEqual(r, { skipped: true, reason: 'v2_not_enabled', step: 'calibrationBucket' });
  await close(db);
});

// ---------------------------------------------------------------------------
// Bootstrap path — N=10 → 3 coarse buckets
// ---------------------------------------------------------------------------

test('bootstrap: N=10 resolved event_timing preds → 3 bootstrap buckets written', async () => {
  const db = await fresh();
  await setSelfImprovementV2Enabled(db, true);
  await seedPredictions(db, { statement_kind: 'event_timing', n: 10 });

  const r = await runCalibrationBucket(db);

  assert.equal(r.skipped, false);
  assert.equal(r.kinds_processed, 1);
  assert.equal(r.step, 'calibrationBucket');

  // Exactly 3 bootstrap buckets (low, mid, high) should be written.
  assert.equal(r.buckets_written, 3, `expected 3 bootstrap buckets, got ${r.buckets_written}`);
  assert.deepEqual(r.bucketing_modes, { bootstrap: 1, mature: 0 });

  // Verify the memos were actually written.
  const [cbRows] = await db
    .query(`SELECT meta FROM memos WHERE kind = 'confidence_band'`)
    .collect();
  assert.equal(cbRows.length, 3, 'should have 3 confidence_band memos in DB');

  const modes = cbRows.map((r) => r.meta?.bucketing_mode);
  assert.ok(
    modes.every((m) => m === 'bootstrap'),
    'all memos should have bucketing_mode=bootstrap',
  );

  await close(db);
});

// ---------------------------------------------------------------------------
// Mature path — N=35 → 10 fine-grained buckets, old bootstrap rows gone
// ---------------------------------------------------------------------------

test('mature: N=35 resolved event_timing preds → mature buckets, old bootstrap rows gone', async () => {
  const db = await fresh();
  await setSelfImprovementV2Enabled(db, true);

  // First run: seed 10 → bootstrap.
  await seedPredictions(db, { statement_kind: 'event_timing', n: 10 });
  const r1 = await runCalibrationBucket(db);
  assert.equal(r1.buckets_written, 3, 'first run: 3 bootstrap buckets');
  assert.deepEqual(r1.bucketing_modes, { bootstrap: 1, mature: 0 });

  // Add 25 more to cross the n=30 threshold (total = 35).
  await seedPredictions(db, { statement_kind: 'event_timing', n: 25 });
  const r2 = await runCalibrationBucket(db);
  assert.equal(r2.skipped, false);
  assert.equal(r2.kinds_processed, 1);
  // Mature: up to 10 buckets (depends on spread; with 35 evenly spread we get ≤10).
  assert.ok(
    r2.buckets_written >= 1 && r2.buckets_written <= 10,
    `buckets_written=${r2.buckets_written} out of expected range`,
  );
  assert.deepEqual(r2.bucketing_modes, { bootstrap: 0, mature: 1 });

  // Old bootstrap rows must be gone — only mature rows remain.
  const [cbRows] = await db
    .query(`SELECT meta FROM memos WHERE kind = 'confidence_band'`)
    .collect();
  const bootstrapRows = cbRows.filter((r) => r.meta?.bucketing_mode === 'bootstrap');
  assert.equal(bootstrapRows.length, 0, 'bootstrap rows should have been deleted');
  const matureRows = cbRows.filter((r) => r.meta?.bucketing_mode === 'mature');
  assert.ok(matureRows.length > 0, 'mature rows should be present');

  await close(db);
});

// ---------------------------------------------------------------------------
// kind='other' predictions excluded
// ---------------------------------------------------------------------------

test("kind='other' predictions are excluded from confidence_band buckets", async () => {
  const db = await fresh();
  await setSelfImprovementV2Enabled(db, true);

  // Seed 'other' predictions only.
  for (let i = 0; i < 10; i++) {
    const fields = {
      kind: 'prediction',
      content: `other prediction ${i}`,
      derived_by: 'manual',
      scope: 'global',
      tags: [],
      confidence: 0.5,
      meta: { statement_kind: 'other', resolved_at: new Date(), correct: true },
    };
    await db.query(new BoundQuery('CREATE memos CONTENT $fields', { fields })).collect();
  }

  const r = await runCalibrationBucket(db);
  assert.equal(r.kinds_processed, 0, "kind='other' should produce 0 kinds_processed");
  assert.equal(r.buckets_written, 0);

  const [cbRows] = await db.query(`SELECT id FROM memos WHERE kind = 'confidence_band'`).collect();
  assert.equal(cbRows.length, 0, 'no confidence_band memos should be written for other');

  await close(db);
});

// ---------------------------------------------------------------------------
// Multiple kinds processed in one run
// ---------------------------------------------------------------------------

test('two kinds both get their own buckets written', async () => {
  const db = await fresh();
  await setSelfImprovementV2Enabled(db, true);

  await seedPredictions(db, { statement_kind: 'event_timing', n: 5 });
  await seedPredictions(db, { statement_kind: 'duration', n: 5 });

  const r = await runCalibrationBucket(db);
  assert.equal(r.kinds_processed, 2);
  assert.ok(r.buckets_written >= 2, 'at least 2 buckets total');

  const [cbRows] = await db
    .query(`SELECT meta FROM memos WHERE kind = 'confidence_band'`)
    .collect();
  const kinds = new Set(cbRows.map((r) => r.meta?.statement_kind));
  assert.ok(kinds.has('event_timing'), 'event_timing buckets should exist');
  assert.ok(kinds.has('duration'), 'duration buckets should exist');

  await close(db);
});

// ---------------------------------------------------------------------------
// No predictions → zero output
// ---------------------------------------------------------------------------

test('no resolved predictions → 0 kinds_processed, 0 buckets_written', async () => {
  const db = await fresh();
  await setSelfImprovementV2Enabled(db, true);

  const r = await runCalibrationBucket(db);
  assert.equal(r.kinds_processed, 0);
  assert.equal(r.buckets_written, 0);
  assert.deepEqual(r.bucketing_modes, { bootstrap: 0, mature: 0 });

  await close(db);
});

// ---------------------------------------------------------------------------
// Laplace accuracy fields on written memos
// ---------------------------------------------------------------------------

test('written confidence_band memos contain accuracy and raw_accuracy fields', async () => {
  const db = await fresh();
  await setSelfImprovementV2Enabled(db, true);

  // 3 predictions all correct in mid bucket.
  for (let i = 0; i < 3; i++) {
    const fields = {
      kind: 'prediction',
      content: `mid prediction ${i}`,
      derived_by: 'manual',
      scope: 'global',
      tags: [],
      confidence: 0.5,
      meta: { statement_kind: 'fact_recall', resolved_at: new Date(), correct: true },
    };
    await db.query(new BoundQuery('CREATE memos CONTENT $fields', { fields })).collect();
  }

  await runCalibrationBucket(db);

  const [cbRows] = await db
    .query(
      `SELECT meta FROM memos WHERE kind = 'confidence_band' AND meta.statement_kind = 'fact_recall'`,
    )
    .collect();
  assert.equal(cbRows.length, 1, 'one bucket for fact_recall (all in mid)');

  const m = cbRows[0].meta;
  assert.equal(m.n, 3);
  assert.equal(m.correct, 3);
  // Laplace: (3+1)/(3+2) = 4/5 = 0.8
  assert.ok(Math.abs(m.accuracy - 4 / 5) < 1e-9, `accuracy should be 0.8, got ${m.accuracy}`);
  // raw: 3/3 = 1.0
  assert.ok(
    Math.abs(m.raw_accuracy - 1.0) < 1e-9,
    `raw_accuracy should be 1.0, got ${m.raw_accuracy}`,
  );
  assert.ok(m.last_recomputed_at, 'last_recomputed_at should be set');

  await close(db);
});
