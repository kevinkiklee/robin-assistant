import assert from 'node:assert/strict';
import { mkdirSync as __robinMkdirSync } from 'node:fs';
import { tmpdir as __robinTmpdir } from 'node:os';
import { join as __robinJoin, resolve } from 'node:path';
import { test } from 'node:test';
import { surql } from 'surrealdb';
import { close, connect } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { writeCoOccursWith } from '../../src/graph/edges.js';
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

async function makeEntities(db, names) {
  const ids = [];
  for (const n of names) {
    const [c] = await db
      .query(surql`CREATE entities CONTENT ${{ name: n, type: 'person' }}`)
      .collect();
    ids.push(Array.isArray(c) ? c[0].id : c.id);
  }
  return ids;
}

// Old schema had a `co_occurs_with` table with directional rows (two per pair).
// The redesign collapsed all relations into the `edges` table with a `kind`
// discriminator. The symmetric kind 'occurs_with' canonicalises endpoint order
// inside store.relate, so each unordered pair produces exactly ONE row whose
// `weight` increments on repeat. Tests assert the new counts (1 per pair,
// not 2 per pair).

test('writeCoOccursWith creates one symmetric edge per pair', async () => {
  const db = await fresh();
  const [a, b] = await makeEntities(db, ['Alice', 'Bob']);
  await writeCoOccursWith(db, [a, b]);
  const [rows] = await db.query(surql`SELECT * FROM edges WHERE kind = 'occurs_with'`).collect();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].weight, 1);
  await close(db);
});

test('writeCoOccursWith increments weight on repeat', async () => {
  const db = await fresh();
  const [a, b] = await makeEntities(db, ['Alice', 'Bob']);
  await writeCoOccursWith(db, [a, b]);
  await writeCoOccursWith(db, [a, b]);
  const [rows] = await db.query(surql`SELECT * FROM edges WHERE kind = 'occurs_with'`).collect();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].weight, 2);
  await close(db);
});

test('writeCoOccursWith caps at top N entities (cap=4 → 4 entities → 6 edges)', async () => {
  const db = await fresh();
  const ids = await makeEntities(db, ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J']);
  // 10 entities, cap=4 → top 4 only → C(4,2) = 6 symmetric edges
  await writeCoOccursWith(db, ids, { cap: 4 });
  const [rows] = await db.query(surql`SELECT * FROM edges WHERE kind = 'occurs_with'`).collect();
  assert.equal(rows.length, 6);
  await close(db);
});

test('writeCoOccursWith with single entity creates no edges (no pair)', async () => {
  const db = await fresh();
  const ids = await makeEntities(db, ['Solo']);
  await writeCoOccursWith(db, ids);
  const [rows] = await db.query(surql`SELECT * FROM edges WHERE kind = 'occurs_with'`).collect();
  assert.equal(rows.length, 0);
  await close(db);
});

test('writeCoOccursWith default cap is 8', async () => {
  const db = await fresh();
  const ids = await makeEntities(db, ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J']);
  await writeCoOccursWith(db, ids); // default cap=8
  const [rows] = await db.query(surql`SELECT * FROM edges WHERE kind = 'occurs_with'`).collect();
  // 8 entities → C(8,2) = 28 symmetric edges
  assert.equal(rows.length, 28);
  await close(db);
});
