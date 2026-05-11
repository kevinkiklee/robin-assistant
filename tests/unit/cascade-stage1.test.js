import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { surql } from 'surrealdb';
import { close, connect } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { stage1Resolve } from '../../src/graph/stage1-exact.js';

import { mkdirSync as __robinMkdirSync } from 'node:fs';
import { tmpdir as __robinTmpdir } from 'node:os';
import { join as __robinJoin } from 'node:path';
import { writeConfig as __robinWriteConfig } from '../../src/runtime/config.js';

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
  await runMigrations(db, resolve(import.meta.dirname, '../../src/schema/migrations'));
  return db;
}

test('stage1Resolve finds existing entity by exact case-insensitive name + type', async () => {
  const db = await fresh();
  const dummyVec = Array.from({ length: 1024 }, (_, i) => i / 1024);
  await db
    .query(surql`CREATE entities CONTENT ${{ name: 'Alice', type: 'person'}}`)
    .collect();
  const id = await stage1Resolve(db, { name: 'alice', type: 'person' });
  assert.ok(id);
  await close(db);
});

test('stage1Resolve returns null on miss', async () => {
  const db = await fresh();
  const id = await stage1Resolve(db, { name: 'NoSuchEntity', type: 'person' });
  assert.equal(id, null);
  await close(db);
});

test('stage1Resolve does not cross types', async () => {
  const db = await fresh();
  const dummyVec = Array.from({ length: 1024 }, () => 0.1);
  await db
    .query(
      surql`CREATE entities CONTENT ${{ name: 'Atlas', type: 'project'}}`,
    )
    .collect();
  const id = await stage1Resolve(db, { name: 'atlas', type: 'place' });
  assert.equal(id, null);
  await close(db);
});

test('stage1Resolve matches mixed-case lookup against differently-cased stored name', async () => {
  const db = await fresh();
  const dummyVec = Array.from({ length: 1024 }, () => 0.2);
  await db
    .query(surql`CREATE entities CONTENT ${{ name: 'BOB', type: 'person'}}`)
    .collect();
  const id = await stage1Resolve(db, { name: 'bOb', type: 'person' });
  assert.ok(id);
  await close(db);
});
