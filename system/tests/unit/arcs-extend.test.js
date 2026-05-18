import assert from 'node:assert/strict';
import { mkdirSync as __robinMkdirSync } from 'node:fs';
import { tmpdir as __robinTmpdir } from 'node:os';
import { join as __robinJoin, resolve } from 'node:path';
import { test } from 'node:test';
import { RecordId, surql } from 'surrealdb';
import { writeConfig as __robinWriteConfig } from '../../config/paths.js';
import { close, connect } from '../../data/db/client.js';
import { runMigrations } from '../../data/db/migrate.js';
import { createArc, extendArc } from '../../cognition/memory/arcs.js';

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

async function seedEntity(db, key) {
  await db
    .query(surql`CREATE type::record('entities', ${key}) SET name = ${key}, type = 'thing'`)
    .collect();
  return new RecordId('entities', key);
}

test('extendArc preserves RecordId values so schemafull UPDATE accepts them', async () => {
  const db = await fresh();
  const a = await seedEntity(db, 'thing__alpha');
  const b = await seedEntity(db, 'thing__beta');
  const c = await seedEntity(db, 'thing__gamma');

  const created = await createArc(db, { summary: 'seed', entity_ids: [a, b] });
  assert.ok(created.id, 'arc was created');

  // Regression: before the fix, extendArc passed stringified record ids to
  // an UPDATE on an `array<record<entities>>` field and SurrealDB rejected
  // them with "Couldn't coerce value for field `entity_ids`".
  await extendArc(db, created.id, { entity_ids: [b, c] });

  const [rows] = await db
    .query(
      surql`SELECT entity_ids FROM ONLY type::record('arcs', ${String(created.id).split(':')[1]})`,
    )
    .collect();
  const ids = (rows?.entity_ids ?? rows?.[0]?.entity_ids ?? []).map(String);
  assert.equal(ids.length, 3, 'all three entities present after dedup');
  assert.ok(ids.includes(String(a)));
  assert.ok(ids.includes(String(b)));
  assert.ok(ids.includes(String(c)));

  await close(db);
});

test('extendArc dedups by record-id string key', async () => {
  const db = await fresh();
  const a = await seedEntity(db, 'thing__alpha');
  const b = await seedEntity(db, 'thing__beta');
  const created = await createArc(db, { summary: 'seed', entity_ids: [a] });
  await extendArc(db, created.id, { entity_ids: [a, a, b] });
  const [rows] = await db
    .query(
      surql`SELECT entity_ids FROM ONLY type::record('arcs', ${String(created.id).split(':')[1]})`,
    )
    .collect();
  const ids = (rows?.entity_ids ?? rows?.[0]?.entity_ids ?? []).map(String);
  assert.equal(ids.length, 2);
  await close(db);
});
