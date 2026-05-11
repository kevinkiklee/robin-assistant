import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { surql } from 'surrealdb';
import {
  entityBoostFromAboutIds,
  matchCatalogEntities,
  matchPriorTailEntities,
  tokensOf,
} from '../../cognition/intuition/entities.js';
import * as store from '../../cognition/memory/store.js';
import { writeConfig } from '../../config/paths.js';
import { close, connect } from '../../data/db/client.js';
import { runMigrations } from '../../data/db/migrate.js';

test('tokensOf lowercases + drops tokens shorter than 3 chars', () => {
  const out = tokensOf('Kevin and Robin shipped to.io');
  assert.ok(out.has('kevin'));
  assert.ok(out.has('robin'));
  assert.ok(out.has('shipped'));
  assert.ok(!out.has('to')); // length 2
  assert.ok(!out.has('io')); // length 2
  assert.ok(out.has('and')); // length 3 → kept
});

test('matchCatalogEntities — exact token equality, not substring', () => {
  const catalog = [
    { id: 'entities:kevin', name: 'Kevin', type: 'person' },
    { id: 'entities:kevinlee', name: 'Kevinlee', type: 'person' },
  ];
  const queryTokens = tokensOf('did kevin ship today');
  const matched = matchCatalogEntities(catalog, queryTokens);
  assert.equal(matched.length, 1);
  assert.equal(matched[0].id, 'entities:kevin');
});

test('matchCatalogEntities skips entities whose name tokens are all <3 chars', () => {
  const catalog = [{ id: 'entities:os', name: 'OS', type: 'system' }];
  const matched = matchCatalogEntities(catalog, new Set(['os']));
  assert.equal(matched.length, 0);
});

test('entityBoostFromAboutIds: zero overlap → 1.0', () => {
  const out = entityBoostFromAboutIds(new Set(), new Set(['entities:a']), {});
  assert.deepEqual(out, { boost: 1.0, count: 0 });
});

test('entityBoostFromAboutIds: one overlap → 1.10', () => {
  const out = entityBoostFromAboutIds(
    new Set(['entities:a']),
    new Set(['entities:a']),
    { entity_boost_per_overlap: 0.1, entity_boost_max: 1.25 },
  );
  assert.ok(Math.abs(out.boost - 1.1) < 1e-6);
  assert.equal(out.count, 1);
});

test('entityBoostFromAboutIds: five overlaps → capped at 1.25', () => {
  const out = entityBoostFromAboutIds(
    new Set(['entities:a', 'entities:b', 'entities:c', 'entities:d', 'entities:e']),
    new Set(['entities:a', 'entities:b', 'entities:c', 'entities:d', 'entities:e']),
    { entity_boost_per_overlap: 0.1, entity_boost_max: 1.25 },
  );
  assert.equal(out.boost, 1.25);
  assert.equal(out.count, 5);
});

async function fresh() {
  const home = mkdtempSync(join(tmpdir(), 'robin-priortail-'));
  process.env.ROBIN_HOME = home;
  await writeConfig({ embedder_profile: 'mxbai-1024' });
  const db = await connect({ engine: 'mem://' });
  await runMigrations(db, resolve(import.meta.dirname, '../../data/db/migrations'));
  await db
    .query(surql`UPSERT runtime:embedder SET value = { active_profile: 'mxbai-1024' }`)
    .collect();
  return db;
}

test('matchPriorTailEntities harvests mentions edges off recent biographed events', async () => {
  const db = await fresh();
  const [entRows] = await db
    .query(
      surql`CREATE entities CONTENT ${{
        name: 'Nora',
        name_lower: 'nora',
        type: 'person',
      }}`,
    )
    .collect();
  const entId = entRows[0].id;
  const [evtRows] = await db
    .query(
      surql`CREATE events CONTENT ${{
        source: 'cli',
        content: 'discussed pipeline with nora',
        meta: { session_id: 's-pt' },
        biographed_at: new Date(),
      }}`,
    )
    .collect();
  const evtId = evtRows[0].id;
  await store.relate(db, evtId, entId, 'mentions');

  const out = await matchPriorTailEntities(db, 's-pt', { priorTailLimit: 3 });
  assert.equal(out.length, 1);
  assert.equal(String(out[0].id), String(entId));
  await close(db);
});

test('matchPriorTailEntities returns [] when sessionId is null', async () => {
  const db = await fresh();
  const out = await matchPriorTailEntities(db, null);
  assert.deepEqual(out, []);
  await close(db);
});
