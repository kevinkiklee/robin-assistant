// system/tests/unit/ingest-propagates-trust.test.js
//
// Regression: untrusted ingest must propagate derived_from_trust='untrusted'
// to all extracted entities, edges, and knowledge memos.
// Prior bug: store calls lacked derived_from_trust, so schema default
// ('trusted') silently laundered untrusted content through extraction.

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

const __h = join(
  tmpdir(),
  `robin-test-trust-${process.pid}-${Math.random().toString(36).slice(2)}`,
);
mkdirSync(__h, { recursive: true });
process.env.ROBIN_HOME = __h;
await __wc({ embedder_profile: 'mxbai-1024' });

async function fresh() {
  const db = await connect({ engine: 'mem://' });
  await runMigrations(db, resolve(import.meta.dirname, '../../data/db/migrations'));
  return { db, embedder: createStubEmbedder({ dimension: 1024 }) };
}

const EXTRACTED = JSON.stringify({
  entities: [
    { name: 'EvilCorp', type: 'organization' },
    { name: 'Alice', type: 'person' },
  ],
  edges: [
    { kind: 'works_on', src_name: 'Alice', dst_name: 'EvilCorp' },
  ],
  knowledge: [
    { content: 'EvilCorp is an adversary', confidence: 0.9, subject_name: 'EvilCorp' },
  ],
});

const stubLLM = (output) => ({ invokeLLM: async () => ({ content: output }) });

test('ingest: untrusted source_trust → entities get derived_from_trust=untrusted', async () => {
  const { db, embedder } = await fresh();
  const t = createIngestTool({ db, embedder, host: stubLLM(EXTRACTED) });

  const r = await t.handler({
    content: 'EvilCorp employs Alice and is an adversary.',
    source_trust: 'untrusted',
  });
  assert.equal(r.ok, true, `ingest failed: ${r.reason}`);
  assert.equal(r.entities_created, 2);

  const [rows] = await db
    .query('SELECT name, derived_from_trust FROM entities ORDER BY name')
    .collect();
  for (const row of rows) {
    assert.equal(
      row.derived_from_trust,
      'untrusted',
      `entity "${row.name}" has derived_from_trust="${row.derived_from_trust}", expected "untrusted"`,
    );
  }

  await close(db);
});

test('ingest: untrusted source_trust → knowledge memos get derived_from_trust=untrusted', async () => {
  const { db, embedder } = await fresh();
  const t = createIngestTool({ db, embedder, host: stubLLM(EXTRACTED) });

  const r = await t.handler({
    content: 'EvilCorp employs Alice and is an adversary.',
    source_trust: 'untrusted',
  });
  assert.equal(r.ok, true);
  assert.equal(r.knowledge_created, 1);

  const [rows] = await db
    .query("SELECT derived_from_trust FROM memos WHERE kind = 'knowledge'")
    .collect();
  assert.equal(rows.length, 1);
  assert.equal(
    rows[0].derived_from_trust,
    'untrusted',
    `knowledge memo has derived_from_trust="${rows[0].derived_from_trust}", expected "untrusted"`,
  );

  await close(db);
});

test('ingest: untrusted source_trust → edges get derived_from_trust=untrusted', async () => {
  const { db, embedder } = await fresh();
  const t = createIngestTool({ db, embedder, host: stubLLM(EXTRACTED) });

  const r = await t.handler({
    content: 'EvilCorp employs Alice and is an adversary.',
    source_trust: 'untrusted',
  });
  assert.equal(r.ok, true);
  assert.ok(r.edges_created >= 1, `expected at least 1 edge, got ${r.edges_created}`);

  const [rows] = await db
    .query("SELECT kind, derived_from_trust FROM edges WHERE kind = 'works_on'")
    .collect();
  assert.ok(rows.length >= 1, 'no works_on edge found');
  for (const row of rows) {
    assert.equal(
      row.derived_from_trust,
      'untrusted',
      `edge kind="${row.kind}" has derived_from_trust="${row.derived_from_trust}", expected "untrusted"`,
    );
  }

  await close(db);
});

test('ingest: trusted source_trust → entities keep derived_from_trust=trusted', async () => {
  const { db, embedder } = await fresh();
  const t = createIngestTool({ db, embedder, host: stubLLM(EXTRACTED) });

  const r = await t.handler({
    content: 'EvilCorp employs Alice and is an adversary.',
    source_trust: 'trusted',
  });
  assert.equal(r.ok, true);

  const [rows] = await db
    .query('SELECT name, derived_from_trust FROM entities ORDER BY name')
    .collect();
  // trusted ingest: derived_from_trust should be 'trusted' (or absent/default)
  for (const row of rows) {
    const val = row.derived_from_trust ?? 'trusted';
    assert.equal(
      val,
      'trusted',
      `entity "${row.name}" has derived_from_trust="${val}", expected "trusted"`,
    );
  }

  await close(db);
});
