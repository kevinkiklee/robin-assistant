import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { surql } from 'surrealdb';
import { close, connect } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { createStubEmbedder } from '../../src/embed/embedder.js';
import { resolveEntity } from '../../src/graph/cascade.js';

async function fresh() {
  const db = await connect({ engine: 'mem://' });
  await runMigrations(db, resolve(import.meta.dirname, '../../src/schema/migrations'));
  return db;
}

test('cascade: Stage 1 hits short-circuit Stages 2/3 (LLM never called)', async () => {
  const db = await fresh();
  const e = createStubEmbedder({ dimension: 384 });
  const aliceVec = Array.from(await e.embed('person: Alice'));
  await db
    .query(surql`CREATE entities CONTENT ${{ name: 'Alice', type: 'person', embedding: aliceVec }}`)
    .collect();

  const config = { stage2_high_threshold: 0.92, stage2_low_threshold: 0.5 };
  const fakeHostNo = {
    invokeLLM: async () => {
      throw new Error('Stage 3 should not be called');
    },
  };
  const r = await resolveEntity(db, e, fakeHostNo, { name: 'alice', type: 'person', config });
  assert.equal(r.action, 'resolve');
  assert.equal(r.stage, 1);
  await close(db);
});

test('cascade: with no matching entities, returns none', async () => {
  const db = await fresh();
  const e = createStubEmbedder({ dimension: 384 });
  const fakeHostPick = {
    invokeLLM: async () => ({ content: JSON.stringify({ pick: null }), usage: {} }),
  };
  const config = { stage2_high_threshold: 0.92, stage2_low_threshold: 0.5 };
  const r = await resolveEntity(db, e, fakeHostPick, {
    name: 'TotallyNew',
    type: 'person',
    config,
  });
  assert.equal(r.action, 'none');
  await close(db);
});

test('cascade: type-scoped — same name as different type returns none', async () => {
  const db = await fresh();
  const e = createStubEmbedder({ dimension: 384 });
  const parisPlace = Array.from(await e.embed('place: Paris'));
  await db
    .query(
      surql`CREATE entities CONTENT ${{ name: 'Paris', type: 'place', embedding: parisPlace }}`,
    )
    .collect();
  const config = { stage2_high_threshold: 0.92, stage2_low_threshold: 0.5 };
  const fakeHost = {
    invokeLLM: async () => ({ content: JSON.stringify({ pick: null }), usage: {} }),
  };
  // Look up 'Paris' but as a person — should miss across all stages
  const r = await resolveEntity(db, e, fakeHost, { name: 'Paris', type: 'person', config });
  assert.equal(r.action, 'none');
  await close(db);
});
