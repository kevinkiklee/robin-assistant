// dream-self-improvement-stubs.test.js — Phase 1 gating + DAG sanity for v2 steps.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DREAM_DAG_DEPS } from '../../cognition/dream/dag.js';
import { byName } from '../../cognition/dream/step-registry.js';
import { dreamStepCalibrationBucket } from '../../cognition/dream/step-calibration-bucket.js';
import { dreamStepOutcomeGrading } from '../../cognition/dream/step-outcome-grading.js';
import { dreamStepPlaybookSynthesis } from '../../cognition/dream/step-playbook-synthesis.js';
import { dreamStepPredictionTaxonomy } from '../../cognition/dream/step-prediction-taxonomy.js';
import { dreamStepSelfImprovementRollup } from '../../cognition/dream/step-self-improvement-rollup.js';

// ---------------------------------------------------------------------------
// Minimal stub DB: flag off by default, override with enabledDb.
// ---------------------------------------------------------------------------
function makeDb(enabled = false) {
  return {
    query: () => ({
      collect: async () => [enabled ? [{ enabled: true }] : []],
    }),
  };
}

const disabledDb = makeDb(false);
const enabledDb = makeDb(true);

// ---------------------------------------------------------------------------
// flag=false → v2_not_enabled
// ---------------------------------------------------------------------------

test('outcomeGrading: flag off → skipped v2_not_enabled', async () => {
  const r = await dreamStepOutcomeGrading(disabledDb, null, null, {});
  assert.deepEqual(r, { skipped: true, reason: 'v2_not_enabled', step: 'outcomeGrading' });
});

test('playbookSynthesis: flag off → skipped v2_not_enabled', async () => {
  const r = await dreamStepPlaybookSynthesis(disabledDb, null, {});
  assert.deepEqual(r, { skipped: true, reason: 'v2_not_enabled', step: 'playbookSynthesis' });
});

test('calibrationBucket: flag off → skipped v2_not_enabled', async () => {
  const r = await dreamStepCalibrationBucket(disabledDb);
  assert.deepEqual(r, { skipped: true, reason: 'v2_not_enabled', step: 'calibrationBucket' });
});

test('predictionTaxonomy: flag off → skipped v2_not_enabled', async () => {
  const r = await dreamStepPredictionTaxonomy(disabledDb, null);
  assert.deepEqual(r, { skipped: true, reason: 'v2_not_enabled', step: 'predictionTaxonomy' });
});

test('selfImprovementRollup: flag off → skipped v2_not_enabled', async () => {
  const r = await dreamStepSelfImprovementRollup(disabledDb);
  assert.deepEqual(r, { skipped: true, reason: 'v2_not_enabled', step: 'selfImprovementRollup' });
});

// ---------------------------------------------------------------------------
// flag=true → phase_1_stub (Wave 3 not yet implemented)
// ---------------------------------------------------------------------------

test('outcomeGrading: flag on → real grading path (no rows → zeroes)', async () => {
  // Phase 1 stub replaced by real Haiku scorer in Wave 3.
  // enabledDb has no task_outcome memos, so the step returns immediately with zeroes.
  const r = await dreamStepOutcomeGrading(enabledDb, null, null, {});
  assert.equal(r.skipped, false);
  assert.equal(r.step, 'outcomeGrading');
  assert.equal(typeof r.graded, 'number');
});

test('playbookSynthesis: flag on → real synthesis path (stub db has no outcomes → synthesized=0)', async () => {
  // Phase 1 stub replaced by real Opus synthesis in Wave 3.
  // The stub DB returns a non-null row for every query, but outcomes have no
  // meta.task_type so they are filtered out; no eligible groups → synthesized=0.
  const r = await dreamStepPlaybookSynthesis(enabledDb, null, {});
  assert.equal(r.skipped, false, 'should not be skipped (flag is on)');
  assert.equal(r.step, 'playbookSynthesis');
  assert.equal(typeof r.synthesized, 'number');
  // No eligible task_types → zero synthesized
  assert.equal(r.synthesized, 0);
});

test('calibrationBucket: flag on → real path (stub db returns empty result set, not skipped)', async () => {
  // Step is no longer a Phase 1 stub — real math runs. The stub DB returns no
  // resolved predictions, so the step succeeds with zero kinds_processed.
  const r = await dreamStepCalibrationBucket(enabledDb);
  assert.equal(r.skipped, false);
  assert.equal(r.step, 'calibrationBucket');
  assert.equal(typeof r.kinds_processed, 'number');
  assert.equal(typeof r.buckets_written, 'number');
});

test('predictionTaxonomy: flag on → real path (stub db has no predictions, null embedder → early error)', async () => {
  // Phase 1 stub replaced by real weekly-cluster step. The stub DB returns a
  // non-null row for every query, so the predictions read yields one garbage row
  // whose content is undefined; the null embedder throws, and the step returns
  // an error shape (fail-soft). That confirms the real code path runs — it no
  // longer returns phase_1_stub.
  const r = await dreamStepPredictionTaxonomy(enabledDb, null);
  assert.equal(r.skipped, false, 'should not be skipped (flag is on)');
  assert.equal(r.step, 'predictionTaxonomy');
  // Error path (embedder=null can't embed undefined content).
  assert.ok(r.error, 'should return an error field from the embedder failure');
});

test('selfImprovementRollup: flag on → computes metrics and persists', async () => {
  const r = await dreamStepSelfImprovementRollup(enabledDb);
  assert.equal(r.skipped, false, 'should not be skipped (flag is on)');
  assert.equal(r.step, 'selfImprovementRollup');
  assert.ok(Array.isArray(r.metrics_keys), 'should return metrics_keys array');
  assert.ok(
    r.metrics_keys.includes('pipeline_yield'),
    'metrics should include pipeline_yield section',
  );
  assert.ok(
    r.metrics_keys.includes('cost_performance'),
    'metrics should include cost_performance section',
  );
});

// ---------------------------------------------------------------------------
// DAG topology — no cycles, new keys present
// ---------------------------------------------------------------------------

test('DREAM_DAG_DEPS topological sort is cycle-free with new v2 keys', async () => {
  const { topoLayers } = await import('../../cognition/dream/scheduler.js');
  // Should not throw.
  const layers = topoLayers(byName, DREAM_DAG_DEPS);
  assert.ok(Array.isArray(layers) && layers.length > 0, 'expected at least one layer');
});

test('DREAM_DAG_DEPS contains all 5 new v2 step keys', () => {
  const v2Keys = [
    'outcomeGrading',
    'playbookSynthesis',
    'calibrationBucket',
    'predictionTaxonomy',
    'selfImprovementRollup',
  ];
  for (const k of v2Keys) {
    assert.ok(k in DREAM_DAG_DEPS, `missing key in DREAM_DAG_DEPS: ${k}`);
  }
});

// ---------------------------------------------------------------------------
// step-registry byName — all 5 new entries present and callable
// ---------------------------------------------------------------------------

test('byName has entries for all 5 new v2 step keys', () => {
  const v2Keys = [
    'outcomeGrading',
    'playbookSynthesis',
    'calibrationBucket',
    'predictionTaxonomy',
    'selfImprovementRollup',
  ];
  for (const k of v2Keys) {
    assert.ok(k in byName, `missing key in byName: ${k}`);
    assert.equal(typeof byName[k], 'function', `byName.${k} should be a function`);
  }
});

test('byName v2 entries forward to correct step functions (resolve to skipped under disabled db)', async () => {
  const ctx = { db: disabledDb, host: null, embedder: null, opts: {} };
  const v2Keys = [
    'outcomeGrading',
    'playbookSynthesis',
    'calibrationBucket',
    'predictionTaxonomy',
    'selfImprovementRollup',
  ];
  for (const k of v2Keys) {
    const r = await byName[k](ctx);
    assert.equal(r.skipped, true, `byName.${k} should skip when flag is off`);
    assert.equal(r.reason, 'v2_not_enabled', `byName.${k} should report v2_not_enabled`);
    assert.equal(r.step, k, `byName.${k} should report step: '${k}'`);
  }
});
