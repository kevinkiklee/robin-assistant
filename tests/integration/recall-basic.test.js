import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { recordEvent } from '../../src/capture/record-event.js';
import { close, connect } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { createStubEmbedder } from '../../src/embed/embedder.js';
import { recall } from '../../src/recall/index.js';

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

test('recall on empty DB returns empty hits, no error', async () => {
  const db = await fresh();
  const e = createStubEmbedder({ dimension: 1024 });
  const r = await recall(db, e, 'anything');
  assert.deepEqual(r.hits, []);
  await close(db);
});

test('recall returns the most-similar event first', async () => {
  const db = await fresh();
  const e = createStubEmbedder({ dimension: 1024 });
  await recordEvent(db, e, { source: 'cli', content: 'apple' });
  await recordEvent(db, e, { source: 'cli', content: 'banana' });
  await recordEvent(db, e, { source: 'cli', content: 'cherry' });
  const r = await recall(db, e, 'banana', { limit: 3 });
  assert.equal(r.hits.length, 3);
  assert.equal(r.hits[0].content, 'banana');
  await close(db);
});

test('recall --source filter excludes other sources', async () => {
  const db = await fresh();
  const e = createStubEmbedder({ dimension: 1024 });
  await recordEvent(db, e, { source: 'cli', content: 'one' });
  await recordEvent(db, e, { source: 'manual', content: 'two' });
  const r = await recall(db, e, 'one', { source: 'manual', limit: 5 });
  for (const h of r.hits) assert.equal(h.source, 'manual');
  await close(db);
});

test('recall since/until filter excludes events outside time window', async () => {
  const db = await fresh();
  const e = createStubEmbedder({ dimension: 1024 });
  const old = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000); // 7d ago
  await recordEvent(db, e, { source: 'cli', content: 'old', ts: old });
  await recordEvent(db, e, { source: 'cli', content: 'new' });
  const r = await recall(db, e, 'old', {
    since: new Date(Date.now() - 24 * 60 * 60 * 1000),
    limit: 10,
  });
  for (const h of r.hits) assert.notEqual(h.content, 'old');
  await close(db);
});

test('recall opts.explain attaches EXPLAIN FULL output', async () => {
  const db = await fresh();
  const e = createStubEmbedder({ dimension: 1024 });
  await recordEvent(db, e, { source: 'cli', content: 'x' });
  const r = await recall(db, e, 'x', { explain: true });
  assert.ok(typeof r.explain === 'string' && r.explain.length > 0);
  await close(db);
});
