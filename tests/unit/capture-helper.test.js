import assert from 'node:assert/strict';
import { mkdirSync as __robinMkdirSync } from 'node:fs';
import { tmpdir as __robinTmpdir } from 'node:os';
import { join as __robinJoin, resolve } from 'node:path';
import { test } from 'node:test';
import { surql } from 'surrealdb';
import { close, connect } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { createStubEmbedder } from '../../src/embed/embedder.js';
import { activeProfile, embeddingTable } from '../../src/embed/profile-router.js';
import { createCapture } from '../../src/integrations/_framework/capture.js';
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

test('capture inserts new rows with deterministic IDs', async () => {
  const db = await fresh();
  const e = createStubEmbedder({ dimension: 1024 });
  const capture = createCapture({
    db,
    embedder: e,
    source: 'gmail',
    embed: true,
    mode: 'insert-or-skip',
  });
  const r = await capture([
    { source: 'gmail', content: 'Subject: hi', external_id: 'abc123', meta: { thread_id: 't1' } },
  ]);
  assert.equal(r.inserted, 1);
  // External id moved into meta.external_id in the new schema.
  const [rows] = await db.query(surql`SELECT id, meta FROM events`).collect();
  assert.equal(rows.length, 1);
  assert.equal(String(rows[0].id), 'events:gmail__abc123');
  assert.equal(rows[0].meta.external_id, 'abc123');
  await close(db);
});

test('capture insert-or-skip dedupes on second call', async () => {
  const db = await fresh();
  const e = createStubEmbedder({ dimension: 1024 });
  const capture = createCapture({
    db,
    embedder: e,
    source: 'gmail',
    embed: true,
    mode: 'insert-or-skip',
  });
  await capture([{ source: 'gmail', content: 'a', external_id: 'x' }]);
  const r = await capture([{ source: 'gmail', content: 'a', external_id: 'x' }]);
  assert.equal(r.skipped, 1);
  assert.equal(r.inserted, 0);
  await close(db);
});

test('capture upsert updates existing row', async () => {
  const db = await fresh();
  const e = createStubEmbedder({ dimension: 1024 });
  const capture = createCapture({
    db,
    embedder: e,
    source: 'lunch_money',
    embed: true,
    mode: 'upsert',
  });
  await capture([{ source: 'lunch_money', content: 'orig', external_id: 'lm1' }]);
  await capture([{ source: 'lunch_money', content: 'edited', external_id: 'lm1' }]);
  const [rows] = await db
    .query(surql`SELECT content FROM events WHERE meta.external_id = 'lm1'`)
    .collect();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].content, 'edited');
  await close(db);
});

test('capture with embed:false does not write an embedding row', async () => {
  const db = await fresh();
  const e = createStubEmbedder({ dimension: 1024 });
  const capture = createCapture({
    db,
    embedder: e,
    source: 'discord',
    embed: false,
    mode: 'insert-or-skip',
  });
  await capture([{ source: 'discord', content: 'msg', external_id: 'd1' }]);
  // Per-surface embeddings table — no row should exist when embed:false.
  const profile = await activeProfile(db);
  const tbl = embeddingTable(profile, 'events');
  const [embRows] = await db.query(`SELECT count() AS n FROM ${tbl} GROUP ALL`).collect();
  const n = embRows[0]?.n ?? 0;
  assert.equal(n, 0);
  await close(db);
});

test('capture sanitizes special-char external_id', async () => {
  const db = await fresh();
  const e = createStubEmbedder({ dimension: 1024 });
  const capture = createCapture({
    db,
    embedder: e,
    source: 'x',
    embed: true,
    mode: 'insert-or-skip',
  });
  const r = await capture([{ source: 'x', content: 'c', external_id: 'foo/bar:baz' }]);
  assert.equal(r.inserted, 1);
  await close(db);
});
