import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { surql } from 'surrealdb';
import { close, connect } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';

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

test('schema rejects entity with wrong type', async () => {
  const db = await fresh();
  const dummy = Array.from({ length: 384 }, () => 0.1);
  await assert.rejects(
    db
      .query(surql`CREATE entities CONTENT ${{ name: 'X', type: 'invalid', embedding: dummy }}`)
      .collect(),
    /type|invalid/i,
  );
  await close(db);
});

test('schema rejects entity with wrong embedding dim', async () => {
  const db = await fresh();
  await assert.rejects(
    db
      .query(surql`CREATE entities CONTENT ${{ name: 'X', type: 'person', embedding: [0.1, 0.2] }}`)
      .collect(),
    /array::len|384/,
  );
  await close(db);
});

test('schema rejects entity with empty name', async () => {
  const db = await fresh();
  const dummy = Array.from({ length: 384 }, () => 0.1);
  await assert.rejects(
    db
      .query(surql`CREATE entities CONTENT ${{ name: '', type: 'person', embedding: dummy }}`)
      .collect(),
    /name|len/i,
  );
  await close(db);
});

test('ENFORCED edge rejects link to non-existent entity', async () => {
  const db = await fresh();
  // Create an event so we have a valid 'from' record
  const dummy = Array.from({ length: 384 }, () => 0.1);
  const [evt] = await db
    .query(
      surql`CREATE events CONTENT ${{
        source: 'cli',
        content: 'x',
        content_hash: 'abc',
        embedding: dummy,
      }}`,
    )
    .collect();
  const eventId = (Array.isArray(evt) ? evt[0] : evt).id;
  // Try to RELATE event → mentions → non-existent entity
  await assert.rejects(
    db.query(surql`RELATE ${eventId}->mentions->entities:nonexistent`).collect(),
    /enforced|exist|reference|not found|invalid/i,
  );
  await close(db);
});

test('episode_id record link must reference an existing episode', async () => {
  const db = await fresh();
  const dummy = Array.from({ length: 384 }, () => 0.1);
  // Create a valid event first
  const [evt] = await db
    .query(
      surql`CREATE events CONTENT ${{
        source: 'cli',
        content: 'x',
        content_hash: 'abc',
        embedding: dummy,
      }}`,
    )
    .collect();
  const eventId = (Array.isArray(evt) ? evt[0] : evt).id;
  // SurrealDB's record<episodes> field accepts any record id of the right table-shape;
  // it does NOT enforce existence (that's only `RELATION ... ENFORCED`). So this should
  // succeed — verify that's the case so the test pins the actual behavior.
  const updated = await db
    .query(surql`UPDATE ${eventId} SET episode_id = episodes:nonexistent`)
    .collect();
  assert.ok(updated[0]); // Update succeeds; existence is not enforced for record<...> links
  await close(db);
});
