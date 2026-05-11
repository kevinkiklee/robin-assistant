import assert from 'node:assert/strict';
import { mkdirSync as __robinMkdirSync } from 'node:fs';
import { tmpdir as __robinTmpdir } from 'node:os';
import { join as __robinJoin, resolve } from 'node:path';
import { test } from 'node:test';
import { writeConfig as __robinWriteConfig } from '../../config/paths.js';
import { close, connect } from '../../data/db/client.js';
import { runMigrations } from '../../data/db/migrate.js';
import { createStubEmbedder } from '../../data/embed/embedder.js';
import { recordEvent } from '../../io/capture/record-event.js';
import { createRunBiographerTool } from '../../io/mcp/tools/run-biographer.js';

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

test('run_biographer processes pending events via injected processor', async () => {
  const db = await fresh();
  const e = createStubEmbedder({ dimension: 1024 });
  await recordEvent(db, e, { source: 'cli', content: 'a' });
  await recordEvent(db, e, { source: 'cli', content: 'b' });
  const processed = [];
  const processor = async (id) => {
    processed.push(String(id));
  };
  const tool = createRunBiographerTool({ db, processor });
  const result = await tool.handler({ scope: 'pending', limit: 50 });
  assert.equal(result.processed, 2);
  assert.equal(result.failed, 0);
  assert.equal(processed.length, 2);
  await close(db);
});

test('run_biographer respects limit', async () => {
  const db = await fresh();
  const e = createStubEmbedder({ dimension: 1024 });
  for (let i = 0; i < 5; i++) await recordEvent(db, e, { source: 'cli', content: `e${i}` });
  const processed = [];
  const processor = async (id) => {
    processed.push(String(id));
  };
  const tool = createRunBiographerTool({ db, processor });
  const result = await tool.handler({ scope: 'pending', limit: 3 });
  assert.equal(result.processed, 3);
  await close(db);
});

test('run_biographer reports failures with failed_event_ids', async () => {
  const db = await fresh();
  const e = createStubEmbedder({ dimension: 1024 });
  await recordEvent(db, e, { source: 'cli', content: 'fail-me' });
  const processor = async () => {
    throw new Error('boom');
  };
  const tool = createRunBiographerTool({ db, processor });
  const result = await tool.handler({ scope: 'pending', limit: 1 });
  assert.equal(result.processed, 0);
  assert.equal(result.failed, 1);
  assert.ok(Array.isArray(result.failed_event_ids));
  await close(db);
});
