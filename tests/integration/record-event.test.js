import assert from 'node:assert/strict';
import { mkdirSync as __robinMkdirSync } from 'node:fs';
import { tmpdir as __robinTmpdir } from 'node:os';
import { join as __robinJoin, resolve } from 'node:path';
import { test } from 'node:test';
import { recordEvent } from '../../src/capture/record-event.js';
import { close, connect } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { createStubEmbedder } from '../../src/embed/embedder.js';
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
  const dir = resolve(import.meta.dirname, '../../src/schema/migrations');
  await runMigrations(db, dir);
  return db;
}

test('recordEvent inserts a row + embedding in the per-profile surface', async () => {
  const db = await fresh();
  const embedder = createStubEmbedder({ dimension: 1024 });
  const result = await recordEvent(db, embedder, {
    source: 'cli',
    content: 'hello robin',
  });
  assert.ok(result.id);
  const [rows] = await db.query('SELECT * FROM events').collect();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].source, 'cli');
  assert.equal(rows[0].content, 'hello robin');
  // Embedding lives in the per-profile events surface, not on the event row.
  const [embRows] = await db.query('SELECT vector FROM embeddings_mxbai_1024_events').collect();
  assert.equal(embRows.length, 1);
  assert.equal(embRows[0].vector.length, 1024);
  await close(db);
});

test('recordEvent populates content_hash for each insert', async () => {
  const db = await fresh();
  const embedder = createStubEmbedder({ dimension: 1024 });
  await recordEvent(db, embedder, { source: 'cli', content: 'duplicate' });
  await recordEvent(db, embedder, { source: 'cli', content: 'duplicate' });
  // recordEvent does not dedupe — it's the firehose primitive. Both rows land
  // and carry the same content_hash; dedup is opt-in via `store.remember`.
  const [rows] = await db.query('SELECT content_hash, ts FROM events ORDER BY ts ASC').collect();
  assert.equal(rows.length, 2);
  assert.equal(rows[0].content_hash, rows[1].content_hash);
  await close(db);
});

test('recordEvent rejects unknown source enum', async () => {
  const db = await fresh();
  const embedder = createStubEmbedder({ dimension: 1024 });
  await assert.rejects(
    recordEvent(db, embedder, { source: 'invalid_src', content: 'x' }),
    /source/i,
  );
  await close(db);
});

test('recordEvent rejects empty content', async () => {
  const db = await fresh();
  const embedder = createStubEmbedder({ dimension: 1024 });
  await assert.rejects(recordEvent(db, embedder, { source: 'cli', content: '' }), /content/i);
  await close(db);
});

test('recordEvent rejects wrong embedding dimension at the DB layer', async () => {
  const db = await fresh();
  const embedder = createStubEmbedder({ dimension: 768 }); // wrong; schema asserts 1024
  await assert.rejects(
    recordEvent(db, embedder, { source: 'cli', content: 'x' }),
    /array::len|1024/,
  );
  await close(db);
});
