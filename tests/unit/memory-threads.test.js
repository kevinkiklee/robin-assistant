import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { close, connect } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { createEpisode } from '../../src/graph/episodes.js';
import { createThread, listThreads } from '../../src/memory/threads.js';

async function fresh() {
  const db = await connect({ engine: 'mem://' });
  await runMigrations(db, resolve(import.meta.dirname, '../../src/schema/migrations'));
  return db;
}

test('createThread writes a row', async () => {
  const db = await fresh();
  const ep1 = await createEpisode(db, { source: 'cli' });
  const ep2 = await createEpisode(db, { source: 'cli' });
  const r = await createThread(db, {
    title: 'Atlas project',
    episode_ids: [ep1.id, ep2.id],
    entity_ids: [],
  });
  assert.ok(r.id);
  await close(db);
});

test('listThreads returns recent threads', async () => {
  const db = await fresh();
  const ep = await createEpisode(db, { source: 'cli' });
  await createThread(db, { title: 't1', episode_ids: [ep.id], entity_ids: [] });
  await createThread(db, { title: 't2', episode_ids: [ep.id], entity_ids: [] });
  const list = await listThreads(db);
  assert.ok(list.length >= 2);
  await close(db);
});
