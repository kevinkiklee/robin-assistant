import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { surql } from 'surrealdb';
import { close, connect } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { createPattern, listPatterns, upsertPatternByName } from '../../src/memory/habits.js';

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

test('createPattern writes a row', async () => {
  const db = await fresh();
  const r = await createPattern(db, {
    name: 'morning-atlas-work',
    description: 'User works on Atlas in the morning',
    source_events: [],
  });
  assert.ok(r.id);
  await close(db);
});

test('upsertPatternByName updates existing', async () => {
  const db = await fresh();
  const r1 = await upsertPatternByName(db, {
    name: 'p1',
    description: 'first',
    source_events: [],
  });
  const r2 = await upsertPatternByName(db, {
    name: 'p1',
    description: 'updated',
    source_events: [],
  });
  assert.equal(String(r1.id), String(r2.id));
  const [rows] = await db.query(surql`SELECT signal_count FROM ${r2.id}`).collect();
  assert.equal(rows[0].signal_count, 2);
  await close(db);
});

test('listPatterns returns recent patterns', async () => {
  const db = await fresh();
  await createPattern(db, { name: 'a', description: 'a', source_events: [] });
  await createPattern(db, { name: 'b', description: 'b', source_events: [] });
  const list = await listPatterns(db);
  assert.ok(list.length >= 2);
  await close(db);
});
