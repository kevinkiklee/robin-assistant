import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { surql } from 'surrealdb';
import { close, connect } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import {
  createCandidate,
  findIdenticalProfileCandidate,
  findOverlappingPendingCandidate,
  listCandidates,
  updateCandidateStatus,
} from '../../src/rules/candidates.js';

import { mkdirSync as __robinMkdirSync } from 'node:fs';
import { tmpdir as __robinTmpdir } from 'node:os';
import { join as __robinJoin } from 'node:path';
import { writeConfig as __robinWriteConfig } from '../../src/runtime/config.js';

// __robin_test_home_setup__
const __robinTestHome = __robinJoin(
  __robinTmpdir(),
  `robin-test-${process.pid}-${Math.random().toString(36).slice(2)}`,
);
__robinMkdirSync(__robinTestHome, { recursive: true });
process.env.ROBIN_HOME = __robinTestHome;
await __robinWriteConfig({ embedder_profile: 'mxbai-1024' });

async function fresh() {
  const db = await connect({ engine: 'mem://' });
  await runMigrations(db, resolve(import.meta.dirname, '../../src/schema/migrations'));
  return db;
}

// Helper: create a real `events` row so we can pass record links into
// rule_candidates.signal_events (which is `array<record<events>>` SCHEMAFULL).
const DUMMY_EMBEDDING = Array.from({ length: 384 }, () => 0.1);
async function createEvent(db, content) {
  const [created] = await db
    .query(
      surql`CREATE events CONTENT ${{
        source: 'cli',
        content,
        content_hash: content,
        embedding: DUMMY_EMBEDDING,
      }}`,
    )
    .collect();
  const row = Array.isArray(created) ? created[0] : created;
  return row.id;
}

test('createCandidate writes a pending row', async () => {
  const db = await fresh();
  const r = await createCandidate(db, {
    content: 'prefer concise',
    kind: 'behavior',
    signal_events: [],
    confidence: 0.8,
  });
  assert.ok(r.id);
  const list = await listCandidates(db);
  assert.equal(list.length, 1);
  assert.equal(list[0].status, 'pending');
  assert.equal(list[0].kind, 'behavior');
  assert.equal(list[0].content, 'prefer concise');
  await close(db);
});

test('updateCandidateStatus moves to rejected', async () => {
  const db = await fresh();
  const r = await createCandidate(db, {
    content: 'x',
    kind: 'behavior',
    signal_events: [],
    confidence: 0.5,
  });
  await updateCandidateStatus(db, r.id, 'rejected', 'not relevant');
  const list = await listCandidates(db, { status: 'rejected' });
  assert.equal(list.length, 1);
  assert.equal(list[0].rejected_reason, 'not relevant');
  await close(db);
});

test('findIdenticalProfileCandidate returns existing match', async () => {
  const db = await fresh();
  await createCandidate(db, {
    content: 'set name',
    kind: 'profile_update',
    signal_events: [],
    payload: { fields: { name: 'Kevin' } },
    confidence: 0.9,
  });
  const id = await findIdenticalProfileCandidate(db, { name: 'Kevin' });
  assert.ok(id);
  const id2 = await findIdenticalProfileCandidate(db, { name: 'Different' });
  assert.equal(id2, null);
  await close(db);
});

test('findOverlappingPendingCandidate detects ≥ threshold overlap', async () => {
  const db = await fresh();
  const a = await createEvent(db, 'a');
  const b = await createEvent(db, 'b');
  const c = await createEvent(db, 'c');
  const r = await createCandidate(db, {
    content: 'be concise',
    kind: 'behavior',
    signal_events: [a, b],
    confidence: 0.8,
  });
  // 1 of 2 overlapping = 0.5 (== default threshold) → match
  const hit = await findOverlappingPendingCandidate(db, 'behavior', [a, c]);
  assert.ok(hit);
  assert.equal(String(hit), String(r.id));

  // No overlap → null
  const d = await createEvent(db, 'd');
  const e = await createEvent(db, 'e');
  const miss = await findOverlappingPendingCandidate(db, 'behavior', [d, e]);
  assert.equal(miss, null);

  // Different kind → null even with full overlap
  const wrongKind = await findOverlappingPendingCandidate(db, 'profile_update', [a, b]);
  assert.equal(wrongKind, null);
  await close(db);
});

test('findOverlappingPendingCandidate ignores approved candidates', async () => {
  const db = await fresh();
  const a = await createEvent(db, 'a');
  const r = await createCandidate(db, {
    content: 'x',
    kind: 'behavior',
    signal_events: [a],
    confidence: 0.7,
  });
  await updateCandidateStatus(db, r.id, 'approved');
  const hit = await findOverlappingPendingCandidate(db, 'behavior', [a]);
  assert.equal(hit, null);
  await close(db);
});

test('findOverlappingPendingCandidate handles empty signal_events without false positives', async () => {
  const db = await fresh();
  await createCandidate(db, {
    content: 'x',
    kind: 'behavior',
    signal_events: [],
    confidence: 0.7,
  });
  const a = await createEvent(db, 'a');
  const hit = await findOverlappingPendingCandidate(db, 'behavior', [a]);
  // Existing has 0 events, proposed has 1 → intersection 0, overlap 0
  assert.equal(hit, null);
  await close(db);
});
