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

test('per-event failure isolation: malformed event #3 of 5 → 4 biographed, 1 in failed_event_ids', async () => {
  const db = await fresh();
  const e = createStubEmbedder({ dimension: 1024 });
  const ev1 = await recordEvent(db, e, { source: 'cli', content: 'one' });
  const ev2 = await recordEvent(db, e, { source: 'cli', content: 'two' });
  const ev3 = await recordEvent(db, e, { source: 'cli', content: 'three' });
  const ev4 = await recordEvent(db, e, { source: 'cli', content: 'four' });
  const ev5 = await recordEvent(db, e, { source: 'cli', content: 'five' });
  const host = fakeHost([
    JSON.stringify({
      events: [
        {
          event_id: String(ev1.id),
          entities: [{ name: 'A', type: 'person' }],
          edges: [],
          about: [],
          episode_continues_previous: false,
          episode_summary: null,
        },
        {
          event_id: String(ev2.id),
          entities: [{ name: 'B', type: 'person' }],
          edges: [],
          about: [],
          episode_continues_previous: true,
          episode_summary: null,
        },
        // ev3 malformed: `entities` is not an array — hard structural reject
        // (not a stray-vocab coercion). Off-vocab entity types like `unicorn`
        // get coerced to `thing` by validateBiographerOutput; only structural
        // shape errors actually push the event into failed_event_ids.
        {
          event_id: String(ev3.id),
          entities: 'not_an_array',
          edges: [],
          about: [],
          episode_continues_previous: true,
          episode_summary: null,
        },
        {
          event_id: String(ev4.id),
          entities: [{ name: 'D', type: 'person' }],
          edges: [],
          about: [],
          episode_continues_previous: true,
          episode_summary: null,
        },
        {
          event_id: String(ev5.id),
          entities: [{ name: 'E', type: 'person' }],
          edges: [],
          about: [],
          episode_continues_previous: true,
          episode_summary: null,
        },
      ],
    }),
  ]);
  await biographerProcessBatch(db, e, host, [ev1.id, ev2.id, ev3.id, ev4.id, ev5.id]);

  const [rows] = await db
    .query('SELECT id, biographed_at, ts FROM events ORDER BY ts ASC')
    .collect();
  const marked = rows.filter((r) => r.biographed_at);
  assert.equal(marked.length, 4);
  assert.equal(String(rows[2].id), String(ev3.id));
  assert.ok(!rows[2].biographed_at, 'ev3 must not be biographed');

  const [rt] = await db
    .query("SELECT * FROM type::record('runtime', 'biographer') LIMIT 1")
    .collect();
  const failed = rt[0]?.value?.failed_event_ids ?? [];
  assert.ok(
    failed.some((id) => String(id) === String(ev3.id)),
    `failed_event_ids should contain ${ev3.id}; got ${JSON.stringify(failed)}`,
  );
  const lastError = rt[0]?.value?.last_error;
  assert.match(
    lastError ?? '',
    /^batch_malformed:/,
    `expected last_error prefixed with 'batch_malformed:', got ${JSON.stringify(lastError)}`,
  );

  // Failure-isolation assertions: the malformed entity ("C", type "unicorn")
  // and any edges originating from event #3 must NOT be present.
  const [unicornRows] = await db
    .query("SELECT count() AS n FROM entities WHERE name = 'C' GROUP ALL")
    .collect();
  assert.equal(unicornRows?.[0]?.n ?? 0, 0, 'entity "C" must not exist');

  // No mentions / about / works_on / participates_in edges originate from ev3.
  for (const kind of ['mentions', 'about', 'works_on', 'participates_in']) {
    const [edgeRows] = await db
      .query(
        surql`SELECT count() AS n FROM edges WHERE kind = ${kind} AND in = ${ev3.id} GROUP ALL`,
      )
      .collect();
    assert.equal(
      edgeRows?.[0]?.n ?? 0,
      0,
      `expected 0 ${kind} edges originating from ${ev3.id}, found ${edgeRows?.[0]?.n}`,
    );
  }

  await close(db);
});

test('outer JSON parse failure triggers single-event fallback', async () => {
  const db = await fresh();
  const e = createStubEmbedder({ dimension: 1024 });
  const ev1 = await recordEvent(db, e, { source: 'cli', content: 'one' });
  const ev2 = await recordEvent(db, e, { source: 'cli', content: 'two' });
  let i = 0;
  const host = {
    name: 'fake',
    isAvailable: async () => true,
    invokeLLM: async () => {
      i++;
      if (i === 1) {
        // Batch call: not JSON.
        return { content: 'this is not JSON', usage: {} };
      }
      // Fallback per-event calls succeed.
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
  await biographerProcessBatch(db, e, host, [ev1.id, ev2.id], { retryBaseDelayMs: 0 });
  assert.equal(i, 3, 'expected 1 batch attempt + 2 per-event fallback attempts');

  const [rt] = await db
    .query("SELECT * FROM type::record('runtime', 'biographer') LIMIT 1")
    .collect();
  assert.equal(rt[0]?.value?.last_fallback_reason, 'outer_json');
  assert.ok((rt[0]?.value?.batches_fallback ?? 0) >= 1);
  await close(db);
});

test('Gate #9: transient Transaction conflict on mark step retries via withTxRetry and converges', async () => {
  const db = await fresh();
  const e = createStubEmbedder({ dimension: 1024 });
  const ev1 = await recordEvent(db, e, { source: 'cli', content: 'one' });
  const ev2 = await recordEvent(db, e, { source: 'cli', content: 'two' });
  const h = fakeHost([
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
  ]);

  // Fault-injection wrapper: throw "Transaction conflict" on the FIRST mark
  // UPDATE call (containing `biographed_at = time::now()`), then pass through.
  // BoundQuery exposes the SQL via `.query` getter.
  const origQuery = db.query.bind(db);
  let injected = false;
  db.query = (...args) => {
    const arg = args[0];
    const sql = typeof arg === 'string' ? arg : (arg?.query ?? '');
    if (!injected && sql.includes('biographed_at = time::now()')) {
      injected = true;
      return {
        async collect() {
          throw new Error('Transaction conflict: Write conflict (injected by Gate #9)');
        },
      };
    }
    return origQuery(...args);
  };

  await biographerProcessBatch(db, e, h, [ev1.id, ev2.id], { retryBaseDelayMs: 0 });

  // Restore for subsequent assertions
  db.query = origQuery;

  assert.ok(injected, 'fault-injection fired');

  // Both events should still be marked biographed (withTxRetry converged).
  const [rows] = await db
    .query(`SELECT count() AS n FROM events WHERE biographed_at IS NOT NONE GROUP ALL`)
    .collect();
  assert.equal(rows[0]?.n, 2, 'both events biographed despite transient mark-step failure');
  await close(db);
});

test('Gate #7: retries-exhausted on batch call triggers per-event fallback with last_fallback_reason=network', async () => {
  const db = await fresh();
  const e = createStubEmbedder({ dimension: 1024 });
  const ev1 = await recordEvent(db, e, { source: 'cli', content: 'one' });
  const ev2 = await recordEvent(db, e, { source: 'cli', content: 'two' });
  let batchAttempts = 0;
  let perEventCalls = 0;
  const host = {
    name: 'fake',
    isAvailable: async () => true,
    invokeLLM: async (_messages, _opts) => {
      // The first 3 calls are batch retries (invokeWithRetry attempts the
      // batch up to retries=3 times). The remaining calls are per-event
      // fallbacks. We distinguish batch vs per-event by message count.
      const isBatch =
        Array.isArray(_messages) &&
        _messages.some((m) => typeof m?.content === 'string' && m.content.includes('events'));
      if (isBatch && batchAttempts < 3) {
        batchAttempts++;
        throw new Error('simulated network failure');
      }
      perEventCalls++;
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
  await biographerProcessBatch(db, e, host, [ev1.id, ev2.id], { retryBaseDelayMs: 0 });
  assert.equal(batchAttempts, 3, 'batch path retried 3 times before falling back');
  assert.equal(perEventCalls, 2, 'fallback ran per-event for both events');

  const [rt] = await db
    .query("SELECT * FROM type::record('runtime', 'biographer') LIMIT 1")
    .collect();
  assert.equal(rt[0]?.value?.last_fallback_reason, 'network');
  assert.ok((rt[0]?.value?.batches_fallback ?? 0) >= 1);
  // Both events biographed via the fallback path.
  const [bio] = await db
    .query('SELECT biographed_at FROM events WHERE biographed_at IS NOT NONE')
    .collect();
  assert.equal(bio.length, 2);
  await close(db);
});

test('episode break mid-batch: event #3 with continues_previous=false opens new episode', async () => {
  const db = await fresh();
  const e = createStubEmbedder({ dimension: 1024 });
  const baseTs = Date.now();
  // Three events 0 / 5 min / 45 min apart. Default episode_window_minutes=30.
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
  const host = fakeHost([
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
          episode_summary: 'first session ended',
        },
      ],
    }),
  ]);
  const tBeforeBatch = Date.now();
  await biographerProcessBatch(db, e, host, [ev1.id, ev2.id, ev3.id]);
  const [rows] = await db.query('SELECT id, episode_id, ts FROM events ORDER BY ts ASC').collect();
  assert.equal(String(rows[0].episode_id), String(rows[1].episode_id), 'ev1+ev2 same episode');
  assert.notEqual(String(rows[1].episode_id), String(rows[2].episode_id), 'ev3 new episode');

  const [epRows] = await db.query('SELECT count() AS n FROM episodes GROUP ALL').collect();
  assert.equal(epRows[0].n, 2);

  // Pin the accepted `started_at` divergence (spec §4 "Accepted divergence"):
  // the new episode's `started_at` is DB-side time::now(), NOT ev3.ts.
  const [newEpRows] = await db
    .query(surql`SELECT started_at FROM ${rows[2].episode_id} LIMIT 1`)
    .collect();
  const newEpStartedAt = new Date(newEpRows[0].started_at).getTime();
  const ev3Ts = new Date(baseTs + 45 * 60_000).getTime();
  // started_at should be wall-clock-near-now, not 45 min in the past.
  assert.ok(
    newEpStartedAt >= tBeforeBatch,
    `new episode started_at (${newEpRows[0].started_at}) should be >= test wall-clock at batch start (${new Date(tBeforeBatch).toISOString()})`,
  );
  assert.ok(
    Math.abs(newEpStartedAt - ev3Ts) > 60_000,
    'new episode.started_at must NOT equal ev3.ts — confirms accepted DB-side time::now() divergence',
  );

  await close(db);
});

test('mark step issues one UPDATE per episode group (2 episodes → 2 UPDATEs)', async () => {
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

  // Wrap db.query to capture every UPDATE-mark statement issued.
  // BoundQuery (from surql tag) exposes `.query` as the SQL string.
  const origQuery = db.query.bind(db);
  const markUpdates = [];
  db.query = (q, ...rest) => {
    const text = String(q?.query ?? q ?? '');
    if (/UPDATE\s+events[\s\S]*biographed_at\s*=\s*time::now\(\)/i.test(text)) {
      markUpdates.push(text);
    }
    return origQuery(q, ...rest);
  };

  const host = fakeHost([
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
  ]);
  await biographerProcessBatch(db, e, host, [ev1.id, ev2.id, ev3.id]);

  // Restore db.query.
  db.query = origQuery;

  assert.equal(
    markUpdates.length,
    2,
    `expected 2 mark UPDATEs (one per episode group), got ${markUpdates.length}`,
  );
  await close(db);
});

test('cross-event entity dedup: 3 events × "Atlas" → 1 entity row + 3 mentions', async () => {
  const db = await fresh();
  const e = createStubEmbedder({ dimension: 1024 });
  const evt1 = await recordEvent(db, e, { source: 'cli', content: 'Atlas planning' });
  const evt2 = await recordEvent(db, e, { source: 'cli', content: 'Atlas update' });
  const evt3 = await recordEvent(db, e, { source: 'cli', content: 'Atlas review' });
  const host = fakeHost([
    JSON.stringify({
      events: [
        {
          event_id: String(evt1.id),
          entities: [{ name: 'Atlas', type: 'project' }],
          edges: [],
          about: ['Atlas'],
          episode_continues_previous: false,
          episode_summary: null,
        },
        {
          event_id: String(evt2.id),
          entities: [{ name: 'Atlas', type: 'project' }],
          edges: [],
          about: ['Atlas'],
          episode_continues_previous: true,
          episode_summary: null,
        },
        {
          event_id: String(evt3.id),
          entities: [{ name: 'Atlas', type: 'project' }],
          edges: [],
          about: ['Atlas'],
          episode_continues_previous: true,
          episode_summary: null,
        },
      ],
    }),
  ]);
  await biographerProcessBatch(db, e, host, [evt1.id, evt2.id, evt3.id]);

  const [entRows] = await db.query('SELECT count() AS n FROM entities GROUP ALL').collect();
  assert.equal(entRows[0].n, 1, 'expected 1 Atlas entity');

  const [mentRows] = await db
    .query("SELECT count() AS n FROM edges WHERE kind = 'mentions' GROUP ALL")
    .collect();
  assert.equal(mentRows[0].n, 3, 'expected 3 mentions edges (one per event)');

  const [aboutRows] = await db
    .query("SELECT count() AS n FROM edges WHERE kind = 'about' GROUP ALL")
    .collect();
  assert.equal(aboutRows[0].n, 3);
  await close(db);
});
