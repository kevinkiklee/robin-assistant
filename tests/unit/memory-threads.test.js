import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { close, connect } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { createStubEmbedder } from '../../src/embed/embedder.js';
import { createEpisode } from '../../src/graph/episodes.js';
import { createThread, listThreads } from '../../src/memory/narrative.js';

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

test('createThread writes a row', async () => {
  const db = await fresh();
  const e = createStubEmbedder({ dimension: 1024 });
  const ep1 = await createEpisode(db, { source: 'cli' });
  const ep2 = await createEpisode(db, { source: 'cli' });
  const r = await createThread(db, e, {
    title: 'Atlas project',
    episode_ids: [ep1.id, ep2.id],
    entity_ids: [],
  });
  assert.ok(r.id);
  await close(db);
});

test('listThreads returns recent threads', async () => {
  const db = await fresh();
  const e = createStubEmbedder({ dimension: 1024 });
  const ep = await createEpisode(db, { source: 'cli' });
  await createThread(db, e, { title: 't1', episode_ids: [ep.id], entity_ids: [] });
  await createThread(db, e, { title: 't2', episode_ids: [ep.id], entity_ids: [] });
  const list = await listThreads(db);
  assert.ok(list.length >= 2);
  await close(db);
});
