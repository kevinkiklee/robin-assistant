import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { surql } from 'surrealdb';
import { close, connect } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { createStubEmbedder } from '../../src/embed/embedder.js';
import { writeCoOccursWith } from '../../src/graph/edges.js';

async function fresh() {
  const db = await connect({ engine: 'mem://' });
  await runMigrations(db, resolve(import.meta.dirname, '../../src/schema/migrations'));
  return db;
}

async function makeEntities(db, names) {
  const e = createStubEmbedder({ dimension: 384 });
  const ids = [];
  for (const n of names) {
    const v = Array.from(await e.embed(`person: ${n}`));
    const [c] = await db
      .query(surql`CREATE entities CONTENT ${{ name: n, type: 'person', embedding: v }}`)
      .collect();
    ids.push(Array.isArray(c) ? c[0].id : c.id);
  }
  return ids;
}

test('writeCoOccursWith creates two directional edges per pair', async () => {
  const db = await fresh();
  const [a, b] = await makeEntities(db, ['Alice', 'Bob']);
  await writeCoOccursWith(db, [a, b]);
  const [rows] = await db.query(surql`SELECT * FROM co_occurs_with`).collect();
  assert.equal(rows.length, 2); // A→B and B→A
  for (const r of rows) {
    assert.equal(r.strength, 1);
  }
  await close(db);
});

test('writeCoOccursWith increments strength on repeat', async () => {
  const db = await fresh();
  const [a, b] = await makeEntities(db, ['Alice', 'Bob']);
  await writeCoOccursWith(db, [a, b]);
  await writeCoOccursWith(db, [a, b]);
  const [rows] = await db.query(surql`SELECT * FROM co_occurs_with`).collect();
  assert.equal(rows.length, 2);
  for (const r of rows) {
    assert.equal(r.strength, 2);
  }
  await close(db);
});

test('writeCoOccursWith caps at top N entities (cap=4 → 4 entities → 12 edges)', async () => {
  const db = await fresh();
  const ids = await makeEntities(db, ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J']);
  // 10 entities, cap=4 → top 4 only → 4×3 = 12 edges
  await writeCoOccursWith(db, ids, { cap: 4 });
  const [rows] = await db.query(surql`SELECT * FROM co_occurs_with`).collect();
  assert.equal(rows.length, 12);
  await close(db);
});

test('writeCoOccursWith with single entity creates no edges (no pair)', async () => {
  const db = await fresh();
  const ids = await makeEntities(db, ['Solo']);
  await writeCoOccursWith(db, ids);
  const [rows] = await db.query(surql`SELECT * FROM co_occurs_with`).collect();
  assert.equal(rows.length, 0);
  await close(db);
});

test('writeCoOccursWith default cap is 8', async () => {
  const db = await fresh();
  const ids = await makeEntities(db, ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J']);
  await writeCoOccursWith(db, ids); // default cap=8
  const [rows] = await db.query(surql`SELECT * FROM co_occurs_with`).collect();
  assert.equal(rows.length, 8 * 7); // 8 entities → 56 edges
  await close(db);
});
