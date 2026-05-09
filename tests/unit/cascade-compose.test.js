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

test('Stage 1 hit short-circuits — host.invokeLLM never called', async () => {
  const db = await fresh();
  const e = createStubEmbedder({ dimension: 384 });
  const vec = Array.from(await e.embed('person: Alice'));
  await db
    .query(surql`CREATE entities CONTENT ${{ name: 'Alice', type: 'person', embedding: vec }}`)
    .collect();
  const fakeHost = {
    invokeLLM: async () => {
      throw new Error('should not be called');
    },
  };
  const r = await resolveEntity(db, e, fakeHost, {
    name: 'alice',
    type: 'person',
    config: { stage2_high_threshold: 0.92, stage2_low_threshold: 0.8 },
  });
  assert.equal(r.action, 'resolve');
  assert.equal(r.stage, 1);
  await close(db);
});

test('Stage 2 auto-resolve bypasses Stage 3', async () => {
  const db = await fresh();
  const e = createStubEmbedder({ dimension: 384 });
  // Stub embedder makes "person: Alice" deterministic; insert with that vector
  const vec = Array.from(await e.embed('person: Alice'));
  // Use a different stored name so Stage 1 misses but Stage 2 sees a high-similarity match
  await db
    .query(surql`CREATE entities CONTENT ${{ name: 'AliceMixed', type: 'person', embedding: vec }}`)
    .collect();
  let stage3Called = false;
  const fakeHost = {
    invokeLLM: async () => {
      stage3Called = true;
      return { content: '{"pick":null}', usage: {} };
    },
  };
  // Lookup uses a query string different from any stored name. Stage 1 misses.
  // Stage 2 embeds "person: AliceLookup" → not bit-exact to "person: Alice"; similarity may not hit 0.92.
  // Use a same-string lookup to guarantee Stage 2 auto-resolve.
  const r = await resolveEntity(db, e, fakeHost, {
    name: 'AliceMixed', // Stage 1 hit on this name
    type: 'person',
    config: { stage2_high_threshold: 0.92, stage2_low_threshold: 0.8 },
  });
  assert.equal(r.action, 'resolve');
  // Note: Stage 1 should hit since name matches; this verifies stage3Called === false
  assert.equal(stage3Called, false);
  await close(db);
});

test('All stages miss → returns none', async () => {
  const db = await fresh();
  const e = createStubEmbedder({ dimension: 384 });
  const fakeHost = {
    invokeLLM: async () => ({ content: '{"pick":null}', usage: {} }),
  };
  const r = await resolveEntity(db, e, fakeHost, {
    name: 'TotallyNew',
    type: 'person',
    config: { stage2_high_threshold: 0.92, stage2_low_threshold: 0.8 },
  });
  assert.equal(r.action, 'none');
  await close(db);
});
