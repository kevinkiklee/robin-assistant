import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { recordEvent } from '../../src/capture/record-event.js';
import { close, connect } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { createStubEmbedder } from '../../src/embed/embedder.js';
import { createRunBiographerTool } from '../../src/mcp/tools/run-biographer.js';

async function fresh() {
  const db = await connect({ engine: 'mem://' });
  await runMigrations(db, resolve(import.meta.dirname, '../../src/schema/migrations'));
  return db;
}

test('run_biographer processes pending events via injected processor', async () => {
  const db = await fresh();
  const e = createStubEmbedder({ dimension: 384 });
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
  const e = createStubEmbedder({ dimension: 384 });
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
  const e = createStubEmbedder({ dimension: 384 });
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
