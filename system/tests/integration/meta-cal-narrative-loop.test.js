import assert from 'node:assert/strict';
import { mkdirSync as __mk } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { surql } from 'surrealdb';
import { _resetBeliefConfigCacheForTests } from '../../cognition/belief/config.js';
import { runMetaCalibrationNarrative } from '../../cognition/jobs/internal/meta-calibration-narrative.js';
import { writeConfig } from '../../config/paths.js';
import { close, connect } from '../../data/db/client.js';
import { runMigrations } from '../../data/db/migrate.js';
import { createStubEmbedder } from '../../data/embed/embedder.js';

const HOME = join(tmpdir(), `robin-mc-${process.pid}-${Math.random().toString(36).slice(2)}`);
__mk(HOME, { recursive: true });
process.env.ROBIN_HOME = HOME;
await writeConfig({ embedder_profile: 'mxbai-1024' });

async function fresh() {
  _resetBeliefConfigCacheForTests();
  const db = await connect({ engine: 'mem://' });
  await runMigrations(db, resolve(import.meta.dirname, '../../data/db/migrations'));
  return db;
}

async function seedResolvedPrediction(db, { domain, predicted_confidence, correct, resolved_at }) {
  return await db
    .query(
      surql`CREATE memos CONTENT {
      kind: 'prediction',
      content: ${`pred ${domain}`},
      derived_by: 'auto',
      scope: 'global',
      confidence: ${predicted_confidence},
      signal_count: 1,
      derived_at: ${resolved_at},
      decay_anchor: ${resolved_at},
      meta: {
        statement_kind: ${domain},
        resolved_at: ${resolved_at},
        correct: ${correct},
      },
    }`,
    )
    .collect();
}

test('M1 empty week: no writes, telemetry success', async () => {
  const db = await fresh();
  const e = createStubEmbedder({ dimension: 1024 });
  const r = await runMetaCalibrationNarrative({ db, embedder: e });
  assert.equal(r.wrote.length, 0);
  const [tel] = await db
    .query(surql`SELECT step, success FROM cadence_telemetry WHERE step = 'meta-cal-narrative'`)
    .collect();
  assert.ok(tel.length > 0);
  await close(db);
});

test('M2 single domain over min_samples: one memo, no rule_candidate (below threshold)', async () => {
  const db = await fresh();
  const e = createStubEmbedder({ dimension: 1024 });
  const ts = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
  // 5 well-calibrated preds: 3/5 correct = accuracy=0.6, mean_confidence=0.7 -> drift = 0.1 (below 0.15).
  for (let i = 0; i < 5; i++) {
    await seedResolvedPrediction(db, {
      domain: 'photography',
      predicted_confidence: 0.7,
      correct: i < 3,
      resolved_at: ts,
    });
  }
  const r = await runMetaCalibrationNarrative({ db, embedder: e });
  assert.equal(r.wrote.length, 1);
  assert.equal(r.rules.length, 0);
  await close(db);
});

test('M3 sustained over-confidence: prior 2 weeks at drift > 0.15 -> rule_candidate emitted', async () => {
  const db = await fresh();
  const e = createStubEmbedder({ dimension: 1024 });
  const ts = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
  // 5 over-confident preds: confidence 0.9, accuracy 2/5=0.4 -> drift = 0.5 (well above 0.15).
  for (let i = 0; i < 5; i++) {
    await seedResolvedPrediction(db, {
      domain: 'apiversions',
      predicted_confidence: 0.9,
      correct: i < 2,
      resolved_at: ts,
    });
  }
  // Seed two prior meta-narrative memos with drift > 0.15 same sign.
  for (const week of ['2026-05-03', '2026-04-26']) {
    await db
      .query(surql`CREATE memos CONTENT {
      kind: 'reasoning', content: 'prior', derived_by: 'auto', scope: 'global',
      confidence: 0.8, signal_count: 1,
      derived_at: time::now() - 7d, decay_anchor: time::now() - 7d,
      meta: {
        dimension: 'calibration', from_signal: 'meta_cognition',
        domain: 'apiversions', drift: 0.20, brier: 0.30,
        week_starting: ${week},
      },
    }`)
      .collect();
  }
  const r = await runMetaCalibrationNarrative({ db, embedder: e });
  assert.equal(r.wrote.length, 1);
  assert.equal(r.rules.length, 1, 'expected one rule_candidate');
  // Verify rule_candidates shape: kind='behavior', payload.source='meta_cognition_calibration'.
  // `meta` is NOT a declared field on the SCHEMAFULL `rule_candidates` table —
  // dimension/domain context travels INSIDE payload.
  const [rc] = await db
    .query(
      surql`SELECT kind, payload, created_at FROM rule_candidates ORDER BY created_at DESC LIMIT 1`,
    )
    .collect();
  assert.equal(rc[0].kind, 'behavior');
  assert.equal(rc[0].payload?.source, 'meta_cognition_calibration');
  assert.equal(rc[0].payload?.dimension, 'calibration');
  assert.equal(rc[0].payload?.domain, 'apiversions');
  await close(db);
});

test('M4 mixed domains: one over, one under, one too sparse -> 2 memos', async () => {
  const db = await fresh();
  const e = createStubEmbedder({ dimension: 1024 });
  const ts = new Date(Date.now() - 1 * 24 * 60 * 60 * 1000);
  // domain a: over-confident, 5 preds.
  for (let i = 0; i < 5; i++) {
    await seedResolvedPrediction(db, {
      domain: 'a',
      predicted_confidence: 0.9,
      correct: i < 2,
      resolved_at: ts,
    });
  }
  // domain b: under-confident, 5 preds.
  for (let i = 0; i < 5; i++) {
    await seedResolvedPrediction(db, {
      domain: 'b',
      predicted_confidence: 0.4,
      correct: true,
      resolved_at: ts,
    });
  }
  // domain c: only 3 preds -> skipped.
  for (let i = 0; i < 3; i++) {
    await seedResolvedPrediction(db, {
      domain: 'c',
      predicted_confidence: 0.7,
      correct: true,
      resolved_at: ts,
    });
  }
  const r = await runMetaCalibrationNarrative({ db, embedder: e });
  assert.equal(r.wrote.length, 2);
  assert.ok(r.skipped.includes('c'));
  await close(db);
});

test('M6 D2/D3 disjoint dimensions in same run (coordination)', async () => {
  const db = await fresh();
  const e = createStubEmbedder({ dimension: 1024 });
  // Seed a D2-style memo (recall_failures dimension) — sibling writer's output.
  await db
    .query(surql`CREATE memos CONTENT {
    kind: 'reasoning', content: 'recall failures summary', derived_by: 'auto', scope: 'global',
    confidence: 0.8, signal_count: 1, derived_at: time::now(), decay_anchor: time::now(),
    meta: { dimension: 'recall_failures', from_signal: 'meta_cognition' }
  }`)
    .collect();
  // Seed predictions + run D3.
  const ts = new Date(Date.now() - 24 * 60 * 60 * 1000);
  for (let i = 0; i < 5; i++) {
    await seedResolvedPrediction(db, {
      domain: 'x',
      predicted_confidence: 0.7,
      correct: i < 3,
      resolved_at: ts,
    });
  }
  await runMetaCalibrationNarrative({ db, embedder: e });
  // Verify both memos coexist with different dimensions.
  const [rows] = await db
    .query(`SELECT meta.dimension AS dim FROM memos WHERE kind = 'reasoning'`)
    .collect();
  const dims = (rows ?? []).map((r) => r.dim).sort();
  assert.deepEqual(dims, ['calibration', 'recall_failures']);
  await close(db);
});
