// introspection-inline-grading.test.js — unit tests for Wave 3 inline LLM
// grading path in queue-poller.js.
//
// Tests:
//   1. Strata priority: full budget → all strata processed.
//   2. Strata priority: depleted budget → only predictions/corrections +
//      outbound + jobs grade; recall/turns fall back to structural only.
//   3. Turn sampling: turn_sample_pct=100 → graded; turn_sample_pct=0 → skipped.
//   4. Budget exhaustion mid-drain: LLM not called after exhaustion.
//   5. Antecedent-regex-fallback flag: set when budget < 25%.
//   6. LLM grade applied to no-signal rows (score null → LLM fills it).
//   7. Structural score takes precedence (no LLM call when score already set).

import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { mock, test } from 'node:test';
import { surql } from 'surrealdb';
import { writeConfig } from '../../config/paths.js';
import { close, connect } from '../../data/db/client.js';
import { runMigrations } from '../../data/db/migrate.js';

// ── Test home setup ──────────────────────────────────────────────────────────
const HOME = join(
  tmpdir(),
  `robin-inline-grade-${process.pid}-${Math.random().toString(36).slice(2)}`,
);
mkdirSync(HOME, { recursive: true });
process.env.ROBIN_HOME = HOME;
await writeConfig({ embedder_profile: 'mxbai-1024' });

const MIGRATIONS_PATH = resolve(import.meta.dirname, '../../data/db/migrations');

async function fresh() {
  const db = await connect({ engine: 'mem://' });
  await runMigrations(db, MIGRATIONS_PATH);
  return db;
}

/** Seed an events row. */
async function seedEvent(db) {
  const [rows] = await db
    .query(surql`CREATE events SET source = 'agent_internal', content = 'test turn', content_hash = 'abc'`)
    .collect();
  return Array.isArray(rows) ? rows[0] : rows;
}

/** Seed a task_close_queue row with configurable task_type. */
async function seedQueueRow(db, eventId, { taskType = 'turn:default', payload = {} } = {}) {
  const now = new Date();
  const expiresAt = new Date(now.getTime() + 60_000 * 60);
  const [rows] = await db
    .query(
      surql`CREATE task_close_queue SET
        task_type   = ${taskType},
        task_id     = ${'task-' + Math.random().toString(36).slice(2)},
        event_id    = ${eventId},
        payload     = ${payload},
        enqueued_at = ${now},
        claimed_at  = NONE,
        claimed_by  = NONE,
        expires_at  = ${expiresAt}`,
    )
    .collect();
  return Array.isArray(rows) ? rows[0] : rows;
}

/** Build a fake host whose invokeLLM returns a predictable Haiku response. */
function makeHost(opts = {}) {
  const {
    completeness = 0.8,
    correction_likelihood = 0.2,
    rationale = 'looks good',
    inputTokens = 400,
    outputTokens = 60,
    shouldThrow = false,
  } = opts;

  let callCount = 0;
  const invokeLLM = async (_messages, _options) => {
    callCount++;
    if (shouldThrow) throw new Error('LLM unavailable');
    return {
      content: JSON.stringify({ completeness, correction_likelihood, rationale }),
      usage: { input_tokens: inputTokens, output_tokens: outputTokens },
    };
  };
  return { invokeLLM, getCallCount: () => callCount };
}

/** Write budget state directly to the runtime KV row. */
async function setBudgetState(db, { daily_spend_usd = 0, turn_sample_pct = 20 } = {}) {
  await db
    .query(
      `UPSERT runtime:\`introspection.value\` SET
         value.daily_spend_usd = ${daily_spend_usd},
         value.turn_sample_pct = ${turn_sample_pct}`,
    )
    .collect();
}

/** Write budget config to the runtime KV row. */
async function setBudgetConfig(db, { daily_cost_budget_usd = 0.50 } = {}) {
  await db
    .query(
      `UPSERT runtime:\`introspection.config\` SET
         value.daily_cost_budget_usd = ${daily_cost_budget_usd},
         value.turn_sample_pct_floor = 5,
         value.turn_sample_pct_ceiling = 50,
         value.target_turn_spend_fraction = 0.5,
         value.budget_remaining_thresholds.recall_throttle_at = 0.25,
         value.budget_remaining_thresholds.antecedent_regex_fallback_at = 0.25,
         value.budget_remaining_thresholds.turn_sample_cutoff_at = 0.10`,
    )
    .collect();
}

// ── Tests ────────────────────────────────────────────────────────────────────

test('no-host: no LLM grading, no-signal row deleted without memo', async () => {
  const db = await fresh();
  const { drainQueueOnce } = await import(
    `../../cognition/introspection/queue-poller.js?cb=${Date.now()}`
  );

  const event = await seedEvent(db);
  await seedQueueRow(db, event.id, { taskType: 'turn:default', payload: {} });

  const result = await drainQueueOnce(db, null);
  assert.equal(result.processed, 1);
  assert.equal(result.graded, 0, 'no grading without host');

  const [mRows] = await db.query(surql`SELECT * FROM memos WHERE kind = 'task_outcome'`).collect();
  const memos = (Array.isArray(mRows) ? mRows : [mRows]).filter(Boolean);
  assert.equal(memos.length, 0, 'no memo for no-signal row');

  await close(db);
});

test('with host: no-signal turn row gets LLM grade written to memo', async () => {
  const db = await fresh();
  const { drainQueueOnce } = await import(
    `../../cognition/introspection/queue-poller.js?cb=${Date.now()}`
  );

  await setBudgetConfig(db, { daily_cost_budget_usd: 0.50 });
  await setBudgetState(db, { daily_spend_usd: 0, turn_sample_pct: 100 });

  const host = makeHost({ completeness: 0.9, correction_likelihood: 0.1 });
  const event = await seedEvent(db);
  await seedQueueRow(db, event.id, { taskType: 'turn:default', payload: {} });

  const result = await drainQueueOnce(db, host);
  assert.equal(result.processed, 1);
  assert.equal(result.graded, 1, 'one row graded');
  assert.equal(host.getCallCount(), 1, 'invokeLLM called once');

  const [mRows] = await db.query(surql`SELECT * FROM memos WHERE kind = 'task_outcome'`).collect();
  const memos = (Array.isArray(mRows) ? mRows : [mRows]).filter(Boolean);
  assert.equal(memos.length, 1, 'memo written');
  assert.ok(typeof memos[0].meta.score === 'number', 'score is a number');
  assert.ok(memos[0].meta.signals.self_grade, 'self_grade signal present');
  assert.equal(memos[0].meta.signals.self_grade.model, 'claude-haiku-4-5');

  await close(db);
});

test('structural score takes precedence: LLM NOT called when score already set by structural rule', async () => {
  const db = await fresh();
  const { drainQueueOnce } = await import(
    `../../cognition/introspection/queue-poller.js?cb=${Date.now()}`
  );

  await setBudgetConfig(db, { daily_cost_budget_usd: 0.50 });
  await setBudgetState(db, { daily_spend_usd: 0, turn_sample_pct: 100 });

  const host = makeHost();
  const event = await seedEvent(db);
  // outbound_blocked fires structural rule → score = 0.2 → no LLM needed.
  await seedQueueRow(db, event.id, {
    taskType: 'outbound:discord_send:send_dm',
    payload: { outbound_result: { ok: false, reason: 'pii' } },
  });

  const result = await drainQueueOnce(db, host);
  assert.equal(result.processed, 1);
  assert.equal(result.graded, 0, 'no LLM grade when structural score exists');
  assert.equal(host.getCallCount(), 0, 'invokeLLM NOT called');

  await close(db);
});

test('budget exhaustion: LLM not called after budget exhausted', async () => {
  const db = await fresh();
  const { drainQueueOnce } = await import(
    `../../cognition/introspection/queue-poller.js?cb=${Date.now()}`
  );

  // Set budget to $0.01 and spend $0.009 (just under limit, but one call pushes over).
  // Actually, set spend = limit so any reservation fails.
  await setBudgetConfig(db, { daily_cost_budget_usd: 0.01 });
  await setBudgetState(db, { daily_spend_usd: 0.01, turn_sample_pct: 100 }); // fully exhausted

  const host = makeHost();
  const event = await seedEvent(db);
  await seedQueueRow(db, event.id, { taskType: 'turn:default', payload: {} });

  const result = await drainQueueOnce(db, host);
  assert.equal(result.processed, 1);
  assert.equal(result.graded, 0, 'no grading when budget exhausted');
  assert.equal(host.getCallCount(), 0, 'invokeLLM NOT called');

  await close(db);
});

test('turn_sample_pct=0 (below 10% threshold): turns not graded', async () => {
  const db = await fresh();
  const { drainQueueOnce } = await import(
    `../../cognition/introspection/queue-poller.js?cb=${Date.now()}`
  );

  // Budget at 5% remaining → below the 10% turn cutoff.
  const limit = 0.50;
  const spent = limit * 0.96; // 4% remaining < 10%
  await setBudgetConfig(db, { daily_cost_budget_usd: limit });
  await setBudgetState(db, { daily_spend_usd: spent, turn_sample_pct: 20 });

  const host = makeHost();
  const event = await seedEvent(db);
  await seedQueueRow(db, event.id, { taskType: 'turn:default', payload: {} });

  const result = await drainQueueOnce(db, host);
  assert.equal(result.graded, 0, 'turn grading disabled below 10% remaining');
  assert.equal(host.getCallCount(), 0);

  await close(db);
});

test('turn_sample_pct=100: turn always graded', async () => {
  const db = await fresh();
  const { drainQueueOnce } = await import(
    `../../cognition/introspection/queue-poller.js?cb=${Date.now()}`
  );

  await setBudgetConfig(db, { daily_cost_budget_usd: 0.50 });
  await setBudgetState(db, { daily_spend_usd: 0, turn_sample_pct: 100 });

  const host = makeHost();
  const event = await seedEvent(db);
  await seedQueueRow(db, event.id, { taskType: 'turn:default', payload: {} });

  const result = await drainQueueOnce(db, host);
  assert.equal(result.graded, 1);
  assert.equal(host.getCallCount(), 1);

  await close(db);
});

test('jobs stratum: graded regardless of recall throttle zone (budget > 0)', async () => {
  const db = await fresh();
  const { drainQueueOnce } = await import(
    `../../cognition/introspection/queue-poller.js?cb=${Date.now()}`
  );

  // Budget at 20% remaining → below recall_throttle_at (25%) but jobs are always allowed.
  const limit = 0.50;
  const spent = limit * 0.82;
  await setBudgetConfig(db, { daily_cost_budget_usd: limit });
  await setBudgetState(db, { daily_spend_usd: spent, turn_sample_pct: 0 });

  const host = makeHost();
  const event = await seedEvent(db);
  await seedQueueRow(db, event.id, { taskType: 'job:daily-briefing', payload: {} });

  const result = await drainQueueOnce(db, host);
  assert.equal(result.graded, 1, 'job row graded in throttle zone');
  assert.equal(host.getCallCount(), 1);

  await close(db);
});

test('LLM throws: row still deleted (no-signal), graded=0', async () => {
  const db = await fresh();
  const { drainQueueOnce } = await import(
    `../../cognition/introspection/queue-poller.js?cb=${Date.now()}`
  );

  await setBudgetConfig(db, { daily_cost_budget_usd: 0.50 });
  await setBudgetState(db, { daily_spend_usd: 0, turn_sample_pct: 100 });

  const host = makeHost({ shouldThrow: true });
  const event = await seedEvent(db);
  await seedQueueRow(db, event.id, { taskType: 'turn:default', payload: {} });

  const result = await drainQueueOnce(db, host);
  assert.equal(result.processed, 1);
  assert.equal(result.written, 1, 'row deleted even when LLM throws');
  assert.equal(result.graded, 0);

  // Queue empty.
  const [qRows] = await db.query(surql`SELECT * FROM task_close_queue`).collect();
  assert.equal((Array.isArray(qRows) ? qRows : [qRows]).filter(Boolean).length, 0);

  await close(db);
});

test('LLM-throw refunds reserved budget (regression for a6a710b)', async () => {
  const db = await fresh();
  const { drainQueueOnce } = await import(
    `../../cognition/introspection/queue-poller.js?cb=${Date.now()}`
  );
  const { readBudgetState } = await import(
    `../../cognition/introspection/budget.js?cb=${Date.now()}`
  );

  await setBudgetConfig(db, { daily_cost_budget_usd: 0.50 });
  await setBudgetState(db, { daily_spend_usd: 0.10, turn_sample_pct: 100 });

  // Record spend before the drain.
  const before = await readBudgetState(db);

  const host = makeHost({ shouldThrow: true });
  const event = await seedEvent(db);
  await seedQueueRow(db, event.id, { taskType: 'turn:default', payload: {} });

  await drainQueueOnce(db, host);

  // After the LLM throws, the reserved cost must be refunded so spent_today
  // returns to (approximately) its pre-drain value.
  const after = await readBudgetState(db);
  assert.ok(
    Math.abs(after.daily_spend_usd - before.daily_spend_usd) < 1e-6,
    `budget should be refunded after LLM throw: before=${before.daily_spend_usd} after=${after.daily_spend_usd}`,
  );

  await close(db);
});

test('multiple strata in one drain: correct graded count', async () => {
  const db = await fresh();
  const { drainQueueOnce } = await import(
    `../../cognition/introspection/queue-poller.js?cb=${Date.now()}`
  );

  await setBudgetConfig(db, { daily_cost_budget_usd: 0.50 });
  await setBudgetState(db, { daily_spend_usd: 0, turn_sample_pct: 100 });

  const host = makeHost();
  const e1 = await seedEvent(db);
  const e2 = await seedEvent(db);
  const e3 = await seedEvent(db);

  // Row 1: turn with no structural signal → LLM graded.
  await seedQueueRow(db, e1.id, { taskType: 'turn:default', payload: {} });
  // Row 2: outbound blocked (structural score set) → no LLM.
  await seedQueueRow(db, e2.id, {
    taskType: 'outbound:discord_send:send_dm',
    payload: { outbound_result: { ok: false, reason: 'pii' } },
  });
  // Row 3: job with no structural signal → LLM graded.
  await seedQueueRow(db, e3.id, { taskType: 'job:daily-briefing', payload: {} });

  const result = await drainQueueOnce(db, host);
  assert.equal(result.processed, 3);
  assert.equal(result.graded, 2, 'turn + job graded; outbound skipped (structural)');
  assert.equal(host.getCallCount(), 2);

  await close(db);
});
