import assert from 'node:assert/strict';
import { mkdirSync as __robinMkdirSync } from 'node:fs';
import { tmpdir as __robinTmpdir } from 'node:os';
import { join as __robinJoin, resolve } from 'node:path';
import { test } from 'node:test';
import { surql } from 'surrealdb';
import { biographerProcess } from '../../src/capture/biographer.js';
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
  await runMigrations(db, resolve(import.meta.dirname, '../../src/schema/migrations'));
  return db;
}

test('biographer processes a single event end-to-end', async () => {
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
  await biographerProcess(db, e, host, evt.id);

  const [evRows] = await db.query(surql`SELECT * FROM ${evt.id}`).collect();
  assert.ok(evRows[0].biographed_at);
  assert.ok(evRows[0].episode_id);

  const [entRows] = await db.query('SELECT count() AS n FROM entities GROUP ALL').collect();
  assert.equal(entRows[0].n, 3);

  // The redesign collapsed per-relation edge tables into the unified `edges`
  // table; counts now route through `kind` filters.
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

test('biographer skips already-biographed events', async () => {
  const db = await fresh();
  const e = createStubEmbedder({ dimension: 1024 });
  const evt = await recordEvent(db, e, { source: 'cli', content: 'event' });
  let calls = 0;
  const host = {
    name: 'fake',
    isAvailable: async () => true,
    invokeLLM: async () => {
      calls++;
      return {
        content: JSON.stringify({
          entities: [],
          edges: [],
          about: [],
          episode_continues_previous: false,
          episode_summary: null,
        }),
        usage: {},
      };
    },
  };
  await biographerProcess(db, e, host, evt.id);
  await biographerProcess(db, e, host, evt.id);
  assert.equal(calls, 1);
  await close(db);
});

test('biographer extends existing episode when LLM says continues_previous=true', async () => {
  const db = await fresh();
  const e = createStubEmbedder({ dimension: 1024 });
  const evt1 = await recordEvent(db, e, { source: 'cli', content: 'first' });
  const evt2 = await recordEvent(db, e, { source: 'cli', content: 'follow-up' });
  const host = fakeHost([
    JSON.stringify({
      entities: [],
      edges: [],
      about: [],
      episode_continues_previous: false,
      episode_summary: null,
    }),
    JSON.stringify({
      entities: [],
      edges: [],
      about: [],
      episode_continues_previous: true,
      episode_summary: null,
    }),
  ]);
  await biographerProcess(db, e, host, evt1.id);
  await biographerProcess(db, e, host, evt2.id);

  const [evRows] = await db.query('SELECT episode_id, ts FROM events ORDER BY ts').collect();
  // Both events should belong to the same episode
  assert.equal(String(evRows[0].episode_id), String(evRows[1].episode_id));

  const [epRows] = await db.query('SELECT count() AS n FROM episodes GROUP ALL').collect();
  assert.equal(epRows[0].n, 1);
  await close(db);
});
