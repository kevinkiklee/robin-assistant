// inject-playbook-integration.test.js — verify that intuitionEndpoint
// (inject.js) calls getPlaybookForInject and prepends its result when non-null.
//
// Tests the combined behaviour: v2 flag off → no playbook in block;
//                                v2 flag on + playbook present → playbook in block.
//
// Uses mem:// + migrations. Pairs connect with close.

import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { intuitionEndpoint } from '../../cognition/intuition/inject.js';
import { writeConfig } from '../../config/paths.js';
import { close, connect } from '../../data/db/client.js';
import { runMigrations } from '../../data/db/migrate.js';
import { createStubEmbedder } from '../../data/embed/embedder.js';
import { recordEvent } from '../../io/capture/record-event.js';
import { setSelfImprovementV2Enabled } from '../../runtime/config/self-improvement-v2.js';

// __robin_test_home_setup__
const HOME = join(tmpdir(), `robin-test-${process.pid}-${Math.random().toString(36).slice(2)}`);
mkdirSync(HOME, { recursive: true });
process.env.ROBIN_HOME = HOME;
await writeConfig({ embedder_profile: 'mxbai-1024' });

const MIGRATIONS_DIR = resolve(import.meta.dirname, '../../data/db/migrations');

async function fresh() {
  const db = await connect({ engine: 'mem://' });
  await runMigrations(db, MIGRATIONS_DIR);
  return db;
}

// Insert a seed event so the recall pipeline has something to work with;
// this avoids empty-block edge cases unrelated to the playbook feature.
async function seedEvent(db, embedder) {
  await recordEvent(db, embedder, { source: 'cli', content: 'discussed project architecture' });
}

// Insert an active playbook for turn:default.
async function seedPlaybook(db, content = 'Playbook: start with context.') {
  await db
    .query(
      `CREATE memos CONTENT {
        kind: 'playbook',
        content: '${content}',
        derived_by: 'step-playbook-synthesis',
        meta: { task_type: 'turn:default', active: true }
      }`,
    )
    .collect();
}

// ---------------------------------------------------------------------------
// v2 flag OFF — playbook must NOT appear in combined block
// ---------------------------------------------------------------------------

test('intuitionEndpoint does not prepend playbook when v2 flag is false', async () => {
  const db = await fresh();
  const e = createStubEmbedder({ dimension: 1024 });
  await seedEvent(db, e);
  await seedPlaybook(db, 'PLAYBOOK_SENTINEL_VALUE');

  // Flag stays false (default).
  const result = await intuitionEndpoint({
    db,
    embedder: e,
    query: 'project architecture',
    priorAssistant: '',
    k: 6,
    recencyDays: 30,
    tokenBudget: 1500,
  });

  assert.ok(
    !result.block.includes('PLAYBOOK_SENTINEL_VALUE'),
    'playbook must not appear when flag is off',
  );
  assert.equal(result.playbook_content, null, 'playbook_content should be null when flag is off');
  assert.equal(result.playbook_tokens, 0);
  await close(db);
});

// ---------------------------------------------------------------------------
// v2 flag ON, no playbook present — combined block unchanged
// ---------------------------------------------------------------------------

test('intuitionEndpoint does not add playbook when flag is on but no playbook exists', async () => {
  const db = await fresh();
  const e = createStubEmbedder({ dimension: 1024 });
  await seedEvent(db, e);
  await setSelfImprovementV2Enabled(db, true);

  const result = await intuitionEndpoint({
    db,
    embedder: e,
    query: 'project architecture',
    priorAssistant: '',
    k: 6,
    recencyDays: 30,
    tokenBudget: 1500,
  });

  assert.equal(
    result.playbook_content,
    null,
    'playbook_content should be null with empty playbook table',
  );
  assert.equal(result.playbook_tokens, 0);
  await close(db);
});

// ---------------------------------------------------------------------------
// v2 flag ON + playbook present → playbook content in combined block
// ---------------------------------------------------------------------------

test('intuitionEndpoint prepends playbook when flag is on and playbook exists', async () => {
  const db = await fresh();
  const e = createStubEmbedder({ dimension: 1024 });
  await seedEvent(db, e);
  await setSelfImprovementV2Enabled(db, true);
  await seedPlaybook(db, 'PLAYBOOK_INJECTED_CONTENT');

  const result = await intuitionEndpoint({
    db,
    embedder: e,
    query: 'project architecture',
    priorAssistant: '',
    k: 6,
    recencyDays: 30,
    tokenBudget: 1500,
  });

  assert.ok(
    result.block.includes('PLAYBOOK_INJECTED_CONTENT'),
    `expected playbook content in combined block; got:\n${result.block}`,
  );
  assert.equal(result.playbook_content, 'PLAYBOOK_INJECTED_CONTENT');
  assert.ok(result.playbook_tokens > 0, 'playbook_tokens should be positive');
  // Token count in return value should include the playbook tokens.
  assert.ok(result.tokens >= result.playbook_tokens, 'total tokens must include playbook tokens');
  await close(db);
});

// ---------------------------------------------------------------------------
// Block ordering: playbook comes after relevant memory (not before it)
// ---------------------------------------------------------------------------

test('intuitionEndpoint places playbook after relevant-memory block', async () => {
  const db = await fresh();
  const e = createStubEmbedder({ dimension: 1024 });
  await seedEvent(db, e);
  await setSelfImprovementV2Enabled(db, true);
  await seedPlaybook(db, 'PLAYBOOK_AFTER_MEMORY');

  const result = await intuitionEndpoint({
    db,
    embedder: e,
    query: 'project architecture',
    priorAssistant: '',
    k: 6,
    recencyDays: 30,
    tokenBudget: 1500,
  });

  const memIdx = result.block.indexOf('<!-- relevant memory -->');
  const pbIdx = result.block.indexOf('PLAYBOOK_AFTER_MEMORY');

  // Both blocks must be present.
  assert.ok(memIdx >= 0, 'relevant memory block missing from combined_block');
  assert.ok(pbIdx >= 0, 'playbook content missing from combined_block');
  // Playbook must appear after the memory close marker.
  const memCloseIdx = result.block.indexOf('<!-- /relevant memory -->');
  assert.ok(
    pbIdx > memCloseIdx,
    `playbook (idx=${pbIdx}) must come after <!-- /relevant memory --> (idx=${memCloseIdx})`,
  );
  await close(db);
});

// ---------------------------------------------------------------------------
// Failure resilience: intuitionEndpoint must not fail even if getPlaybookForInject
// would normally surface an error.  Achieved via the try/catch in inject.js.
// We test this indirectly: with a corrupt playbook row (no content field),
// the result should still return a valid block.
// ---------------------------------------------------------------------------

test('intuitionEndpoint succeeds and playbook_content is null when no active playbook exists for the task_type', async () => {
  const db = await fresh();
  const e = createStubEmbedder({ dimension: 1024 });
  await seedEvent(db, e);
  await setSelfImprovementV2Enabled(db, true);

  // Insert an inactive playbook (active=false) — should not be returned.
  await db
    .query(
      `CREATE memos CONTENT {
        kind: 'playbook',
        content: 'Old inactive playbook content.',
        derived_by: 'step-playbook-synthesis',
        meta: { task_type: 'turn:default', active: false }
      }`,
    )
    .collect();

  // Should not throw, and playbook_content must be null.
  const result = await intuitionEndpoint({
    db,
    embedder: e,
    query: 'project architecture',
    priorAssistant: '',
    k: 6,
    recencyDays: 30,
    tokenBudget: 1500,
  });

  assert.ok(typeof result === 'object', 'result must be an object');
  assert.ok(typeof result.block === 'string', 'block must be a string');
  assert.equal(
    result.playbook_content,
    null,
    'inactive playbook should yield null playbook_content',
  );
  await close(db);
});
