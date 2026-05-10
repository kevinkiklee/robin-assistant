import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { surql } from 'surrealdb';
import { recordEvent } from '../../src/capture/record-event.js';
import { close, connect } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { createStubEmbedder } from '../../src/embed/embedder.js';
import { createRepeatQueryDetector } from '../../src/mcp/implicit-signals.js';
import { createRecallTool } from '../../src/mcp/tools/recall.js';

import { mkdirSync as __robinMkdirSync } from 'node:fs';
import { tmpdir as __robinTmpdir } from 'node:os';
import { join as __robinJoin } from 'node:path';
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

test('recall tool returns hits and writes recall_events row', async () => {
  const db = await fresh();
  const e = createStubEmbedder({ dimension: 1024 });
  await recordEvent(db, e, { source: 'cli', content: 'apple' });
  await recordEvent(db, e, { source: 'cli', content: 'banana' });
  const detector = createRepeatQueryDetector({});
  const tool = createRecallTool({ db, embedder: e, detector, getSessionId: () => 'sess-1' });
  const result = await tool.handler({ query: 'apple' });
  assert.ok(result.recall_event_id);
  assert.ok(Array.isArray(result.hits));
  const [rows] = await db.query(surql`SELECT * FROM recall_events`).collect();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].query_text, 'apple');
  assert.equal(rows[0].session_id, 'sess-1');
  assert.equal(rows[0].hit_used.length, rows[0].hit_ids.length);
  assert.ok(rows[0].hit_used.every((u) => u === false));
  await close(db);
});

test('repeated query within window sets meta.repeat_query_within_5min', async () => {
  const db = await fresh();
  const e = createStubEmbedder({ dimension: 1024 });
  await recordEvent(db, e, { source: 'cli', content: 'one' });
  const detector = createRepeatQueryDetector({});
  const tool = createRecallTool({ db, embedder: e, detector, getSessionId: () => 'sess-1' });
  await tool.handler({ query: 'something' });
  await tool.handler({ query: 'something' });
  const [rows] = await db
    .query(surql`SELECT * FROM recall_events ORDER BY ts DESC LIMIT 1`)
    .collect();
  assert.equal(rows[0].meta?.repeat_query_within_5min, true);
  await close(db);
});

test('recall name is "recall"', () => {
  const tool = createRecallTool({
    db: null,
    embedder: null,
    detector: null,
    getSessionId: () => null,
  });
  assert.equal(tool.name, 'recall');
});
