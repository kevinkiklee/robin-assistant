import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { surql } from 'surrealdb';
import { __resetEntityCatalogCacheForTests } from '../../cognition/intuition/entities.js';
import { intuitionEndpoint } from '../../cognition/intuition/inject.js';
import * as store from '../../cognition/memory/store.js';
import { writeConfig } from '../../config/paths.js';
import { close, connect } from '../../data/db/client.js';
import { runMigrations } from '../../data/db/migrate.js';
import { createStubEmbedder } from '../../data/embed/embedder.js';

async function fresh() {
  __resetEntityCatalogCacheForTests();
  const home = mkdtempSync(join(tmpdir(), 'robin-entboost-'));
  process.env.ROBIN_HOME = home;
  await writeConfig({ embedder_profile: 'mxbai-1024' });
  const db = await connect({ engine: 'mem://' });
  await runMigrations(db, resolve(import.meta.dirname, '../../data/db/migrations'));
  await db
    .query(surql`UPSERT runtime:embedder SET value = { active_profile: 'mxbai-1024' }`)
    .collect();
  return db;
}

test('intuitionEndpoint applies entity boost on memos with about-edge match', async () => {
  const db = await fresh();
  const e = createStubEmbedder({ dimension: 1024 });

  // Seed entity.
  const [entRows] = await db
    .query(
      surql`CREATE entities CONTENT ${{
        name: 'Karen',
        name_lower: 'karen',
        type: 'person',
      }}`,
    )
    .collect();
  const entId = entRows[0].id;

  // Seed memo + about edge.
  const memo = await store.note(db, e, 'knowledge', {
    content: 'karen prefers heirloom tomatoes',
    derived_by: 'manual',
  });
  await store.relate(db, memo.id, entId, 'about');

  __resetEntityCatalogCacheForTests();

  await intuitionEndpoint({
    db,
    embedder: e,
    query: 'karen plans for tomatoes',
    priorAssistant: '',
    k: 6,
    recencyDays: 30,
    tokenBudget: 1500,
    sessionId: 's1',
  });

  const [tel] = await db.query(surql`SELECT meta FROM intuition_telemetry`).collect();
  assert.equal(tel[0].meta?.entity_boost_applied, true);
  assert.ok(tel[0].meta?.entity_boost_count >= 1);
  assert.equal(tel[0].meta?.query_entities_matched, 1);

  const [recall] = await db.query(surql`SELECT ranked_hits FROM recall_log`).collect();
  const boostedHit = recall[0].ranked_hits.find((h) => h.score_components?.entityBoost > 1.0);
  assert.ok(boostedHit, 'expected at least one hit with entityBoost > 1.0');

  await close(db);
});
