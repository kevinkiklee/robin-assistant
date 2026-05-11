// tests/unit/audit.test.js
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { surql } from 'surrealdb';
import { close, connect } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { createStubEmbedder } from '../../src/embed/embedder.js';
import { createAuditTool } from '../../src/mcp/tools/audit.js';

import { writeConfig as __wc } from '../../src/runtime/config.js';

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
  const emb1 = Array.from(await embedder.embed('first claim'));
  const emb2 = Array.from(await embedder.embed('second claim'));
  await db
    .query(
      surql`CREATE knowledge CONTENT ${{ content: 'a', content_hash: 'h1', confidence: 0.8, source_events: [], source_episodes: [], embedding: emb1 }}`,
    )
    .collect();
  await db
    .query(
      surql`CREATE knowledge CONTENT ${{ content: 'b', content_hash: 'h2', confidence: 0.8, source_events: [], source_episodes: [], embedding: emb2 }}`,
    )
    .collect();
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
  const emb = Array.from(await embedder.embed('claim a'));
  await db
    .query(
      surql`CREATE knowledge CONTENT ${{ content: 'a', content_hash: 'h1', confidence: 0.8, source_events: [], source_episodes: [], embedding: emb }}`,
    )
    .collect();
  await db
    .query(
      surql`CREATE knowledge CONTENT ${{ content: 'b', content_hash: 'h2', confidence: 0.8, source_events: [], source_episodes: [], embedding: emb }}`,
    )
    .collect();
  const t = createAuditTool({ db, host: stubLLM('not json at all') });
  const r = await t.handler({});
  assert.equal(r.ok, true);
  assert.equal(r.contradictions.length, 0);
  await close(db);
});

test('audit — stub LLM marks contradiction → reported', async () => {
  const { db, embedder } = await fresh();
  const emb = Array.from(await embedder.embed('shared'));
  await db
    .query(
      surql`CREATE knowledge CONTENT ${{ content: 'X is alive', content_hash: 'h1', confidence: 0.8, source_events: [], source_episodes: [], embedding: emb }}`,
    )
    .collect();
  await db
    .query(
      surql`CREATE knowledge CONTENT ${{ content: 'X is dead', content_hash: 'h2', confidence: 0.8, source_events: [], source_episodes: [], embedding: emb }}`,
    )
    .collect();
  const t = createAuditTool({ db, host: stubLLM('{"contradict":true,"summary":"alive vs dead"}') });
  const r = await t.handler({});
  assert.ok(r.contradictions.length > 0);
  assert.match(r.contradictions[0].summary, /alive vs dead/);
  await close(db);
});
