// step-prediction-taxonomy.test.js — unit tests for dreamStepPredictionTaxonomy.
//
// Tests:
//  1. Flag-off path returns { skipped: true, reason: 'v2_not_enabled' }.
//  2. Weekly cooldown enforced: last_run_at 3 days ago → skipped.
//  3. Cooldown expired: last_run_at 8 days ago → runs.
//  4. No 'other' predictions → 0 candidates, cost 0, last_run_at updated.
//  5. Seed N='other' predictions → mock embedder + LLM → rule_candidates written.
//  6. Malformed proposed_kind from LLM is rejected.
//  7. Existing enum kind is rejected.
//  8. Fewer than minCluster predictions in one cluster → no LLM call.
//  9. LLM malformed JSON → llm_error returned, no crash.
// 10. Embedder error → early return, no crash.
//
// All tests use mem:// DB + runMigrations.

import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { surql } from 'surrealdb';
import { writeConfig } from '../../config/paths.js';
import { close, connect } from '../../data/db/client.js';
import { runMigrations } from '../../data/db/migrate.js';
import { dreamStepPredictionTaxonomy } from '../../cognition/dream/step-prediction-taxonomy.js';

// ── Test home setup ──────────────────────────────────────────────────────────
const HOME = join(
  tmpdir(),
  `robin-test-${process.pid}-${Math.random().toString(36).slice(2)}`,
);
mkdirSync(HOME, { recursive: true });
process.env.ROBIN_HOME = HOME;
await writeConfig({ embedder_profile: 'mxbai-1024' });

const MIGRATIONS_DIR = resolve(import.meta.dirname, '../../data/db/migrations');

async function fresh({ enableV2 = true } = {}) {
  const db = await connect({ engine: 'mem://' });
  await runMigrations(db, MIGRATIONS_DIR);
  if (enableV2) {
    await db.query(`UPSERT runtime:\`self-improvement-v2\` SET value.enabled = true`).collect();
  }
  return db;
}

// ── Seed helpers ──────────────────────────────────────────────────────────────

/**
 * Seed a prediction memo with kind='prediction' and meta.statement_kind='other'.
 */
async function seedOtherPrediction(db, statement) {
  const [rows] = await db
    .query(
      surql`CREATE memos CONTENT ${{
        kind: 'prediction',
        content: statement,
        content_hash: `hash-${Math.random().toString(36).slice(2)}`,
        derived_by: 'manual',
        scope: 'global',
        tags: [],
        meta: { statement_kind: 'other' },
      }}`,
    )
    .collect();
  const row = Array.isArray(rows) ? rows[0] : rows;
  return row.id;
}

// ── Mock objects ──────────────────────────────────────────────────────────────

/**
 * Mock embedder. Returns unit vectors in 2D space at specific angles so we
 * can control which predictions cluster together.
 */
function makeEmbedder(predStatementToAngle = {}) {
  return {
    embed: async (text) => {
      const angleDeg = predStatementToAngle[text] ?? 0;
      const r = (angleDeg * Math.PI) / 180;
      return Float32Array.from([Math.cos(r), Math.sin(r)]);
    },
  };
}

/**
 * Mock embedder that throws on every call.
 */
function failingEmbedder() {
  return {
    embed: async () => {
      throw new Error('embedder timeout');
    },
  };
}

/**
 * Build a simple fake host that returns the given LLM JSON string.
 */
function fakeHost(jsonString) {
  return {
    invokeLLM: async () => ({
      content: jsonString,
      usage: { input_tokens: 500, output_tokens: 200 },
    }),
  };
}

/**
 * A host that throws on every LLM call.
 */
function failingHost() {
  return {
    invokeLLM: async () => {
      throw new Error('LLM error');
    },
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

test('flag off → returns skipped v2_not_enabled', async () => {
  const db = await fresh({ enableV2: false });
  const r = await dreamStepPredictionTaxonomy(db, null, null);
  assert.equal(r.skipped, true);
  assert.equal(r.reason, 'v2_not_enabled');
  assert.equal(r.step, 'predictionTaxonomy');
  await close(db);
});

test('weekly cooldown: last_run_at 3 days ago → skipped', async () => {
  const db = await fresh();
  // Set last_run_at to 3 days ago.
  const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
  await db
    .query(
      `UPSERT runtime:\`self-improvement-v2\` SET value.prediction_taxonomy_last_run_at = $ts`,
      { ts: threeDaysAgo },
    )
    .collect();

  const r = await dreamStepPredictionTaxonomy(db, null, null);
  assert.equal(r.skipped, true);
  assert.equal(r.reason, 'weekly_cooldown');
  assert.ok(r.next_run_at, 'should have next_run_at');
  assert.equal(r.step, 'predictionTaxonomy');
  await close(db);
});

test('weekly cooldown: last_run_at 8 days ago → runs (not skipped)', async () => {
  const db = await fresh();
  const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
  await db
    .query(
      `UPSERT runtime:\`self-improvement-v2\` SET value.prediction_taxonomy_last_run_at = $ts`,
      { ts: eightDaysAgo },
    )
    .collect();

  // No predictions → runs and returns eligible_clusters:0.
  const embedder = makeEmbedder({});
  const r = await dreamStepPredictionTaxonomy(db, fakeHost('[]'), embedder);
  assert.equal(r.skipped, false);
  assert.equal(r.eligible_clusters, 0);
  assert.equal(r.step, 'predictionTaxonomy');
  await close(db);
});

test('no other predictions → 0 candidates, last_run_at updated', async () => {
  const db = await fresh();
  const embedder = makeEmbedder({});
  const r = await dreamStepPredictionTaxonomy(db, fakeHost('[]'), embedder);
  assert.equal(r.skipped, false);
  assert.equal(r.eligible_clusters, 0);
  assert.equal(r.candidates_written, 0);
  assert.equal(r.cost_usd, 0);
  assert.equal(r.step, 'predictionTaxonomy');

  // Verify last_run_at was written.
  const [rows] = await db
    .query('SELECT VALUE value FROM runtime:`self-improvement-v2`')
    .collect();
  const v = rows?.[0];
  assert.ok(v?.prediction_taxonomy_last_run_at, 'last_run_at should be set');
  await close(db);
});

test('seed 3 similar predictions → 1 eligible cluster → LLM called → candidate written', async () => {
  const db = await fresh();

  // Seed 3 predictions with similar statements (all angle ~0° → will cluster).
  const stmts = [
    'the feature will ship on time',
    'the sprint will complete before Friday',
    'the PR will be merged this week',
  ];
  for (const s of stmts) {
    await seedOtherPrediction(db, s);
  }

  // All at angle ~0 → cosine ≈ 1.0 → one cluster.
  const angleMap = {};
  for (const s of stmts) angleMap[s] = 0;
  const embedder = makeEmbedder(angleMap);

  const llmResponse = JSON.stringify([
    {
      proposed_kind: 'delivery_timing',
      description: 'Predictions about when work items will be delivered.',
      source_prediction_ids: [],
    },
  ]);
  const host = fakeHost(llmResponse);

  const r = await dreamStepPredictionTaxonomy(db, host, embedder, { minCluster: 3 });
  assert.equal(r.skipped, false);
  assert.equal(r.eligible_clusters, 1);
  assert.equal(r.candidates_written, 1);
  assert.deepEqual(r.proposed_kinds, ['delivery_timing']);
  assert.ok(r.cost_usd > 0, 'cost should be positive');
  assert.equal(r.step, 'predictionTaxonomy');

  // Verify the rule_candidate row.
  const [cands] = await db
    .query(`SELECT * FROM rule_candidates WHERE kind = 'statement_kind_enum'`)
    .collect();
  const rows = Array.isArray(cands) ? cands : [];
  assert.equal(rows.length, 1);
  assert.equal(rows[0].kind, 'statement_kind_enum');
  assert.equal(rows[0].status, 'pending');
  assert.equal(rows[0].payload.proposed_kind, 'delivery_timing');
  assert.ok(rows[0].content.includes('delivery_timing'));

  await close(db);
});

test('malformed proposed_kind from LLM is rejected (invalid characters)', async () => {
  const db = await fresh();
  const stmts = ['alpha', 'beta', 'gamma'];
  for (const s of stmts) await seedOtherPrediction(db, s);

  const angleMap = {};
  for (const s of stmts) angleMap[s] = 0;
  const embedder = makeEmbedder(angleMap);

  // LLM proposes 3 invalid kinds + 1 valid kind.
  const llmResponse = JSON.stringify([
    {
      proposed_kind: 'invalid kind!',   // spaces + special char → rejected
      description: 'Bad proposal.',
      source_prediction_ids: [],
    },
    {
      proposed_kind: 'ab',              // too short (< 3 chars) → rejected
      description: 'Too short.',
      source_prediction_ids: [],
    },
    {
      proposed_kind: 'other',           // existing enum → rejected
      description: 'Already exists.',
      source_prediction_ids: [],
    },
    {
      proposed_kind: 'valid_new_kind',  // valid
      description: 'A valid new kind.',
      source_prediction_ids: [],
    },
  ]);
  const host = fakeHost(llmResponse);

  const r = await dreamStepPredictionTaxonomy(db, host, embedder, { minCluster: 3 });
  assert.equal(r.skipped, false);
  assert.equal(r.candidates_written, 1, 'only the valid proposal should be written');
  assert.deepEqual(r.proposed_kinds, ['valid_new_kind']);

  await close(db);
});

test('existing enum kind rejected', async () => {
  const db = await fresh();
  const stmts = ['will rain tomorrow', 'it will snow', 'weather will be clear'];
  for (const s of stmts) await seedOtherPrediction(db, s);

  const angleMap = {};
  for (const s of stmts) angleMap[s] = 0;
  const embedder = makeEmbedder(angleMap);

  // LLM proposes an existing kind.
  const llmResponse = JSON.stringify([
    {
      proposed_kind: 'event_timing',   // already in enum
      description: 'Should be rejected.',
      source_prediction_ids: [],
    },
  ]);

  const r = await dreamStepPredictionTaxonomy(db, fakeHost(llmResponse), embedder, { minCluster: 3 });
  assert.equal(r.candidates_written, 0);
  assert.deepEqual(r.proposed_kinds, []);

  await close(db);
});

test('cluster below minCluster threshold → no LLM call, no candidates', async () => {
  const db = await fresh();
  // Seed only 2 predictions (below minCluster=3).
  await seedOtherPrediction(db, 'alpha prediction');
  await seedOtherPrediction(db, 'beta prediction');

  const embedder = makeEmbedder({
    'alpha prediction': 0,
    'beta prediction': 0,
  });

  let llmCalled = false;
  const host = {
    invokeLLM: async () => {
      llmCalled = true;
      return { content: '[]', usage: { input_tokens: 0, output_tokens: 0 } };
    },
  };

  const r = await dreamStepPredictionTaxonomy(db, host, embedder, { minCluster: 3 });
  assert.equal(r.skipped, false);
  assert.equal(r.eligible_clusters, 0);
  assert.equal(r.candidates_written, 0);
  assert.equal(llmCalled, false, 'LLM should not be called when no eligible clusters');
  await close(db);
});

test('LLM malformed JSON → llm_error, no crash', async () => {
  const db = await fresh();
  const stmts = ['pred one', 'pred two', 'pred three'];
  for (const s of stmts) await seedOtherPrediction(db, s);

  const angleMap = {};
  for (const s of stmts) angleMap[s] = 0;
  const embedder = makeEmbedder(angleMap);

  const host = fakeHost('this is not JSON }{garbage');

  const r = await dreamStepPredictionTaxonomy(db, host, embedder, { minCluster: 3 });
  assert.equal(r.skipped, false);
  assert.ok(r.llm_error, 'should have llm_error');
  assert.equal(r.step, 'predictionTaxonomy');

  // No candidates should have been written.
  const [cands] = await db
    .query(`SELECT count() AS n FROM rule_candidates WHERE kind = 'statement_kind_enum' GROUP ALL`)
    .collect();
  const count = Array.isArray(cands) ? (cands[0]?.n ?? 0) : 0;
  assert.equal(count, 0);

  await close(db);
});

test('LLM throws → llm_error, no crash', async () => {
  const db = await fresh();
  const stmts = ['x one', 'x two', 'x three'];
  for (const s of stmts) await seedOtherPrediction(db, s);

  const angleMap = {};
  for (const s of stmts) angleMap[s] = 0;
  const embedder = makeEmbedder(angleMap);

  const r = await dreamStepPredictionTaxonomy(db, failingHost(), embedder, { minCluster: 3 });
  assert.equal(r.skipped, false);
  assert.ok(r.llm_error, 'should have llm_error on LLM throw');
  assert.equal(r.step, 'predictionTaxonomy');
  await close(db);
});

test('embedder error → early return, no crash', async () => {
  const db = await fresh();
  await seedOtherPrediction(db, 'some prediction');

  const r = await dreamStepPredictionTaxonomy(db, failingHost(), failingEmbedder());
  assert.equal(r.skipped, false);
  assert.ok(r.error, 'should return an error field');
  assert.equal(r.step, 'predictionTaxonomy');
  await close(db);
});

test('two tight clusters + 1 singleton → only tight clusters are eligible', async () => {
  const db = await fresh();

  // Cluster A: 3 predictions at 0°.
  const stmtsA = ['a1 delivery timing', 'a2 delivery timing', 'a3 delivery timing'];
  for (const s of stmtsA) await seedOtherPrediction(db, s);

  // Cluster B: 3 predictions at 90° (orthogonal to A).
  const stmtsB = ['b1 weather forecast', 'b2 weather forecast', 'b3 weather forecast'];
  for (const s of stmtsB) await seedOtherPrediction(db, s);

  // Singleton at 45° (neither A nor B at threshold 0.75).
  // cos(45°, 0°) ≈ 0.707 < 0.75; cos(45°, 90°) ≈ 0.707 < 0.75.
  await seedOtherPrediction(db, 'singleton prediction here');

  const angleMap = {};
  for (const s of stmtsA) angleMap[s] = 0;
  for (const s of stmtsB) angleMap[s] = 90;
  angleMap['singleton prediction here'] = 45;

  const embedder = makeEmbedder(angleMap);

  const llmResponse = JSON.stringify([
    {
      proposed_kind: 'delivery_timing',
      description: 'When things get delivered.',
      source_prediction_ids: [],
    },
    {
      proposed_kind: 'weather_outcome',
      description: 'Weather-related predictions.',
      source_prediction_ids: [],
    },
  ]);

  const r = await dreamStepPredictionTaxonomy(db, fakeHost(llmResponse), embedder, {
    minCluster: 3,
    similarityThreshold: 0.75,
  });

  assert.equal(r.skipped, false);
  assert.equal(r.eligible_clusters, 2, 'two eligible clusters (A and B)');
  assert.equal(r.candidates_written, 2);
  assert.deepEqual(r.proposed_kinds.sort(), ['delivery_timing', 'weather_outcome'].sort());

  await close(db);
});
