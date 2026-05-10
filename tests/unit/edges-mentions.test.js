import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { surql } from 'surrealdb';
import { recordEvent } from '../../src/capture/record-event.js';
import { close, connect } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { createStubEmbedder } from '../../src/embed/embedder.js';
import { writeAboutEdge, writeMentionsEdge, writeTypedEntityEdge } from '../../src/graph/edges.js';

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

async function seed(db) {
  const e = createStubEmbedder({ dimension: 384 });
  const evt = await recordEvent(db, e, { source: 'cli', content: 'Alice met Bob about Atlas.' });
  const aliceVec = Array.from(await e.embed('person: Alice'));
  const bobVec = Array.from(await e.embed('person: Bob'));
  const atlasVec = Array.from(await e.embed('project: Atlas'));
  const [aliceCreated] = await db
    .query(surql`CREATE entities CONTENT ${{ name: 'Alice', type: 'person', embedding: aliceVec }}`)
    .collect();
  const [bobCreated] = await db
    .query(surql`CREATE entities CONTENT ${{ name: 'Bob', type: 'person', embedding: bobVec }}`)
    .collect();
  const [atlasCreated] = await db
    .query(
      surql`CREATE entities CONTENT ${{ name: 'Atlas', type: 'project', embedding: atlasVec }}`,
    )
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
  const [rows] = await db.query(surql`SELECT * FROM mentions`).collect();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].weight, 0.9);
  assert.equal(rows[0].context, 'Alice met...');
  await close(db);
});

test('writeMentionsEdge works without optional fields', async () => {
  const db = await fresh();
  const { eventId, aliceId } = await seed(db);
  await writeMentionsEdge(db, eventId, aliceId);
  const [rows] = await db.query(surql`SELECT * FROM mentions`).collect();
  assert.equal(rows.length, 1);
  await close(db);
});

test('writeAboutEdge creates an event→entity edge', async () => {
  const db = await fresh();
  const { eventId, atlasId } = await seed(db);
  await writeAboutEdge(db, eventId, atlasId);
  const [rows] = await db.query(surql`SELECT * FROM about`).collect();
  assert.equal(rows.length, 1);
  await close(db);
});

test('writeTypedEntityEdge creates a works_on edge between entities', async () => {
  const db = await fresh();
  const { aliceId, atlasId } = await seed(db);
  await writeTypedEntityEdge(db, aliceId, 'works_on', atlasId);
  const [rows] = await db.query(surql`SELECT * FROM works_on`).collect();
  assert.equal(rows.length, 1);
  await close(db);
});

test('writeTypedEntityEdge throws on invalid edgeType (vocabulary check)', async () => {
  const db = await fresh();
  const { aliceId, atlasId } = await seed(db);
  await assert.rejects(
    writeTypedEntityEdge(db, aliceId, 'evil_injection_attempt', atlasId),
    /edge type|invalid|vocabulary/i,
  );
  await close(db);
});
