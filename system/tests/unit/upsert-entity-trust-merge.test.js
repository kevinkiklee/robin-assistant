import assert from 'node:assert/strict';
import { mkdirSync as __robinMkdirSync } from 'node:fs';
import { tmpdir as __robinTmpdir } from 'node:os';
import { join as __robinJoin, resolve } from 'node:path';
import { test } from 'node:test';
import { surql } from 'surrealdb';
import { writeConfig as __robinWriteConfig } from '../../config/paths.js';
import { close, connect } from '../../data/db/client.js';
import { runMigrations } from '../../data/db/migrate.js';
import { upsertEntityCascade } from '../../cognition/biographer/upsert-entity.js';

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

test('upsert-entity: stage1 re-mention from untrusted source downgrades derived_from_trust', async () => {
  const db = await fresh();

  // Create initial entity as trusted (stage1 exact match path will find it)
  await db
    .query(
      surql`CREATE type::record('entities', 'person__alice') CONTENT ${{
        name: 'Alice',
        name_lower: 'alice',
        type: 'person',
        scope: 'global',
        tags: [],
        derived_from_trust: 'trusted',
      }}`,
    )
    .collect();

  // Re-mention from an untrusted source — should trigger stage1 hit + trust merge
  const result = await upsertEntityCascade(db, null, {
    name: 'Alice',
    type: 'person',
    derived_from_trust: 'untrusted',
  });

  assert.equal(result.created, false, 'should resolve existing entity, not create');
  assert.equal(result.stage, 1, 'should resolve via stage1 exact match');
  assert.equal(result.derived_from_trust, 'untrusted', 'returned entity should reflect merged trust');

  // Verify the DB row was actually updated
  const [rows] = await db
    .query(surql`SELECT derived_from_trust FROM type::record('entities', 'person__alice')`)
    .collect();
  const row = Array.isArray(rows) ? rows[0] : rows;
  assert.equal(row.derived_from_trust, 'untrusted', 'DB row derived_from_trust should be untrusted after merge');

  await close(db);
});

test('upsert-entity: trusted re-mention does not change trusted entity', async () => {
  const db = await fresh();

  await db
    .query(
      surql`CREATE type::record('entities', 'person__bob') CONTENT ${{
        name: 'Bob',
        name_lower: 'bob',
        type: 'person',
        scope: 'global',
        tags: [],
        derived_from_trust: 'trusted',
      }}`,
    )
    .collect();

  const result = await upsertEntityCascade(db, null, {
    name: 'Bob',
    type: 'person',
    derived_from_trust: 'trusted',
  });

  assert.equal(result.created, false);
  assert.equal(result.stage, 1);
  assert.equal(result.derived_from_trust, 'trusted', 'trusted re-mention should keep trusted');

  const [rows] = await db
    .query(surql`SELECT derived_from_trust FROM type::record('entities', 'person__bob')`)
    .collect();
  const row = Array.isArray(rows) ? rows[0] : rows;
  assert.equal(row.derived_from_trust, 'trusted');

  await close(db);
});

test('upsert-entity: untrusted re-mention upgrades to untrusted-mixed when existing is trusted', async () => {
  const db = await fresh();

  await db
    .query(
      surql`CREATE type::record('entities', 'person__carol') CONTENT ${{
        name: 'Carol',
        name_lower: 'carol',
        type: 'person',
        scope: 'global',
        tags: [],
        derived_from_trust: 'untrusted-mixed',
      }}`,
    )
    .collect();

  // untrusted mention of an untrusted-mixed entity → worst-case = untrusted
  const result = await upsertEntityCascade(db, null, {
    name: 'Carol',
    type: 'person',
    derived_from_trust: 'untrusted',
  });

  assert.equal(result.created, false);
  assert.equal(result.derived_from_trust, 'untrusted', 'untrusted wins over untrusted-mixed');

  await close(db);
});
