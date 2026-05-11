import assert from 'node:assert/strict';
import { mkdirSync as __robinMkdirSync } from 'node:fs';
import { tmpdir as __robinTmpdir } from 'node:os';
import { join as __robinJoin, resolve } from 'node:path';
import { test } from 'node:test';
import * as store from '../../cognition/memory/store.js';
import { writeConfig as __robinWriteConfig } from '../../config/paths.js';
import { close, connect } from '../../data/db/client.js';
import { runMigrations } from '../../data/db/migrate.js';
import { createStubEmbedder } from '../../data/embed/embedder.js';
import { recordEvent } from '../../io/capture/record-event.js';
import { createRecallTool } from '../../io/mcp/tools/recall.js';

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

function makeFakeDetector() {
  return {
    check: () => ({ repeat: false }),
    observe: () => {},
  };
}

test('recall tool returns empty hits on empty DB', async () => {
  const db = await fresh();
  const e = createStubEmbedder({ dimension: 1024 });
  const tool = createRecallTool({
    db,
    embedder: e,
    detector: makeFakeDetector(),
    getSessionId: () => null,
  });
  const r = await tool.handler({ query: 'anything', limit: 5 });
  assert.deepEqual(r.hits, []);
  await close(db);
});

test('recall tool hydrates mentions in a batched query (no N+1)', async () => {
  const db = await fresh();
  const e = createStubEmbedder({ dimension: 1024 });
  // Seed 3 events, each mentioning two entities. With the old N+1 pattern we
  // would issue 2*3=6 queries; with the batched pattern, 2 total.
  const eventIds = [];
  for (const word of ['apple', 'banana', 'cherry']) {
    const r = await recordEvent(db, e, { source: 'cli', content: word });
    eventIds.push(r.id);
  }
  // Create some entities and attach mentions to the first event.
  const entityIds = [];
  for (const ent of [
    { name: 'Alice', type: 'person' },
    { name: 'Acme', type: 'org' },
  ]) {
    const r = await store.upsertEntity(db, e, ent);
    entityIds.push(r.id);
  }
  // Add `mentions` edges between event[0] and both entities.
  await store.relate(db, eventIds[0], entityIds[0], 'mentions');
  await store.relate(db, eventIds[0], entityIds[1], 'mentions');

  // Count queries issued by the handler to verify batching.
  const origQuery = db.query.bind(db);
  let queryCount = 0;
  db.query = (...args) => {
    queryCount += 1;
    return origQuery(...args);
  };

  const tool = createRecallTool({
    db,
    embedder: e,
    detector: makeFakeDetector(),
    getSessionId: () => null,
  });
  const r = await tool.handler({ query: 'apple', limit: 5 });
  assert.ok(r.hits.length >= 1, `expected at least one hit, got ${r.hits.length}`);
  // The hit for "apple" should carry both mentions, populated from the
  // batched lookup.
  const appleHit = r.hits.find((h) => h.content === 'apple');
  assert.ok(appleHit, 'expected an "apple" hit');
  const names = appleHit.mentions.map((m) => m.entity_name).sort();
  assert.deepEqual(names, ['Acme', 'Alice']);

  // The handler runs:
  //   1. internalRecall (which itself queries internally — counted)
  //   2. one ->mentions->entities batched SELECT
  //   3. one entities-by-id batched SELECT
  //   4. one recall_log telemetry CREATE
  // Net: with N=3 hits we should be well under 10 queries. The old N+1 path
  // would have been 2*3 = 6 *additional* hydration queries. Guard against
  // regression to the N+1 pattern.
  assert.ok(queryCount < 12, `expected batched recall to use few queries; saw ${queryCount}`);
  await close(db);
});
