// step-outcome-grading.test.js — unit tests for dreamStepOutcomeGrading.
//
// Tests:
//  1. Flag-off path returns { skipped: true, reason: 'v2_not_enabled' }.
//  2. Mocked LLM: valid JSON → score computed correctly (both axes).
//  3. Mocked LLM: only correction_likelihood (cold-start, no playbook) → score = correction_likelihood.
//  4. Mocked LLM: malformed JSON → row skipped, skipped_due_to_error incremented.
//  5. Budget halt: accumulated cost > $0.20 → loop halts, partial completion.
//  6. Cold-start path: no playbook → completeness=null, score=correction_likelihood.
//  7. Top-N cap: batchSize=2 → only 2 rows processed.
//  8. No ungraded rows → returns zeroes immediately.
//
// All tests use mem:// DB + runMigrations.

import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { surql } from 'surrealdb';
import { computeScore } from '../../cognition/dream/outcome-grading-prompt.js';
import { dreamStepOutcomeGrading } from '../../cognition/dream/step-outcome-grading.js';
import { writeConfig } from '../../config/paths.js';
import { close, connect } from '../../data/db/client.js';
import { runMigrations } from '../../data/db/migrate.js';

// ── Test home setup ──────────────────────────────────────────────────────────
const HOME = join(tmpdir(), `robin-test-${process.pid}-${Math.random().toString(36).slice(2)}`);
mkdirSync(HOME, { recursive: true });
process.env.ROBIN_HOME = HOME;
await writeConfig({ embedder_profile: 'mxbai-1024' });

async function fresh() {
  const db = await connect({ engine: 'mem://' });
  await runMigrations(db, resolve(import.meta.dirname, '../../data/db/migrations'));
  // Enable v2 flag
  await db.query(`UPSERT runtime:\`self-improvement-v2\` SET value.enabled = true`).collect();
  return db;
}

async function freshDisabled() {
  const db = await connect({ engine: 'mem://' });
  await runMigrations(db, resolve(import.meta.dirname, '../../data/db/migrations'));
  // v2 flag stays false (default)
  return db;
}

/**
 * Seed a task_outcome memo with score=null (ungraded).
 * Returns the created memo row.
 */
async function seedUngradedMemo(db, taskType = 'job:daily-briefing', taskId = 'task-001') {
  const now = new Date();
  const content = `task_outcome ${taskType}/${taskId}: test outcome`;
  const [rows] = await db
    .query(
      surql`CREATE memos CONTENT ${{
        kind: 'task_outcome',
        content,
        content_hash: `hash-${Math.random().toString(36).slice(2)}`,
        derived_by: 'introspection',
        scope: 'global',
        tags: [],
        meta: {
          task_type: taskType,
          task_id: taskId,
          source_event: null,
          signals: {},
          score: null,
          enqueued_at: now.toISOString(),
        },
      }}`,
    )
    .collect();
  return Array.isArray(rows) ? rows[0] : rows;
}

/**
 * A simple fake host that returns the given JSON string as LLM content.
 * Each call costs a fixed 100 input + 50 output tokens.
 */
function fakeHost(jsonContent, { inputTokens = 100, outputTokens = 50 } = {}) {
  return {
    invokeLLM: async () => ({
      content: jsonContent,
      usage: { input_tokens: inputTokens, output_tokens: outputTokens },
    }),
  };
}

/**
 * A host that throws on every LLM call.
 */
function failingHost() {
  return {
    invokeLLM: async () => {
      throw new Error('LLM timeout');
    },
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

test('flag off → returns skipped v2_not_enabled', async () => {
  const db = await freshDisabled();
  const r = await dreamStepOutcomeGrading(db, null, null, {});
  assert.deepEqual(r, { skipped: true, reason: 'v2_not_enabled', step: 'outcomeGrading' });
  await close(db);
});

test('no ungraded rows → returns zeroes', async () => {
  const db = await fresh();
  const host = fakeHost('{}');
  const r = await dreamStepOutcomeGrading(db, host, null, { batchSize: 50 });
  assert.equal(r.skipped, false);
  assert.equal(r.graded, 0);
  assert.equal(r.skipped_due_to_budget, 0);
  assert.equal(r.skipped_due_to_error, 0);
  assert.equal(r.cost_usd, 0);
  assert.equal(r.step, 'outcomeGrading');
  await close(db);
});

test('valid LLM response: both axes → score = mean(completeness, correction_likelihood)', async () => {
  const db = await fresh();
  await seedUngradedMemo(db);

  const llmJson = JSON.stringify({
    completeness: 0.8,
    correction_likelihood: 0.2,
    rationale: 'Most sections covered, minor gap.',
  });
  const host = fakeHost(llmJson);

  const r = await dreamStepOutcomeGrading(db, host, null, { batchSize: 50 });
  assert.equal(r.graded, 1);
  assert.equal(r.skipped_due_to_error, 0);
  assert.ok(r.cost_usd > 0, 'cost should be positive');

  // Verify the memo was updated
  const [mRows] = await db
    .query(surql`SELECT meta FROM memos WHERE kind = 'task_outcome'`)
    .collect();
  const memos = (Array.isArray(mRows) ? mRows : []).filter(Boolean);
  assert.equal(memos.length, 1);

  const meta = memos[0].meta;
  // score = mean(0.8, 0.2) = 0.5
  assert.ok(Math.abs(meta.score - 0.5) < 0.001, `expected score ~0.5, got ${meta.score}`);
  assert.ok(meta.signals?.self_grade, 'self_grade signal should be present');
  assert.ok(Math.abs(meta.signals.self_grade.completeness - 0.8) < 0.001);
  assert.ok(Math.abs(meta.signals.self_grade.correction_likelihood - 0.2) < 0.001);
  assert.equal(typeof meta.signals.self_grade.model, 'string');
  assert.equal(typeof meta.signals.self_grade.ts, 'string');

  await close(db);
});

test('cold-start path: no playbook → completeness=null, score=correction_likelihood', async () => {
  const db = await fresh();
  // Use a task_type that has no playbook
  await seedUngradedMemo(db, 'turn:default', 'task-cold');

  const llmJson = JSON.stringify({
    completeness: null,
    correction_likelihood: 0.3,
    rationale: 'No playbook available; correction likelihood low.',
  });
  const host = fakeHost(llmJson);

  const r = await dreamStepOutcomeGrading(db, host, null, { batchSize: 50 });
  assert.equal(r.graded, 1);

  const [mRows] = await db
    .query(surql`SELECT meta FROM memos WHERE kind = 'task_outcome'`)
    .collect();
  const memos = (Array.isArray(mRows) ? mRows : []).filter(Boolean);
  const meta = memos[0].meta;

  // Cold-start: score = correction_likelihood = 0.3
  assert.ok(Math.abs(meta.score - 0.3) < 0.001, `expected score ~0.3, got ${meta.score}`);
  assert.equal(meta.signals.self_grade.completeness, null);
  assert.ok(Math.abs(meta.signals.self_grade.correction_likelihood - 0.3) < 0.001);

  await close(db);
});

test('malformed LLM JSON → row skipped, skipped_due_to_error incremented', async () => {
  const db = await fresh();
  await seedUngradedMemo(db);

  const host = fakeHost('not valid json at all }{garbage');

  const r = await dreamStepOutcomeGrading(db, host, null, { batchSize: 50 });
  assert.equal(r.graded, 0);
  assert.equal(r.skipped_due_to_error, 1);

  // Verify memo score is still null (not updated)
  const [mRows] = await db
    .query(surql`SELECT meta FROM memos WHERE kind = 'task_outcome'`)
    .collect();
  const memos = (Array.isArray(mRows) ? mRows : []).filter(Boolean);
  assert.equal(memos[0].meta.score, null, 'score should remain null after LLM error');

  await close(db);
});

test('LLM throws → row skipped, skipped_due_to_error incremented', async () => {
  const db = await fresh();
  await seedUngradedMemo(db);

  const r = await dreamStepOutcomeGrading(db, failingHost(), null, { batchSize: 50 });
  assert.equal(r.graded, 0);
  assert.equal(r.skipped_due_to_error, 1);

  await close(db);
});

test('budget halt: accumulated cost > cap → loop halts, partial completion', async () => {
  const db = await fresh();
  // Seed 5 rows
  for (let i = 0; i < 5; i++) {
    await seedUngradedMemo(db, 'job:daily-briefing', `task-${i}`);
  }

  // Each call: 10000 input + 5000 output tokens
  // estimateCallCost(10000, 5000) = (10000/1M)*0.80 + (5000/1M)*4.00 = 0.008 + 0.02 = 0.028 USD
  // Budget = $0.025: call 1 runs (0 < 0.025), accumulates 0.028,
  // then before call 2 check: 0.028 >= 0.025 → halt. Graded = 1.
  const host = fakeHost(
    JSON.stringify({ completeness: 0.9, correction_likelihood: 0.1, rationale: 'Good.' }),
    { inputTokens: 10000, outputTokens: 5000 },
  );

  const r = await dreamStepOutcomeGrading(db, host, null, {
    batchSize: 50,
    stepBudgetUsd: 0.025,
  });

  // Should grade exactly 1, then halt
  assert.equal(r.graded, 1, `expected 1 graded, got ${r.graded}`);
  assert.ok(r.skipped_due_to_budget > 0, 'some rows should be budget-skipped');
  assert.equal(r.graded + r.skipped_due_to_budget + r.skipped_due_to_error, 5);
  assert.ok(r.cost_usd > 0);
  assert.ok(r.cost_usd <= 0.025 + 0.03, 'cost should not exceed budget by more than one call');

  await close(db);
});

test('top-N cap: batchSize=2 → only 2 rows processed', async () => {
  const db = await fresh();
  // Seed 4 rows
  for (let i = 0; i < 4; i++) {
    await seedUngradedMemo(db, 'job:daily-briefing', `task-cap-${i}`);
  }

  const host = fakeHost(
    JSON.stringify({ completeness: 0.7, correction_likelihood: 0.3, rationale: 'OK.' }),
  );

  const r = await dreamStepOutcomeGrading(db, host, null, { batchSize: 2, stepBudgetUsd: 100 });
  assert.equal(r.graded, 2, `expected 2 graded (batchSize=2), got ${r.graded}`);
  assert.equal(r.skipped_due_to_budget, 0);

  await close(db);
});

test('multiple rows: error on one does not stop others', async () => {
  const db = await fresh();
  await seedUngradedMemo(db, 'job:daily-briefing', 'task-ok1');
  await seedUngradedMemo(db, 'job:daily-briefing', 'task-ok2');

  let callCount = 0;
  const mixedHost = {
    invokeLLM: async () => {
      callCount++;
      if (callCount === 1) throw new Error('first call fails');
      return {
        content: JSON.stringify({
          completeness: 0.9,
          correction_likelihood: 0.1,
          rationale: 'Great.',
        }),
        usage: { input_tokens: 100, output_tokens: 50 },
      };
    },
  };

  const r = await dreamStepOutcomeGrading(db, mixedHost, null, { batchSize: 50 });
  assert.equal(r.graded, 1);
  assert.equal(r.skipped_due_to_error, 1);

  await close(db);
});

// ── computeScore unit tests ──────────────────────────────────────────────────

test('computeScore: both axes → mean', () => {
  const s = computeScore(0.8, 0.2);
  assert.ok(Math.abs(s - 0.5) < 0.001);
});

test('computeScore: completeness null → correction_likelihood only', () => {
  const s = computeScore(null, 0.3);
  assert.ok(Math.abs(s - 0.3) < 0.001);
});

test('computeScore: completeness undefined → correction_likelihood only', () => {
  const s = computeScore(undefined, 0.4);
  assert.ok(Math.abs(s - 0.4) < 0.001);
});

test('computeScore: invalid correction_likelihood → null', () => {
  const s = computeScore(0.8, 'oops');
  assert.equal(s, null);
});

test('computeScore: values clamped to [0, 1]', () => {
  const s = computeScore(1.5, -0.3);
  // clamp: completeness=1, correction_likelihood=0 → mean=0.5
  assert.ok(Math.abs(s - 0.5) < 0.001);
});
