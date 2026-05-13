// Edges tests for the new schema: per-relation tables (mentions/about/
// works_on) were collapsed into a single `edges` table with a `kind`
// discriminator. Assertions now select FROM edges WHERE kind = '<kind>'.

import assert from 'node:assert/strict';
import { mkdirSync as __robinMkdirSync } from 'node:fs';
import { tmpdir as __robinTmpdir } from 'node:os';
import { join as __robinJoin, resolve } from 'node:path';
import { test } from 'node:test';
import { surql } from 'surrealdb';
import { writeMentionsEdge } from '../../cognition/biographer/edges.js';
import { writeConfig as __robinWriteConfig } from '../../config/paths.js';
import { close, connect } from '../../data/db/client.js';
import { runMigrations } from '../../data/db/migrate.js';
import { createStubEmbedder } from '../../data/embed/embedder.js';
import { recordEvent } from '../../io/capture/record-event.js';

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

async function seed(db) {
  const e = createStubEmbedder({ dimension: 1024 });
  const evt = await recordEvent(db, e, { source: 'cli', content: 'Alice met Bob about Atlas.' });
  const [aliceCreated] = await db
    .query(surql`CREATE entities CONTENT ${{ name: 'Alice', type: 'person' }}`)
    .collect();
  const [bobCreated] = await db
    .query(surql`CREATE entities CONTENT ${{ name: 'Bob', type: 'person' }}`)
    .collect();
  const [atlasCreated] = await db
    .query(surql`CREATE entities CONTENT ${{ name: 'Atlas', type: 'project' }}`)
    .collect();
  return {
    eventId: evt.id,
    aliceId: (Array.isArray(aliceCreated) ? aliceCreated[0] : aliceCreated).id,
    bobId: (Array.isArray(bobCreated) ? bobCreated[0] : bobCreated).id,
    atlasId: (Array.isArray(atlasCreated) ? atlasCreated[0] : atlasCreated).id,
  };
}

test('writeMentionsEdge creates an event→entity edge with weight + context', async () => {
  const db = await fresh();
  const { eventId, aliceId } = await seed(db);
  await writeMentionsEdge(db, eventId, aliceId, { weight: 0.9, context: 'Alice met...' });
  const [rows] = await db.query(surql`SELECT * FROM edges WHERE kind = 'mentions'`).collect();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].weight, 0.9);
  assert.equal(rows[0].context, 'Alice met...');
  await close(db);
});

test('writeMentionsEdge works without optional fields', async () => {
  const db = await fresh();
  const { eventId, aliceId } = await seed(db);
  await writeMentionsEdge(db, eventId, aliceId);
  const [rows] = await db.query(surql`SELECT * FROM edges WHERE kind = 'mentions'`).collect();
  assert.equal(rows.length, 1);
  await close(db);
});

test('store.relate rejects unknown edge kinds (vocabulary check)', async () => {
  const store = await import('../../cognition/memory/store.js');
  const db = await fresh();
  const { aliceId, atlasId } = await seed(db);
  await assert.rejects(
    store.relate(db, aliceId, atlasId, 'evil_injection_attempt'),
    /invalid|kind|vocabulary/i,
  );
  await close(db);
});
