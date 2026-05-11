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
import { createFindEntityTool } from '../../io/mcp/tools/find-entity.js';

// __robin_test_home_setup__
const __robinTestHome = __robinJoin(
  __robinTmpdir(),
  `robin-test-${process.pid}-${Math.random().toString(36).slice(2)}`,
);
__robinMkdirSync(__robinTestHome, { recursive: true });
process.env.ROBIN_HOME = __robinTestHome;
await __robinWriteConfig({ embedder_profile: 'mxbai-1024' });

async function fresh() {
  const db = await connect({ engine: 'mem://' });
  await runMigrations(db, resolve(import.meta.dirname, '../../data/db/migrations'));
  return db;
}

test('find_entity exact (fuzzy=false) matches by case-insensitive name', async () => {
  const db = await fresh();
  const e = createStubEmbedder({ dimension: 1024 });
  const _v = Array.from(await e.embed('person: Alice'));
  await db.query(surql`CREATE entities CONTENT ${{ name: 'Alice', type: 'person' }}`).collect();
  const tool = createFindEntityTool({ db, embedder: e });
  const r = await tool.handler({ name: 'alice', type: 'person', fuzzy: false });
  assert.equal(r.entities.length, 1);
  assert.equal(r.entities[0].name, 'Alice');
  await close(db);
});

test('find_entity returns empty when no match', async () => {
  const db = await fresh();
  const e = createStubEmbedder({ dimension: 1024 });
  const tool = createFindEntityTool({ db, embedder: e });
  const r = await tool.handler({ name: 'missing', fuzzy: false });
  assert.deepEqual(r.entities, []);
  await close(db);
});
