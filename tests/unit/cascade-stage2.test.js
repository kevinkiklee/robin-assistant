import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { surql } from 'surrealdb';
import { close, connect } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { createStubEmbedder } from '../../src/embed/embedder.js';
import { stage2Resolve } from '../../src/graph/stage2-embedding.js';

async function fresh() {
  const db = await connect({ engine: 'mem://' });
  await runMigrations(db, resolve(import.meta.dirname, '../../src/schema/migrations'));
  return db;
}

test('stage2 returns auto-resolve when best similarity ≥ high threshold (same name)', async () => {
  const db = await fresh();
  const e = createStubEmbedder({ dimension: 384 });
  // Stub embedder is deterministic: same input → same vector → similarity 1.0
  const vec = Array.from(await e.embed('person: Alice'));
  await db
    .query(surql`CREATE entities CONTENT ${{ name: 'Alice', type: 'person', embedding: vec }}`)
    .collect();
  const result = await stage2Resolve(db, e, {
    name: 'Alice',
    type: 'person',
    highThreshold: 0.92,
    lowThreshold: 0.8,
  });
  assert.equal(result.action, 'resolve');
  assert.ok(result.entityId);
  assert.ok(result.similarity >= 0.92);
  await close(db);
});

test('stage2 returns none when no entities of the requested type exist', async () => {
  const db = await fresh();
  const e = createStubEmbedder({ dimension: 384 });
  const result = await stage2Resolve(db, e, {
    name: 'Nonexistent',
    type: 'person',
    highThreshold: 0.92,
    lowThreshold: 0.8,
  });
  assert.equal(result.action, 'none');
  await close(db);
});

test('stage2 scopes to type — does not match entity of different type', async () => {
  const db = await fresh();
  const e = createStubEmbedder({ dimension: 384 });
  const vec = Array.from(await e.embed('place: Paris'));
  await db
    .query(surql`CREATE entities CONTENT ${{ name: 'Paris', type: 'place', embedding: vec }}`)
    .collect();
  // Look up 'Paris' but as a person — should not find the place
  const result = await stage2Resolve(db, e, {
    name: 'Paris',
    type: 'person',
    highThreshold: 0.92,
    lowThreshold: 0.8,
  });
  assert.equal(result.action, 'none');
  await close(db);
});
