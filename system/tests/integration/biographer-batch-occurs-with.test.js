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

test('per-event occurs_with: 3 events each mentioning {Alice, Bob} → weight 3 on (Alice, Bob)', async () => {
  const db = await fresh();
  const e = createStubEmbedder({ dimension: 1024 });
  const ev1 = await recordEvent(db, e, { source: 'cli', content: 'one' });
  const ev2 = await recordEvent(db, e, { source: 'cli', content: 'two' });
  const ev3 = await recordEvent(db, e, { source: 'cli', content: 'three' });
  const perEventBlock = (id, continues) => ({
    event_id: String(id),
    entities: [
      { name: 'Alice', type: 'person' },
      { name: 'Bob', type: 'person' },
    ],
    edges: [],
    about: [],
    episode_continues_previous: continues,
    episode_summary: null,
  });
  const h = host(
    JSON.stringify({
      events: [
        perEventBlock(ev1.id, false),
        perEventBlock(ev2.id, true),
        perEventBlock(ev3.id, true),
      ],
    }),
  );
  await biographerProcessBatch(db, e, h, [ev1.id, ev2.id, ev3.id]);

  const [rows] = await db.query("SELECT weight FROM edges WHERE kind = 'occurs_with'").collect();
  assert.equal(rows.length, 1, 'expected exactly one (Alice, Bob) occurs_with edge');
  assert.equal(rows[0].weight, 3, 'expected weight 3 — one increment per event');
  await close(db);
});
