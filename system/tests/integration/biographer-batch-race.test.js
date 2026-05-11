import assert from 'node:assert/strict';
import { mkdirSync as __robinMkdirSync } from 'node:fs';
import { tmpdir as __robinTmpdir } from 'node:os';
import { join as __robinJoin, resolve } from 'node:path';
import { test } from 'node:test';
import { biographerProcessBatch } from '../../cognition/biographer/pipeline.js';
import { createBiographerQueue } from '../../cognition/biographer/queue.js';
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

function hostFor(seqContents) {
  let i = 0;
  return {
    name: 'fake',
    isAvailable: async () => true,
    invokeLLM: async () => ({ content: seqContents[i++ % seqContents.length], usage: {} }),
  };
}

test('queue serialises two same-source batches: no overlapping worker() calls; second waits for first', async () => {
  const db = await fresh();
  const e = createStubEmbedder({ dimension: 1024 });
  const ev1 = await recordEvent(db, e, { source: 'cli', content: 'one' });
  const ev2 = await recordEvent(db, e, { source: 'cli', content: 'two' });
  const ev3 = await recordEvent(db, e, { source: 'cli', content: 'three' });
  const ev4 = await recordEvent(db, e, { source: 'cli', content: 'four' });
  const batchAResp = JSON.stringify({
    events: [
      {
        event_id: String(ev1.id),
        entities: [
          { name: 'A', type: 'person' },
          { name: 'B', type: 'person' },
        ],
        edges: [],
        about: [],
        episode_continues_previous: false,
        episode_summary: null,
      },
      {
        event_id: String(ev2.id),
        entities: [
          { name: 'A', type: 'person' },
          { name: 'B', type: 'person' },
        ],
        edges: [],
        about: [],
        episode_continues_previous: true,
        episode_summary: null,
      },
    ],
  });
  const batchBResp = JSON.stringify({
    events: [
      {
        event_id: String(ev3.id),
        entities: [
          { name: 'A', type: 'person' },
          { name: 'B', type: 'person' },
        ],
        edges: [],
        about: [],
        episode_continues_previous: true,
        episode_summary: null,
      },
      {
        event_id: String(ev4.id),
        entities: [
          { name: 'A', type: 'person' },
          { name: 'B', type: 'person' },
        ],
        edges: [],
        about: [],
        episode_continues_previous: true,
        episode_summary: null,
      },
    ],
  });
  const h = hostFor([batchAResp, batchBResp]);

  // Instrumented worker: tracks the number of in-flight worker() calls.
  let inflight = 0;
  let peakInflight = 0;
  const workerCallOrder = [];
  const worker = async (payload) => {
    inflight++;
    peakInflight = Math.max(peakInflight, inflight);
    workerCallOrder.push(payload.__queueKey ?? String(payload));
    try {
      await new Promise((r) => setTimeout(r, 30));
      await biographerProcessBatch(db, e, h, payload.eventIds);
    } finally {
      inflight--;
    }
  };
  const queue = createBiographerQueue({ worker, dedupe: true });

  // Enqueue two batch payloads through the production dedupe shape (__queueKey
  // per spec §7 / §9). Calling enqueue twice in a row mirrors the daemon's
  // accumulator.fire() flow.
  const p1 = queue.enqueue({
    kind: 'batch',
    source: 'cli',
    eventIds: [ev1.id, ev2.id],
    __queueKey: `cli:${[ev1.id, ev2.id].map(String).sort().join(',')}`,
  });
  const p2 = queue.enqueue({
    kind: 'batch',
    source: 'cli',
    eventIds: [ev3.id, ev4.id],
    __queueKey: `cli:${[ev3.id, ev4.id].map(String).sort().join(',')}`,
  });
  await Promise.all([p1, p2]);

  // Serialisation assertions (the keystone of this test):
  assert.equal(
    peakInflight,
    1,
    `queue must serialise worker() invocations; observed peak inflight = ${peakInflight}`,
  );
  assert.equal(workerCallOrder.length, 2, 'expected exactly 2 worker() invocations');

  // Convergence assertions.
  const [evRows] = await db
    .query('SELECT id, biographed_at, ts FROM events ORDER BY ts ASC')
    .collect();
  for (const r of evRows) assert.ok(r.biographed_at, `${r.id} not biographed`);

  const [entRows] = await db.query('SELECT count() AS n FROM entities GROUP ALL').collect();
  assert.equal(entRows[0].n, 2);

  const [ocwRows] = await db.query("SELECT weight FROM edges WHERE kind = 'occurs_with'").collect();
  assert.equal(ocwRows.length, 1, 'expected exactly one (A, B) occurs_with edge');
  assert.equal(ocwRows[0].weight, 4, 'expected weight 4 — one per event');
  await close(db);
});
