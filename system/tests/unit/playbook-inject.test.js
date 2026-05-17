// playbook-inject.test.js — unit tests for system/cognition/intuition/playbook-inject.js
//
// Uses mem:// + migrations so the memos table schema is available.
// Always pairs connect with close to avoid NAPI handle leaks.

import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { writeConfig } from '../../config/paths.js';
import { close, connect } from '../../data/db/client.js';
import { runMigrations } from '../../data/db/migrate.js';
import { setSelfImprovementV2Enabled } from '../../runtime/config/self-improvement-v2.js';
import {
  classifyTaskType,
  fetchActivePlaybook,
  getPlaybookForInject,
} from '../../cognition/intuition/playbook-inject.js';

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

// ---------------------------------------------------------------------------
// classifyTaskType — Phase 1 stub behavior
// ---------------------------------------------------------------------------

test('classifyTaskType returns turn:default for any input (Phase 1 stub)', () => {
  // Assert explicitly so a Wave 3 swap is obvious when this test breaks.
  assert.equal(classifyTaskType({}), 'turn:default');
  assert.equal(classifyTaskType({ query: 'analyze this code' }), 'turn:default');
  assert.equal(classifyTaskType(null), 'turn:default');
  assert.equal(classifyTaskType(undefined), 'turn:default');
  assert.equal(classifyTaskType('raw string'), 'turn:default');
});

// ---------------------------------------------------------------------------
// fetchActivePlaybook — no playbook present
// ---------------------------------------------------------------------------

test('fetchActivePlaybook returns null when no playbook row exists', async () => {
  const db = await fresh();
  const result = await fetchActivePlaybook(db, 'turn:default');
  assert.equal(result, null);
  await close(db);
});

// ---------------------------------------------------------------------------
// fetchActivePlaybook — playbook present with meta.active=true
// ---------------------------------------------------------------------------

test('fetchActivePlaybook returns the row when meta.active=true', async () => {
  const db = await fresh();
  await db
    .query(
      `CREATE memos CONTENT {
        kind: 'playbook',
        content: 'Step 1: do X. Step 2: do Y.',
        derived_by: 'step-playbook-synthesis',
        meta: { task_type: 'turn:default', active: true }
      }`,
    )
    .collect();

  const row = await fetchActivePlaybook(db, 'turn:default');
  assert.ok(row !== null, 'expected a row, got null');
  assert.equal(row.kind, 'playbook');
  assert.equal(row.content, 'Step 1: do X. Step 2: do Y.');
  assert.equal(row.meta.active, true);
  assert.equal(row.meta.task_type, 'turn:default');
  await close(db);
});

// ---------------------------------------------------------------------------
// fetchActivePlaybook — meta.active=false should NOT be returned
// ---------------------------------------------------------------------------

test('fetchActivePlaybook does not return rows with meta.active=false', async () => {
  const db = await fresh();
  await db
    .query(
      `CREATE memos CONTENT {
        kind: 'playbook',
        content: 'Old superseded playbook.',
        derived_by: 'step-playbook-synthesis',
        meta: { task_type: 'turn:default', active: false }
      }`,
    )
    .collect();

  const result = await fetchActivePlaybook(db, 'turn:default');
  assert.equal(result, null, 'inactive playbook should not be returned');
  await close(db);
});

// ---------------------------------------------------------------------------
// fetchActivePlaybook — different task_type should NOT be returned
// ---------------------------------------------------------------------------

test('fetchActivePlaybook does not return playbook for a different task_type', async () => {
  const db = await fresh();
  await db
    .query(
      `CREATE memos CONTENT {
        kind: 'playbook',
        content: 'Playbook for job:daily-briefing.',
        derived_by: 'step-playbook-synthesis',
        meta: { task_type: 'job:daily-briefing', active: true }
      }`,
    )
    .collect();

  const result = await fetchActivePlaybook(db, 'turn:default');
  assert.equal(result, null, 'playbook for different task_type should not match');
  await close(db);
});

// ---------------------------------------------------------------------------
// fetchActivePlaybook — DB error is caught, returns null
// ---------------------------------------------------------------------------

test('fetchActivePlaybook returns null when db throws (error is caught)', async () => {
  // Simulate a broken db by passing an object whose .query always throws.
  const brokenDb = {
    query: () => {
      throw new Error('simulated db failure');
    },
  };
  const result = await fetchActivePlaybook(brokenDb, 'turn:default');
  assert.equal(result, null);
});

// ---------------------------------------------------------------------------
// getPlaybookForInject — flag is false → always null
// ---------------------------------------------------------------------------

test('getPlaybookForInject returns null when v2 flag is false (regardless of playbook presence)', async () => {
  const db = await fresh();
  // Insert an active playbook — should still be skipped when flag is off.
  await db
    .query(
      `CREATE memos CONTENT {
        kind: 'playbook',
        content: 'Playbook content that should be gated.',
        derived_by: 'step-playbook-synthesis',
        meta: { task_type: 'turn:default', active: true }
      }`,
    )
    .collect();
  // Flag stays false (default).
  const result = await getPlaybookForInject(db, {});
  assert.equal(result, null, 'expected null when flag is off');
  await close(db);
});

// ---------------------------------------------------------------------------
// getPlaybookForInject — flag is true, no playbook → null
// ---------------------------------------------------------------------------

test('getPlaybookForInject returns null when flag is true but no playbook exists', async () => {
  const db = await fresh();
  await setSelfImprovementV2Enabled(db, true);
  const result = await getPlaybookForInject(db, {});
  assert.equal(result, null, 'expected null with empty playbook table');
  await close(db);
});

// ---------------------------------------------------------------------------
// getPlaybookForInject — flag is true, playbook exists → content returned
// ---------------------------------------------------------------------------

test('getPlaybookForInject returns playbook content when flag is true and playbook exists', async () => {
  const db = await fresh();
  await setSelfImprovementV2Enabled(db, true);
  await db
    .query(
      `CREATE memos CONTENT {
        kind: 'playbook',
        content: 'Always start with the why.',
        derived_by: 'step-playbook-synthesis',
        meta: { task_type: 'turn:default', active: true }
      }`,
    )
    .collect();

  const result = await getPlaybookForInject(db, {});
  assert.equal(typeof result, 'string');
  assert.equal(result, 'Always start with the why.');
  await close(db);
});

// ---------------------------------------------------------------------------
// getPlaybookForInject — content truncated to token cap
// ---------------------------------------------------------------------------

test('getPlaybookForInject truncates content to the task_type token cap', async () => {
  const db = await fresh();
  await setSelfImprovementV2Enabled(db, true);

  // turn:default cap is 800 tokens → 3200 chars via chars/4 heuristic.
  // Build a string longer than 3200 chars to trigger truncation.
  const longContent = 'x'.repeat(5000);
  await db
    .query(
      `CREATE memos CONTENT {
        kind: 'playbook',
        content: '${longContent}',
        derived_by: 'step-playbook-synthesis',
        meta: { task_type: 'turn:default', active: true }
      }`,
    )
    .collect();

  const result = await getPlaybookForInject(db, {});
  assert.ok(typeof result === 'string', 'result should be a string');
  // cap=800 tokens × 4 chars = 3200 chars max
  assert.ok(result.length <= 3200, `expected ≤3200 chars, got ${result.length}`);
  await close(db);
});

// ---------------------------------------------------------------------------
// getPlaybookForInject — DB error is caught, returns null (does not throw)
// ---------------------------------------------------------------------------

test('getPlaybookForInject returns null on DB error (catches throw, does not bubble)', async () => {
  const brokenDb = {
    query: () => {
      throw new Error('catastrophic db failure');
    },
  };
  // Must NOT throw — verified by the test completing without an uncaught rejection.
  const result = await getPlaybookForInject(brokenDb, {});
  assert.equal(result, null);
});
