import assert from 'node:assert/strict';
import { mkdirSync as __robinMkdirSync } from 'node:fs';
import { tmpdir as __robinTmpdir } from 'node:os';
import { join as __robinJoin, resolve } from 'node:path';
import { test } from 'node:test';
import { biographerProcessBatch } from '../../cognition/biographer/pipeline.js';
import { recordStepTelemetry } from '../../cognition/dream/telemetry.js';
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
    invokeLLM: async () => ({
      content,
      usage: { input_tokens: 12, output_tokens: 34 },
    }),
  };
}

test('biographer_telemetry: one row per batch via=batch with token + duration fields', async () => {
  const db = await fresh();
  const e = createStubEmbedder({ dimension: 1024 });
  const ev1 = await recordEvent(db, e, { source: 'cli', content: 'one' });
  const ev2 = await recordEvent(db, e, { source: 'cli', content: 'two' });
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
      ],
    }),
  );
  await biographerProcessBatch(db, e, h, [ev1.id, ev2.id]);

  const [rows] = await db.query('SELECT * FROM biographer_telemetry ORDER BY ts ASC').collect();
  assert.equal(rows.length, 1, 'one biographer_telemetry row per batch');
  assert.equal(rows[0].via, 'batch');
  assert.equal(rows[0].source, 'cli');
  assert.equal(rows[0].batch_size, 2);
  assert.equal(rows[0].input_tokens, 12);
  assert.equal(rows[0].output_tokens, 34);
  assert.ok(rows[0].duration_ms >= 0, 'duration_ms recorded');
  await close(db);
});

test('biographer_telemetry: fallback path writes via=fallback with fallback_reason', async () => {
  const db = await fresh();
  const e = createStubEmbedder({ dimension: 1024 });
  const ev1 = await recordEvent(db, e, { source: 'cli', content: 'one' });
  const ev2 = await recordEvent(db, e, { source: 'cli', content: 'two' });
  // First call: malformed batch (triggers fallback); subsequent per-event
  // calls return valid single-event payloads.
  let i = 0;
  const h = {
    name: 'fake',
    isAvailable: async () => true,
    invokeLLM: async () => {
      i++;
      if (i === 1) return { content: 'not JSON', usage: {} };
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
  await biographerProcessBatch(db, e, h, [ev1.id, ev2.id], { retryBaseDelayMs: 0 });

  const [rows] = await db
    .query("SELECT * FROM biographer_telemetry WHERE via = 'fallback' ORDER BY ts DESC LIMIT 1")
    .collect();
  assert.equal(rows.length, 1, 'one fallback row');
  assert.equal(rows[0].fallback_reason, 'outer_json');
  await close(db);
});

test('dream_telemetry: recordStepTelemetry writes structured row with layer + parallel flag', async () => {
  const db = await fresh();
  await recordStepTelemetry(db, 'knowledge', 42, null, {
    tokens_in: 100,
    tokens_out: 50,
    parallel: true,
  });
  await recordStepTelemetry(db, 'compaction', 7, null, { parallel: false });
  await recordStepTelemetry(db, 'reflection', 21, new Error('boom'), { parallel: true });

  const [rows] = await db.query('SELECT * FROM dream_telemetry ORDER BY ts ASC').collect();
  assert.equal(rows.length, 3);

  const know = rows.find((r) => r.step === 'knowledge');
  assert.equal(know.layer, 1);
  assert.equal(know.tokens_in, 100);
  assert.equal(know.tokens_out, 50);
  assert.equal(know.success, true);
  assert.equal(know.parallel, true);

  const comp = rows.find((r) => r.step === 'compaction');
  assert.equal(comp.layer, 3, 'compaction is layer 3 after DAG edge added');
  assert.equal(comp.parallel, false);

  const refl = rows.find((r) => r.step === 'reflection');
  assert.equal(refl.success, false);
  assert.equal(refl.error, 'boom');

  // cadence_telemetry rows still written for back-compat.
  const [cadence] = await db
    .query(
      "SELECT count() AS n FROM cadence_telemetry WHERE step IN ['knowledge','compaction','reflection'] GROUP ALL",
    )
    .collect();
  assert.equal(cadence[0].n, 3, 'cadence_telemetry continues to receive the same rows');
  await close(db);
});
