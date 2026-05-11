import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { BoundQuery, surql } from 'surrealdb';
import { close, connect } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { createStubEmbedder } from '../../src/embed/embedder.js';
import { activeProfile, embeddingTable } from '../../src/embed/profile-router.js';
import { stage2Resolve } from '../../src/graph/stage2-embedding.js';

// stage2 reads from the per-profile embeddings_<profile>_entities surface,
// not from an inline `entities.embedding` column (gone in the redesign).
// Seed both the entity row and its embedding row.
async function seedEntity(db, embedder, { name, type }) {
  const [created] = await db.query(surql`CREATE entities CONTENT ${{ name, type }}`).collect();
  const id = (Array.isArray(created) ? created[0] : created).id;
  const profile = await activeProfile(db);
  const tbl = embeddingTable(profile, 'entities');
  const vec = Array.from(await embedder.embed(`${type}: ${name}`));
  await db
    .query(
      new BoundQuery(
        'UPSERT type::record($tb, [$rec]) SET record = $rec, vector = $vec, ts = time::now()',
        { tb: tbl, rec: id, vec },
      ),
    )
    .collect();
  return id;
}

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

test('stage2 returns auto-resolve when best similarity ≥ high threshold (same name)', async () => {
  const db = await fresh();
  const e = createStubEmbedder({ dimension: 1024 });
  await seedEntity(db, e, { name: 'Alice', type: 'person' });
  const result = await stage2Resolve(db, e, {
    name: 'Alice',
    type: 'person',
    highThreshold: 0.92,
    lowThreshold: 0.8,
  });
  assert.equal(result.action, 'resolve');
  assert.ok(result.entityId);
  assert.ok(result.similarity >= 0.92);
  await close(db);
});

test('stage2 returns none when no entities of the requested type exist', async () => {
  const db = await fresh();
  const e = createStubEmbedder({ dimension: 1024 });
  const result = await stage2Resolve(db, e, {
    name: 'Nonexistent',
    type: 'person',
    highThreshold: 0.92,
    lowThreshold: 0.8,
  });
  assert.equal(result.action, 'none');
  await close(db);
});

test('stage2 scopes to type — does not match entity of different type', async () => {
  const db = await fresh();
  const e = createStubEmbedder({ dimension: 1024 });
  await seedEntity(db, e, { name: 'Paris', type: 'place' });
  // Look up 'Paris' but as a person — should not find the place
  const result = await stage2Resolve(db, e, {
    name: 'Paris',
    type: 'person',
    highThreshold: 0.92,
    lowThreshold: 0.8,
  });
  assert.equal(result.action, 'none');
  await close(db);
});
