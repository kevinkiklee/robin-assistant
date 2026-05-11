import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { writeConfig as __wc } from '../../config/paths.js';
import { close, connect } from '../../data/db/client.js';
import { runMigrations } from '../../data/db/migrate.js';
import { createStubEmbedder } from '../../data/embed/embedder.js';
import { createIngestTool } from '../../io/mcp/tools/ingest.js';

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

test('ingest — missing all inputs', async () => {
  const { db, embedder } = await fresh();
  const t = createIngestTool({ db, embedder, host: stubLLM('{}') });
  const r = await t.handler({});
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'missing_arg');
  await close(db);
});

test('ingest — ambiguous inputs (content + url)', async () => {
  const { db, embedder } = await fresh();
  const t = createIngestTool({ db, embedder, host: stubLLM('{}') });
  const r = await t.handler({ content: 'x', url: 'https://x' });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'ambiguous_input');
  await close(db);
});

test('ingest — too_large content', async () => {
  const { db, embedder } = await fresh();
  const t = createIngestTool({ db, embedder, host: stubLLM('{}') });
  const r = await t.handler({ content: 'x'.repeat(1_048_577) });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'too_large');
  await close(db);
});

test('ingest — happy path inline content with stub LLM', async () => {
  const { db, embedder } = await fresh();
  const llm = stubLLM(
    JSON.stringify({
      entities: [{ name: 'Acme', type: 'project', confidence: 0.9 }],
      edges: [],
      knowledge: [{ content: 'Acme is a project', confidence: 0.8 }],
    }),
  );
  const t = createIngestTool({ db, embedder, host: llm });
  const r = await t.handler({ content: 'Acme is a small project that does X.' });
  assert.equal(r.ok, true);
  assert.equal(r.deduped, false);
  assert.equal(r.entities_created, 1);
  assert.equal(r.knowledge_created, 1);
  await close(db);
});

test('ingest — dedup returns deduped:true', async () => {
  const { db, embedder } = await fresh();
  const llm = stubLLM(JSON.stringify({ entities: [], edges: [], knowledge: [] }));
  const t = createIngestTool({ db, embedder, host: llm });
  await t.handler({ content: 'same content here' });
  const r = await t.handler({ content: 'same content here' });
  assert.equal(r.ok, true);
  assert.equal(r.deduped, true);
  await close(db);
});

test('ingest — malformed LLM output → extraction_failed', async () => {
  const { db, embedder } = await fresh();
  const t = createIngestTool({ db, embedder, host: stubLLM('not json') });
  const r = await t.handler({ content: 'fresh content for parse-fail test' });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'extraction_failed');
  await close(db);
});

test('ingest — PII content refused', async () => {
  const { db, embedder } = await fresh();
  const t = createIngestTool({
    db,
    embedder,
    host: stubLLM(JSON.stringify({ entities: [], edges: [], knowledge: [] })),
  });
  const r = await t.handler({
    content: 'AKIAIOSFODNN7EXAMPLE is the access key',
  });
  assert.equal(r.ok, false);
  assert.match(r.reason, /^pii:/);
  await close(db);
});

test('ingest — dedup does not create a phantom event', async () => {
  const { db, embedder } = await fresh();
  const llm = stubLLM(JSON.stringify({ entities: [], edges: [], knowledge: [] }));
  const t = createIngestTool({ db, embedder, host: llm });
  await t.handler({ content: 'dedup test content' });
  const before =
    (await db.query('SELECT count() AS n FROM events GROUP ALL').collect())[0]?.[0]?.n ?? 0;
  const r = await t.handler({ content: 'dedup test content' });
  const after =
    (await db.query('SELECT count() AS n FROM events GROUP ALL').collect())[0]?.[0]?.n ?? 0;
  assert.equal(r.deduped, true);
  assert.equal(after, before, 'second ingest of same content must not create a new event');
  await close(db);
});
