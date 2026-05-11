// tests/unit/audit.test.js
// After the redesign, `knowledge` rows live in `memos` with kind='knowledge'
// and have no inline embedding column. We seed via store.note which writes
// both the memo row and its embedding into embeddings_<profile>_memos.

import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import * as store from '../../cognition/memory/store.js';
import { writeConfig as __wc } from '../../config/paths.js';
import { close, connect } from '../../data/db/client.js';
import { runMigrations } from '../../data/db/migrate.js';
import { createStubEmbedder } from '../../data/embed/embedder.js';
import { createAuditTool } from '../../io/mcp/tools/audit.js';

const __h = join(tmpdir(), `robin-test-${process.pid}-${Math.random().toString(36).slice(2)}`);
mkdirSync(__h, { recursive: true });
process.env.ROBIN_HOME = __h;
await __wc({ embedder_profile: 'mxbai-1024' });

async function fresh() {
  const db = await connect({ engine: 'mem://' });
  await runMigrations(db, resolve(import.meta.dirname, '../../src/schema/migrations'));
  return { db, embedder: createStubEmbedder({ dimension: 1024 }) };
}

const stubLLM = (output) => ({ invokeLLM: async () => ({ content: output }) });

test('audit — empty knowledge → 0 pairs checked', async () => {
  const { db } = await fresh();
  const t = createAuditTool({ db, host: stubLLM('{"contradict":false,"summary":""}') });
  const r = await t.handler({});
  assert.equal(r.ok, true);
  assert.equal(r.pairs_checked, 0);
  assert.equal(r.contradictions.length, 0);
  await close(db);
});

test('audit — stub LLM returns no contradiction → empty result', async () => {
  const { db, embedder } = await fresh();
  await store.note(db, embedder, 'knowledge', {
    content: 'a',
    confidence: 0.8,
    derived_by: 'manual',
  });
  await store.note(db, embedder, 'knowledge', {
    content: 'b',
    confidence: 0.8,
    derived_by: 'manual',
  });
  const t = createAuditTool({
    db,
    host: stubLLM('{"contradict":false,"summary":"different topics"}'),
  });
  const r = await t.handler({ pair_count: 4 });
  assert.equal(r.ok, true);
  assert.equal(r.contradictions.length, 0);
  await close(db);
});

test('audit — malformed LLM output treated as no contradiction', async () => {
  const { db, embedder } = await fresh();
  await store.note(db, embedder, 'knowledge', {
    content: 'a',
    confidence: 0.8,
    derived_by: 'manual',
  });
  await store.note(db, embedder, 'knowledge', {
    content: 'b',
    confidence: 0.8,
    derived_by: 'manual',
  });
  const t = createAuditTool({ db, host: stubLLM('not json at all') });
  const r = await t.handler({});
  assert.equal(r.ok, true);
  assert.equal(r.contradictions.length, 0);
  await close(db);
});

test('audit — stub LLM marks contradiction → reported', async () => {
  const { db, embedder } = await fresh();
  // Use a constant-vector embedder so both memos are HNSW-near each other.
  const sharedVec = await embedder.embed('shared');
  const constEmb = {
    dimension: 1024,
    modelId: 'const',
    embed: async () => sharedVec,
    embedBatch: async (xs) => xs.map(() => sharedVec),
  };
  await store.note(db, constEmb, 'knowledge', {
    content: 'X is alive',
    confidence: 0.8,
    derived_by: 'manual',
  });
  await store.note(db, constEmb, 'knowledge', {
    content: 'X is dead',
    confidence: 0.8,
    derived_by: 'manual',
  });
  const t = createAuditTool({ db, host: stubLLM('{"contradict":true,"summary":"alive vs dead"}') });
  const r = await t.handler({});
  assert.ok(r.contradictions.length > 0);
  assert.match(r.contradictions[0].summary, /alive vs dead/);
  await close(db);
});
