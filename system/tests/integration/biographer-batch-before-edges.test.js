import assert from 'node:assert/strict';
import { mkdirSync as __robinMkdirSync } from 'node:fs';
import { tmpdir as __robinTmpdir } from 'node:os';
import { join as __robinJoin, resolve } from 'node:path';
import { test } from 'node:test';
import { biographerProcessBatch } from '../../cognition/biographer/pipeline.js';
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

async function fresh() {
  const db = await connect({ engine: 'mem://' });
  await runMigrations(db, resolve(import.meta.dirname, '../../data/db/migrations'));
  return db;
}

function host(content) {
  return {
    name: 'fake',
    isAvailable: async () => true,
    invokeLLM: async () => ({ content, usage: {} }),
  };
}

test('within-batch before edges chain consecutive events in the same episode', async () => {
  const db = await fresh();
  const e = createStubEmbedder({ dimension: 1024 });
  const ev1 = await recordEvent(db, e, { source: 'cli', content: 'one' });
  const ev2 = await recordEvent(db, e, { source: 'cli', content: 'two' });
  const ev3 = await recordEvent(db, e, { source: 'cli', content: 'three' });
  const h = host(
    JSON.stringify({
      events: [
        {
          event_id: String(ev1.id),
          entities: [],
          edges: [],
          about: [],
          episode_continues_previous: false,
          episode_summary: null,
        },
        {
          event_id: String(ev2.id),
          entities: [],
          edges: [],
          about: [],
          episode_continues_previous: true,
          episode_summary: null,
        },
        {
          event_id: String(ev3.id),
          entities: [],
          edges: [],
          about: [],
          episode_continues_previous: true,
          episode_summary: null,
        },
      ],
    }),
  );
  await biographerProcessBatch(db, e, h, [ev1.id, ev2.id, ev3.id]);

  const [rows] = await db
    .query("SELECT count() AS n FROM edges WHERE kind = 'before' GROUP ALL")
    .collect();
  assert.equal(rows[0].n, 2, 'expected 2 before edges (ev1->ev2, ev2->ev3)');
  await close(db);
});

test('within-batch before edges do not cross episode boundaries', async () => {
  const db = await fresh();
  const e = createStubEmbedder({ dimension: 1024 });
  const baseTs = Date.now();
  const ev1 = await recordEvent(db, e, {
    source: 'cli',
    content: 'one',
    ts: new Date(baseTs).toISOString(),
  });
  const ev2 = await recordEvent(db, e, {
    source: 'cli',
    content: 'two',
    ts: new Date(baseTs + 5 * 60_000).toISOString(),
  });
  const ev3 = await recordEvent(db, e, {
    source: 'cli',
    content: 'three',
    ts: new Date(baseTs + 45 * 60_000).toISOString(),
  });
  const h = host(
    JSON.stringify({
      events: [
        {
          event_id: String(ev1.id),
          entities: [],
          edges: [],
          about: [],
          episode_continues_previous: false,
          episode_summary: null,
        },
        {
          event_id: String(ev2.id),
          entities: [],
          edges: [],
          about: [],
          episode_continues_previous: true,
          episode_summary: null,
        },
        {
          event_id: String(ev3.id),
          entities: [],
          edges: [],
          about: [],
          episode_continues_previous: false,
          episode_summary: 'closed',
        },
      ],
    }),
  );
  await biographerProcessBatch(db, e, h, [ev1.id, ev2.id, ev3.id]);
  const [rows] = await db
    .query("SELECT count() AS n FROM edges WHERE kind = 'before' GROUP ALL")
    .collect();
  assert.equal(rows[0].n, 1, 'expected exactly 1 before edge (ev1->ev2) — no cross-episode chain');
  await close(db);
});
