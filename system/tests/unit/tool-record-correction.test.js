import assert from 'node:assert/strict';
import { mkdirSync as __robinMkdirSync } from 'node:fs';
import { tmpdir as __robinTmpdir } from 'node:os';
import { join as __robinJoin, resolve } from 'node:path';
import { test } from 'node:test';
import { surql } from 'surrealdb';
import { writeConfig as __robinWriteConfig } from '../../config/paths.js';
import { close, connect } from '../../data/db/client.js';
import { runMigrations } from '../../data/db/migrate.js';
import { createStubEmbedder } from '../../data/embed/embedder.js';
import { createRecordCorrectionTool } from '../../io/mcp/tools/record-correction.js';

// __robin_test_home_setup__
const __robinTestHome = __robinJoin(
  __robinTmpdir(),
  `robin-test-${process.pid}-${Math.random().toString(36).slice(2)}`,
);
__robinMkdirSync(__robinTestHome, { recursive: true });
process.env.ROBIN_HOME = __robinTestHome;
await __robinWriteConfig({ embedder_profile: 'mxbai-1024' });

test('record_correction writes event with meta.kind=correction', async () => {
  const db = await connect({ engine: 'mem://' });
  await runMigrations(db, resolve(import.meta.dirname, '../../src/schema/migrations'));
  const e = createStubEmbedder({ dimension: 1024 });
  const processedIds = [];
  const processor = async (id) => {
    processedIds.push(String(id));
  };
  const tool = createRecordCorrectionTool({ db, embedder: e, processor });
  const r = await tool.handler({
    content: 'user prefers concise answers',
    prior_response: 'long verbose response',
    meta: { what_was_wrong: 'too verbose' },
  });
  assert.ok(r.id);
  const [rows] = await db.query(surql`SELECT * FROM events`).collect();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].meta.kind, 'correction');
  assert.equal(rows[0].meta.prior_response, 'long verbose response');
  assert.equal(rows[0].meta.what_was_wrong, 'too verbose');
  assert.equal(processedIds.length, 1);
  await close(db);
});

test('record_correction works without prior_response or meta', async () => {
  const db = await connect({ engine: 'mem://' });
  await runMigrations(db, resolve(import.meta.dirname, '../../src/schema/migrations'));
  const e = createStubEmbedder({ dimension: 1024 });
  const processor = async () => {};
  const tool = createRecordCorrectionTool({ db, embedder: e, processor });
  const r = await tool.handler({ content: 'something' });
  assert.ok(r.id);
  const [rows] = await db.query(surql`SELECT * FROM events`).collect();
  assert.equal(rows[0].meta.kind, 'correction');
  await close(db);
});

test('record_correction does not fail if processor errors', async () => {
  const db = await connect({ engine: 'mem://' });
  await runMigrations(db, resolve(import.meta.dirname, '../../src/schema/migrations'));
  const e = createStubEmbedder({ dimension: 1024 });
  const processor = async () => {
    throw new Error('biographer down');
  };
  const tool = createRecordCorrectionTool({ db, embedder: e, processor });
  const r = await tool.handler({ content: 'still saved' });
  assert.ok(r.id);
  await close(db);
});
