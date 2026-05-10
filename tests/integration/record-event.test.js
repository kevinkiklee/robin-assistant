import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { recordEvent } from '../../src/capture/record-event.js';
import { close, connect } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { createStubEmbedder } from '../../src/embed/embedder.js';

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
  const dir = resolve(import.meta.dirname, '../../src/schema/migrations');
  await runMigrations(db, dir);
  return db;
}

test('recordEvent inserts a row with embedding', async () => {
  const db = await fresh();
  const embedder = createStubEmbedder({ dimension: 384 });
  const result = await recordEvent(db, embedder, {
    source: 'cli',
    content: 'hello robin',
  });
  assert.ok(result.id);
  const [rows] = await db.query('SELECT * FROM events').collect();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].source, 'cli');
  assert.equal(rows[0].content, 'hello robin');
  assert.equal(rows[0].embedding.length, 384);
  await close(db);
});

test('recordEvent populates content_hash and reuses embedding on duplicate content', async () => {
  const db = await fresh();
  const embedder = createStubEmbedder({ dimension: 384 });
  let embedCalls = 0;
  const counted = {
    ...embedder,
    embed: async (t) => {
      embedCalls++;
      return embedder.embed(t);
    },
  };
  await recordEvent(db, counted, { source: 'cli', content: 'duplicate' });
  await recordEvent(db, counted, { source: 'cli', content: 'duplicate' });
  assert.equal(embedCalls, 1, 'second insert should hit cache');
  const [rows] = await db.query('SELECT count() AS n FROM events GROUP ALL').collect();
  assert.equal(rows[0].n, 2);
  await close(db);
});

test('recordEvent rejects unknown source enum', async () => {
  const db = await fresh();
  const embedder = createStubEmbedder({ dimension: 384 });
  await assert.rejects(
    recordEvent(db, embedder, { source: 'invalid_src', content: 'x' }),
    /source/i,
  );
  await close(db);
});

test('recordEvent rejects empty content', async () => {
  const db = await fresh();
  const embedder = createStubEmbedder({ dimension: 384 });
  await assert.rejects(recordEvent(db, embedder, { source: 'cli', content: '' }), /content/i);
  await close(db);
});

test('recordEvent rejects wrong embedding dimension at the DB layer', async () => {
  const db = await fresh();
  const embedder = createStubEmbedder({ dimension: 768 }); // wrong; schema asserts 384
  await assert.rejects(
    recordEvent(db, embedder, { source: 'cli', content: 'x' }),
    /array::len|384/,
  );
  await close(db);
});
