import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { surql } from 'surrealdb';
import { close, connect } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { createStubEmbedder } from '../../src/embed/embedder.js';
import { createFindEntityTool } from '../../src/mcp/tools/find-entity.js';

async function fresh() {
  const db = await connect({ engine: 'mem://' });
  await runMigrations(db, resolve(import.meta.dirname, '../../src/schema/migrations'));
  return db;
}

test('find_entity exact (fuzzy=false) matches by case-insensitive name', async () => {
  const db = await fresh();
  const e = createStubEmbedder({ dimension: 384 });
  const v = Array.from(await e.embed('person: Alice'));
  await db
    .query(surql`CREATE entities CONTENT ${{ name: 'Alice', type: 'person', embedding: v }}`)
    .collect();
  const tool = createFindEntityTool({ db, embedder: e });
  const r = await tool.handler({ name: 'alice', type: 'person', fuzzy: false });
  assert.equal(r.entities.length, 1);
  assert.equal(r.entities[0].name, 'Alice');
  await close(db);
});

test('find_entity returns empty when no match', async () => {
  const db = await fresh();
  const e = createStubEmbedder({ dimension: 384 });
  const tool = createFindEntityTool({ db, embedder: e });
  const r = await tool.handler({ name: 'missing', fuzzy: false });
  assert.deepEqual(r.entities, []);
  await close(db);
});
