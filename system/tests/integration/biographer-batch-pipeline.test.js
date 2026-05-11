import assert from 'node:assert/strict';
import { mkdirSync as __robinMkdirSync } from 'node:fs';
import { tmpdir as __robinTmpdir } from 'node:os';
import { join as __robinJoin, resolve } from 'node:path';
import { test } from 'node:test';
import { surql } from 'surrealdb';
import { biographerProcess, biographerProcessBatch } from '../../cognition/biographer/pipeline.js';
import { writeConfig as __robinWriteConfig } from '../../config/paths.js';
import { close, connect } from '../../data/db/client.js';
import { runMigrations } from '../../data/db/migrate.js';
import { createStubEmbedder } from '../../data/embed/embedder.js';
import { recordEvent } from '../../io/capture/record-event.js';

const __robinTestHome = __robinJoin(
  __robinTmpdir(),
  `robin-test-${process.pid}-${Math.random().toString(36).slice(2)}`,
);
__robinMkdirSync(__robinTestHome, { recursive: true });
process.env.ROBIN_HOME = __robinTestHome;
await __robinWriteConfig({ embedder_profile: 'mxbai-1024' });

function fakeHost(scriptedResponses) {
  let i = 0;
  return {
    name: 'fake',
    isAvailable: async () => true,
    invokeLLM: async () => ({
      content: scriptedResponses[i++ % scriptedResponses.length],
      usage: { input_tokens: 0, output_tokens: 0 },
    }),
  };
}

async function fresh() {
  const db = await connect({ engine: 'mem://' });
  await runMigrations(db, resolve(import.meta.dirname, '../../data/db/migrations'));
  return db;
}

test('biographerProcessBatch with [evt.id] matches single-event end-to-end behaviour', async () => {
  const db = await fresh();
  const e = createStubEmbedder({ dimension: 1024 });
  const evt = await recordEvent(db, e, {
    source: 'cli',
    content: 'Alice met Bob about project Atlas.',
  });
  const host = fakeHost([
    JSON.stringify({
      entities: [
        { name: 'Alice', type: 'person' },
        { name: 'Bob', type: 'person' },
        { name: 'Atlas', type: 'project' },
      ],
      edges: [
        { from: 'Alice', type: 'works_on', to: 'Atlas' },
        { from: 'Bob', type: 'works_on', to: 'Atlas' },
      ],
      about: ['Atlas'],
      episode_continues_previous: false,
      episode_summary: null,
    }),
  ]);
  await biographerProcessBatch(db, e, host, [evt.id]);

  const [evRows] = await db.query(surql`SELECT * FROM ${evt.id}`).collect();
  assert.ok(evRows[0].biographed_at);
  assert.ok(evRows[0].episode_id);

  const [entRows] = await db.query('SELECT count() AS n FROM entities GROUP ALL').collect();
  assert.equal(entRows[0].n, 3);

  const [mentRows] = await db
    .query("SELECT count() AS n FROM edges WHERE kind = 'mentions' GROUP ALL")
    .collect();
  assert.equal(mentRows[0].n, 3);

  const [aboutRows] = await db
    .query("SELECT count() AS n FROM edges WHERE kind = 'about' GROUP ALL")
    .collect();
  assert.equal(aboutRows[0].n, 1);

  const [worksRows] = await db
    .query("SELECT count() AS n FROM edges WHERE kind = 'works_on' GROUP ALL")
    .collect();
  assert.equal(worksRows[0].n, 2);

  await close(db);
});

test('biographerProcess is now a wrapper that delegates to biographerProcessBatch', async () => {
  const db = await fresh();
  const e = createStubEmbedder({ dimension: 1024 });
  const evt = await recordEvent(db, e, { source: 'cli', content: 'Just Alice.' });
  const host = fakeHost([
    JSON.stringify({
      entities: [{ name: 'Alice', type: 'person' }],
      edges: [],
      about: [],
      episode_continues_previous: false,
      episode_summary: null,
    }),
  ]);
  const r = await biographerProcess(db, e, host, evt.id);
  assert.equal(r.processed, true);
  assert.ok(r.episodeId);
  assert.equal(r.entitiesCount, 1);
  await close(db);
});

test('readBatchConfig returns DEFAULT_BATCH_CONFIG on an empty runtime row', async () => {
  const { readBatchConfig, DEFAULT_BATCH_CONFIG } = await import(
    '../../cognition/biographer/pipeline.js'
  );
  const db = await fresh();
  const cfg = await readBatchConfig(db);
  assert.equal(cfg.max_batch_size, DEFAULT_BATCH_CONFIG.max_batch_size);
  assert.equal(cfg.debounce_ms, DEFAULT_BATCH_CONFIG.debounce_ms);
  assert.equal(cfg.max_wait_ms, DEFAULT_BATCH_CONFIG.max_wait_ms);
  await close(db);
});

test('readBatchConfig merges stored values over defaults', async () => {
  const { readBatchConfig } = await import('../../cognition/biographer/pipeline.js');
  const db = await fresh();
  await db
    .query(
      surql`UPSERT type::record('runtime', 'biographer') SET value.batch_config = ${{ max_batch_size: 16 }}`,
    )
    .collect();
  const cfg = await readBatchConfig(db);
  assert.equal(cfg.max_batch_size, 16);
  assert.equal(cfg.debounce_ms, 750);
  assert.equal(cfg.max_wait_ms, 3000);
  await close(db);
});
