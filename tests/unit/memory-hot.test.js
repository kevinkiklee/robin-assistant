import assert from 'node:assert/strict';
import { mkdirSync as __robinMkdirSync } from 'node:fs';
import { tmpdir as __robinTmpdir } from 'node:os';
import { join as __robinJoin, resolve } from 'node:path';
import { test } from 'node:test';
import { surql } from 'surrealdb';
import { recordEvent } from '../../src/capture/record-event.js';
import { close, connect } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { createStubEmbedder } from '../../src/embed/embedder.js';
import { closeEpisode, createEpisode } from '../../src/graph/episodes.js';
import { getHotContext } from '../../src/memory/attention.js';
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

test('getHotContext returns active episodes', async () => {
  const db = await fresh();
  await createEpisode(db, { source: 'cli' });
  const r = await getHotContext(db);
  assert.equal(r.episodes.length, 1);
  assert.equal(r.episodes[0].source, 'cli');
  assert.deepEqual(r.entities, []);
  await close(db);
});

test('getHotContext returns empty when no active episodes', async () => {
  const db = await fresh();
  const r = await getHotContext(db);
  assert.deepEqual(r.episodes, []);
  assert.deepEqual(r.recent_events, []);
  assert.deepEqual(r.entities, []);
  await close(db);
});

test('getHotContext skips closed episodes', async () => {
  const db = await fresh();
  const open = await createEpisode(db, { source: 'cli' });
  const closed = await createEpisode(db, { source: 'cli' });
  await closeEpisode(db, closed.id, {});
  const r = await getHotContext(db);
  assert.equal(r.episodes.length, 1);
  assert.equal(String(r.episodes[0].id), String(open.id));
  await close(db);
});

test('getHotContext filters by source when provided', async () => {
  const db = await fresh();
  await createEpisode(db, { source: 'cli' });
  await createEpisode(db, { source: 'discord' });
  const r = await getHotContext(db, { source: 'discord' });
  assert.equal(r.episodes.length, 1);
  assert.equal(r.episodes[0].source, 'discord');
  await close(db);
});

test('getHotContext returns recent events tied to active episodes', async () => {
  const db = await fresh();
  const e = createStubEmbedder({ dimension: 1024 });
  const ep = await createEpisode(db, { source: 'cli' });
  const evt = await recordEvent(db, e, { source: 'cli', content: 'hello world' });
  // Attach the event to the episode (recordEvent doesn't set episode_id on its own).
  await db.query(surql`UPDATE ${evt.id} SET episode_id = ${ep.id}`).collect();
  const r = await getHotContext(db);
  assert.equal(r.episodes.length, 1);
  assert.equal(r.recent_events.length, 1);
  assert.match(r.recent_events[0].content, /hello/);
  await close(db);
});

test('getHotContext drops events older than the window', async () => {
  const db = await fresh();
  const e = createStubEmbedder({ dimension: 1024 });
  const ep = await createEpisode(db, { source: 'cli' });
  const evt = await recordEvent(db, e, {
    source: 'cli',
    content: 'ancient event',
    ts: '2020-01-01T00:00:00Z',
  });
  await db.query(surql`UPDATE ${evt.id} SET episode_id = ${ep.id}`).collect();
  const r = await getHotContext(db, { windowMinutes: 30 });
  assert.equal(r.recent_events.length, 0);
  await close(db);
});

test('getHotContext validates windowMinutes', async () => {
  const db = await fresh();
  await assert.rejects(() => getHotContext(db, { windowMinutes: 0 }), /windowMinutes out of range/);
  await close(db);
});
