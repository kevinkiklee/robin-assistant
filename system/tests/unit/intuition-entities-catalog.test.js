import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { surql } from 'surrealdb';
import {
  __resetEntityCatalogCacheForTests,
  readEntityCatalog,
} from '../../cognition/intuition/entities.js';
import { writeConfig } from '../../config/paths.js';
import { close, connect } from '../../data/db/client.js';
import { runMigrations } from '../../data/db/migrate.js';

async function fresh() {
  const home = mkdtempSync(join(tmpdir(), 'robin-catalog-'));
  process.env.ROBIN_HOME = home;
  await writeConfig({ embedder_profile: 'mxbai-1024' });
  const db = await connect({ engine: 'mem://' });
  await runMigrations(db, resolve(import.meta.dirname, '../../data/db/migrations'));
  await db
    .query(surql`UPSERT runtime:embedder SET value = { active_profile: 'mxbai-1024' }`)
    .collect();
  return db;
}

test('readEntityCatalog caches within TTL', async () => {
  __resetEntityCatalogCacheForTests();
  const db = await fresh();
  await db
    .query(
      surql`CREATE entities CONTENT ${{
        name: 'Alice',
        name_lower: 'alice',
        type: 'person',
      }}`,
    )
    .collect();

  const first = await readEntityCatalog(db, { entity_catalog_ttl_seconds: 60 });
  assert.equal(first.length, 1);

  // Mutate the DB; cache should ignore until TTL expires.
  await db
    .query(
      surql`CREATE entities CONTENT ${{
        name: 'Bob',
        name_lower: 'bob',
        type: 'person',
      }}`,
    )
    .collect();

  const second = await readEntityCatalog(db, { entity_catalog_ttl_seconds: 60 });
  assert.equal(second.length, 1, 'cache should still return 1 entry within TTL');

  __resetEntityCatalogCacheForTests();
  const third = await readEntityCatalog(db, { entity_catalog_ttl_seconds: 60 });
  assert.equal(third.length, 2);

  await close(db);
});
