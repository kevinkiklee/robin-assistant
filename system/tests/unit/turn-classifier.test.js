// turn-classifier.test.js — unit tests for system/cognition/intuition/turn-classifier.js
//
// Uses mem:// + migrations for DB tests. Always pairs connect with close.

import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { writeConfig } from '../../config/paths.js';
import { close, connect } from '../../data/db/client.js';
import { runMigrations } from '../../data/db/migrate.js';
import { setSelfImprovementV2Enabled } from '../../runtime/config/self-improvement-v2.js';
import { getPlaybookForInject } from '../../cognition/intuition/playbook-inject.js';
import {
  _clearCacheForTest,
  classifyTurnType,
  hasTurnPlaybooks,
  isBudgetSufficient,
  routeRecallIntent,
} from '../../cognition/intuition/turn-classifier.js';

// __robin_test_home_setup__
const HOME = join(
  tmpdir(),
  `robin-test-${process.pid}-${Math.random().toString(36).slice(2)}`,
);
mkdirSync(HOME, { recursive: true });
process.env.ROBIN_HOME = HOME;
await writeConfig({ embedder_profile: 'mxbai-1024' });

const MIGRATIONS_DIR = resolve(import.meta.dirname, '../../data/db/migrations');

async function fresh() {
  const db = await connect({ engine: 'mem://' });
  await runMigrations(db, MIGRATIONS_DIR);
  return db;
}

// Insert an active turn:default playbook into the DB.
async function seedTurnPlaybook(db, taskType = 'turn:default') {
  await db
    .query(
      `CREATE memos CONTENT {
        kind: 'playbook',
        content: 'Step 1: think. Step 2: respond.',
        derived_by: 'step-playbook-synthesis',
        meta: { task_type: '${taskType}', active: true }
      }`,
    )
    .collect();
}

// Stub embedder that returns a consistent unit vector for any input.
function makeStubEmbedder(dim = 8) {
  const vec = new Float32Array(dim).fill(1 / Math.sqrt(dim));
  return { embed: async () => vec };
}

// Stub embedder that returns distinct vectors for different messages.
// Message 'A' → all 1s; message 'B' → all -1s (orthogonal for our purposes).
function makeDistinctEmbedder(dim = 8) {
  return {
    embed: async (msg) => {
      if (msg === 'A') return new Float32Array(dim).fill(1 / Math.sqrt(dim));
      if (msg === 'B') return new Float32Array(dim).fill(-1 / Math.sqrt(dim));
      // Unknown → zero vector (similarity will be 0)
      return new Float32Array(dim).fill(0);
    },
  };
}

// ---------------------------------------------------------------------------
// routeRecallIntent — Tier 2 pattern routing
// ---------------------------------------------------------------------------

test('routeRecallIntent returns null for empty/non-recall message', () => {
  assert.equal(routeRecallIntent(''), null);
  assert.equal(routeRecallIntent('help me write a function'), null);
  assert.equal(routeRecallIntent('what is 2 + 2'), null);
});

test('routeRecallIntent routes person queries to recall:person', () => {
  assert.equal(routeRecallIntent('who is Jake?'), 'recall:person');
  assert.equal(routeRecallIntent('tell me about Kevin'), 'recall:person');
  assert.equal(routeRecallIntent('Who was that engineer I met?'), 'recall:person');
});

test('routeRecallIntent routes past-session queries to recall:past_session', () => {
  assert.equal(routeRecallIntent('what did I work on last week?'), 'recall:past_session');
  assert.equal(routeRecallIntent('what did you say last time?'), 'recall:past_session');
  assert.equal(routeRecallIntent('have I mentioned this before?'), 'recall:past_session');
});

test('routeRecallIntent routes domain-fact queries to recall:domain_facts', () => {
  assert.equal(routeRecallIntent('do you know my preferences?'), 'recall:domain_facts');
  assert.equal(routeRecallIntent('recall my goals'), 'recall:domain_facts');
});

// ---------------------------------------------------------------------------
// hasTurnPlaybooks — empty-playbook-set short-circuit
// ---------------------------------------------------------------------------

test('hasTurnPlaybooks returns false when no turn:* playbook exists', async () => {
  const db = await fresh();
  const result = await hasTurnPlaybooks(db);
  assert.equal(result, false);
  await close(db);
});

test('hasTurnPlaybooks returns true when an active turn:* playbook exists', async () => {
  const db = await fresh();
  await seedTurnPlaybook(db, 'turn:analyze');
  const result = await hasTurnPlaybooks(db);
  assert.equal(result, true);
  await close(db);
});

test('hasTurnPlaybooks returns false for inactive playbook', async () => {
  const db = await fresh();
  await db
    .query(
      `CREATE memos CONTENT {
        kind: 'playbook',
        content: 'old',
        derived_by: 'step-playbook-synthesis',
        meta: { task_type: 'turn:default', active: false }
      }`,
    )
    .collect();
  const result = await hasTurnPlaybooks(db);
  assert.equal(result, false);
  await close(db);
});

test('hasTurnPlaybooks returns false on DB error (fail-soft)', async () => {
  const brokenDb = { query: () => { throw new Error('db down'); } };
  const result = await hasTurnPlaybooks(brokenDb);
  assert.equal(result, false);
});

// ---------------------------------------------------------------------------
// isBudgetSufficient
// ---------------------------------------------------------------------------

test('isBudgetSufficient returns true when budget row absent (defaults give $0.50 remaining)', async () => {
  const db = await fresh();
  // No introspection KV rows → defaults: $0.50 budget, $0 spend → $0.50 remaining
  const result = await isBudgetSufficient(db);
  assert.equal(result, true);
  await close(db);
});

test('isBudgetSufficient returns false when budget is fully spent', async () => {
  const db = await fresh();
  // Inject a state row that exhausts the budget.
  await db
    .query(`UPSERT runtime:\`introspection.value\` SET value = { daily_spend_usd: 0.50, crash_count: 0, turn_sample_pct: 25 }`)
    .collect();
  const result = await isBudgetSufficient(db);
  assert.equal(result, false);
  await close(db);
});

test('isBudgetSufficient is fail-soft: DB errors cause inner helpers to return defaults (sufficient)', async () => {
  // readBudgetConfig and readBudgetState both have internal try/catch and return
  // safe defaults on DB error. isBudgetSufficient itself also has an outer try/catch.
  // With defaults: $0.50 budget, $0 spend → $0.50 remaining → sufficient.
  // This test documents the fail-safe contract: a DB error does NOT falsely gate the classifier.
  const brokenDb = { query: () => { throw new Error('db down'); } };
  const result = await isBudgetSufficient(brokenDb);
  assert.equal(result, true, 'inner helpers return safe defaults; outer try/catch returns false as last resort');
});

// ---------------------------------------------------------------------------
// classifyTurnType — Tier 1: declared task_type
// ---------------------------------------------------------------------------

test('classifyTurnType returns declared task_type from turnContext (Tier 1, bypasses classifier)', async () => {
  const db = await fresh();
  let llmCallCount = 0;
  const mockHost = {
    invokeLLM: async () => { llmCallCount++; return { content: 'turn:analyze', usage: {} }; },
  };

  const result = await classifyTurnType(
    db,
    { task_type: 'job:daily-briefing', query: 'some message' },
    mockHost,
    null,
  );
  assert.equal(result, 'job:daily-briefing');
  assert.equal(llmCallCount, 0, 'LLM must not be called for declared task_type');
  await close(db);
});

// ---------------------------------------------------------------------------
// classifyTurnType — Tier 2: recall routing
// ---------------------------------------------------------------------------

test('classifyTurnType routes recall query without LLM call', async () => {
  const db = await fresh();
  let llmCallCount = 0;
  const mockHost = {
    invokeLLM: async () => { llmCallCount++; return { content: 'turn:default', usage: {} }; },
  };

  const result = await classifyTurnType(
    db,
    { query: 'who is my mentor?' },
    mockHost,
    null,
  );
  assert.equal(result, 'recall:person');
  assert.equal(llmCallCount, 0, 'LLM must not be called for Tier 2 recall routing');
  await close(db);
});

// ---------------------------------------------------------------------------
// classifyTurnType — Tier 3: Haiku classifier
// ---------------------------------------------------------------------------

test('classifyTurnType calls LLM and returns verdict when turn:* playbook exists', async () => {
  const db = await fresh();
  await seedTurnPlaybook(db);
  _clearCacheForTest();

  let llmCallCount = 0;
  const mockHost = {
    invokeLLM: async () => {
      llmCallCount++;
      return { content: 'turn:analyze', usage: { input_tokens: 10, output_tokens: 2 } };
    },
  };

  const result = await classifyTurnType(
    db,
    { query: 'analyze this codebase for me', session_id: 'test-session-tier3' },
    mockHost,
    makeStubEmbedder(),
  );

  assert.equal(result, 'turn:analyze');
  assert.equal(llmCallCount, 1, 'LLM should be called once');
  await close(db);
  _clearCacheForTest();
});

test('classifyTurnType returns turn:default when no turn:* playbooks exist (empty-playbook-set short-circuit)', async () => {
  const db = await fresh();
  _clearCacheForTest();

  let llmCallCount = 0;
  const mockHost = {
    invokeLLM: async () => {
      llmCallCount++;
      return { content: 'turn:analyze', usage: {} };
    },
  };

  const result = await classifyTurnType(
    db,
    { query: 'analyze this for me', session_id: 'test-no-playbooks' },
    mockHost,
    null,
  );

  assert.equal(result, 'turn:default', 'should short-circuit to default when no playbooks');
  assert.equal(llmCallCount, 0, 'LLM must not be called when no turn:* playbooks exist');
  await close(db);
  _clearCacheForTest();
});

test('classifyTurnType returns turn:default when budget < $0.05', async () => {
  const db = await fresh();
  await seedTurnPlaybook(db);
  // Exhaust the budget.
  await db
    .query(`UPSERT runtime:\`introspection.value\` SET value = { daily_spend_usd: 0.50, crash_count: 0, turn_sample_pct: 25 }`)
    .collect();
  _clearCacheForTest();

  let llmCallCount = 0;
  const mockHost = {
    invokeLLM: async () => {
      llmCallCount++;
      return { content: 'turn:analyze', usage: {} };
    },
  };

  const result = await classifyTurnType(
    db,
    { query: 'analyze this for me', session_id: 'test-budget-gate' },
    mockHost,
    null,
  );

  assert.equal(result, 'turn:default', 'should return default when budget exhausted');
  assert.equal(llmCallCount, 0, 'LLM must not be called when budget is exhausted');
  await close(db);
  _clearCacheForTest();
});

test('classifyTurnType returns turn:default for invalid LLM output (fallback)', async () => {
  const db = await fresh();
  await seedTurnPlaybook(db);
  _clearCacheForTest();

  const mockHost = {
    invokeLLM: async () => ({
      content: 'GARBAGE_OUTPUT_NOT_A_VALID_INTENT',
      usage: {},
    }),
  };

  const result = await classifyTurnType(
    db,
    { query: 'some question', session_id: 'test-invalid-output' },
    mockHost,
    null,
  );

  assert.equal(result, 'turn:default', 'invalid LLM output should fall back to turn:default');
  await close(db);
  _clearCacheForTest();
});

// ---------------------------------------------------------------------------
// Per-session cache: cache hit (LLM called once, not twice)
// ---------------------------------------------------------------------------

test('classifyTurnType uses session cache and calls LLM only once for similar turns', async () => {
  const db = await fresh();
  await seedTurnPlaybook(db);
  _clearCacheForTest();

  let llmCallCount = 0;
  const mockHost = {
    invokeLLM: async () => {
      llmCallCount++;
      return { content: 'turn:plan', usage: {} };
    },
  };
  const embedder = makeStubEmbedder(); // All messages embed to the same vector → always similar.
  const sessionId = 'test-cache-session';

  // First call — cold cache → LLM fires.
  const r1 = await classifyTurnType(db, { query: 'A', session_id: sessionId }, mockHost, embedder);
  assert.equal(r1, 'turn:plan');
  assert.equal(llmCallCount, 1);

  // Second call with same session and similar message → cache hit → no LLM.
  const r2 = await classifyTurnType(db, { query: 'A', session_id: sessionId }, mockHost, embedder);
  assert.equal(r2, 'turn:plan');
  assert.equal(llmCallCount, 1, 'LLM should not be called again on cache hit');

  await close(db);
  _clearCacheForTest();
});

// ---------------------------------------------------------------------------
// Per-session cache: invalidation on low similarity
// ---------------------------------------------------------------------------

test('classifyTurnType invalidates cache when new message is dissimilar', async () => {
  const db = await fresh();
  await seedTurnPlaybook(db);
  _clearCacheForTest();

  let llmCallCount = 0;
  const mockHost = {
    invokeLLM: async () => {
      llmCallCount++;
      return { content: 'turn:execute_change', usage: {} };
    },
  };
  const embedder = makeDistinctEmbedder();
  const sessionId = 'test-cache-invalidation';

  // First call with message 'A' → cold cache → LLM fires.
  const r1 = await classifyTurnType(db, { query: 'A', session_id: sessionId }, mockHost, embedder);
  assert.equal(r1, 'turn:execute_change');
  assert.equal(llmCallCount, 1);

  // Second call with message 'B' (orthogonal to 'A' → similarity < 0.3) → cache miss → LLM fires again.
  const r2 = await classifyTurnType(db, { query: 'B', session_id: sessionId }, mockHost, embedder);
  assert.equal(r2, 'turn:execute_change');
  assert.equal(llmCallCount, 2, 'LLM should fire again when cache invalidated by low similarity');

  await close(db);
  _clearCacheForTest();
});

// ---------------------------------------------------------------------------
// Tier 1 integration: getPlaybookForInject with declared task_type bypasses classifier
// ---------------------------------------------------------------------------

test('getPlaybookForInject uses declared task_type and bypasses classifier', async () => {
  const db = await fresh();
  await setSelfImprovementV2Enabled(db, true);

  // Insert playbook only for job:daily-briefing — NOT for turn:*
  await db
    .query(
      `CREATE memos CONTENT {
        kind: 'playbook',
        content: 'Job playbook content.',
        derived_by: 'step-playbook-synthesis',
        meta: { task_type: 'job:daily-briefing', active: true }
      }`,
    )
    .collect();

  let llmCallCount = 0;
  const mockHost = {
    invokeLLM: async () => {
      llmCallCount++;
      return { content: 'turn:default', usage: {} };
    },
  };

  // Pass declared task_type — should return job playbook directly, no LLM call.
  const result = await getPlaybookForInject(
    db,
    { task_type: 'job:daily-briefing', query: 'run the job' },
    mockHost,
    null,
  );

  assert.ok(typeof result === 'string' && result.includes('Job playbook'), `expected job playbook; got: ${result}`);
  assert.equal(llmCallCount, 0, 'LLM must not be called for Tier 1 declared task_type');
  await close(db);
  _clearCacheForTest();
});

// ---------------------------------------------------------------------------
// No host → skips Tier 3 gracefully
// ---------------------------------------------------------------------------

test('classifyTurnType returns turn:default when no host is provided (no LLM available)', async () => {
  const db = await fresh();
  await seedTurnPlaybook(db);
  _clearCacheForTest();

  const result = await classifyTurnType(
    db,
    { query: 'recommend something for me' },
    null,   // no host
    null,
  );
  assert.equal(result, 'turn:default');
  await close(db);
  _clearCacheForTest();
});
