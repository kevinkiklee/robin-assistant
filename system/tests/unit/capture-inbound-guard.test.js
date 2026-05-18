import assert from 'node:assert/strict';
import { mkdirSync as __robinMkdirSync } from 'node:fs';
import { tmpdir as __robinTmpdir } from 'node:os';
import { join as __robinJoin, resolve } from 'node:path';
import { test } from 'node:test';
import { surql } from 'surrealdb';
import { writeConfig as __robinWriteConfig } from '../../config/paths.js';
import { close, connect } from '../../data/db/client.js';
import { runMigrations } from '../../data/db/migrate.js';
import { createStubEmbedder } from '../../data/embed/embedder.js';
import { createCapture } from '../../io/integrations/_framework/capture.js';

const __robinTestHome = __robinJoin(
  __robinTmpdir(),
  `robin-test-${process.pid}-${Math.random().toString(36).slice(2)}`,
);
__robinMkdirSync(__robinTestHome, { recursive: true });
process.env.ROBIN_HOME = __robinTestHome;
await __robinWriteConfig({ embedder_profile: 'mxbai-1024' });

async function fresh() {
  const db = await connect({ engine: 'mem://' });
  await runMigrations(db, resolve(import.meta.dirname, '../../data/db/migrations'));
  return db;
}

test('capture refuses rows whose content matches inbound secret patterns', async () => {
  const db = await fresh();
  const e = createStubEmbedder({ dimension: 1024 });
  const capture = createCapture({
    db,
    embedder: e,
    source: 'gmail',
    embed: true,
    mode: 'insert-or-skip',
  });
  const leakedPat = 'Hey, the API key is ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
  const r = await capture([
    { source: 'gmail', content: leakedPat, external_id: 'leak1' },
    { source: 'gmail', content: 'normal email body', external_id: 'ok1' },
  ]);
  assert.equal(r.refused, 1);
  assert.equal(r.inserted, 1);
  const [rows] = await db.query(surql`SELECT meta FROM events`).collect();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].meta.external_id, 'ok1');
  await close(db);
});

test('capture honours an explicit guard override', async () => {
  const db = await fresh();
  const e = createStubEmbedder({ dimension: 1024 });
  const seen = [];
  const capture = createCapture({
    db,
    embedder: e,
    source: 'gmail',
    embed: true,
    mode: 'insert-or-skip',
    guard: async (_db, content) => {
      seen.push(content);
      return { ok: true };
    },
  });
  await capture([{ source: 'gmail', content: 'whatever', external_id: 'x' }]);
  assert.deepEqual(seen, ['whatever']);
  await close(db);
});

test('capture skips guard when explicitly disabled', async () => {
  const db = await fresh();
  const e = createStubEmbedder({ dimension: 1024 });
  const capture = createCapture({
    db,
    embedder: e,
    source: 'gmail',
    embed: true,
    mode: 'insert-or-skip',
    guard: null,
  });
  const r = await capture([
    {
      source: 'gmail',
      content: 'Hey, the API key is ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      external_id: 'leak2',
    },
  ]);
  assert.equal(r.inserted, 1);
  assert.equal(r.refused, 0);
  await close(db);
});
