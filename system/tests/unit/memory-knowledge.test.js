import assert from 'node:assert/strict';
import { mkdirSync as __robinMkdirSync } from 'node:fs';
import { tmpdir as __robinTmpdir } from 'node:os';
import { join as __robinJoin, resolve } from 'node:path';
import { test } from 'node:test';
import { surql } from 'surrealdb';
import { close, connect } from '../../data/db/client.js';
import { runMigrations } from '../../data/db/migrate.js';
import { createStubEmbedder } from '../../data/embed/embedder.js';
import {
  createKnowledge,
  getKnowledgeByContentHash,
  listKnowledge,
  searchKnowledge,
} from '../../cognition/memory/knowledge.js';
import { writeConfig as __robinWriteConfig } from '../../config/paths.js';

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

test('createKnowledge writes a row with content_hash', async () => {
  const db = await fresh();
  const e = createStubEmbedder({ dimension: 1024 });
  const r = await createKnowledge(db, e, {
    content: 'Alice works on Atlas',
    confidence: 0.9,
    source_events: [],
    source_episodes: [],
  });
  assert.ok(r.id);
  const [rows] = await db
    .query(surql`SELECT count() AS n FROM memos WHERE kind = 'knowledge' GROUP ALL`)
    .collect();
  assert.equal(rows[0].n, 1);
  await close(db);
});

test('getKnowledgeByContentHash dedupes', async () => {
  const db = await fresh();
  const e = createStubEmbedder({ dimension: 1024 });
  await createKnowledge(db, e, {
    content: 'fact',
    confidence: 0.9,
    source_events: [],
    source_episodes: [],
  });
  const existing = await getKnowledgeByContentHash(db, 'fact');
  assert.ok(existing);
  await close(db);
});

test('searchKnowledge returns vector-similar results', async () => {
  const db = await fresh();
  const e = createStubEmbedder({ dimension: 1024 });
  await createKnowledge(db, e, {
    content: 'apple is red',
    confidence: 0.9,
    source_events: [],
    source_episodes: [],
  });
  await createKnowledge(db, e, {
    content: 'banana is yellow',
    confidence: 0.9,
    source_events: [],
    source_episodes: [],
  });
  // Stub embedder is sha256-derived, not semantic — query the exact content
  // so the closest neighbour is deterministic.
  const hits = await searchKnowledge(db, e, 'apple is red', { limit: 1 });
  assert.ok(hits.length >= 1);
  assert.match(hits[0].content, /apple/);
  await close(db);
});

test('listKnowledge filters by subject_id when provided', async () => {
  const db = await fresh();
  const e = createStubEmbedder({ dimension: 1024 });
  const [created] = await db
    .query(surql`CREATE entities CONTENT ${{ name: 'Alice', type: 'person' }}`)
    .collect();
  const aliceId = (Array.isArray(created) ? created[0] : created).id;
  await createKnowledge(db, e, {
    content: 'fact about alice',
    subject_id: aliceId,
    confidence: 0.9,
    source_events: [],
    source_episodes: [],
  });
  await createKnowledge(db, e, {
    content: 'unrelated fact',
    confidence: 0.9,
    source_events: [],
    source_episodes: [],
  });
  const filtered = await listKnowledge(db, { subject_id: aliceId });
  assert.equal(filtered.length, 1);
  await close(db);
});
