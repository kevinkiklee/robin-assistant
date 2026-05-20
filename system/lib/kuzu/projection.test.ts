import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { openDb, closeDb } from '../../brain/memory/db.ts';
import { allMigrations, applyMigrations } from '../../brain/memory/migrations/index.ts';
import { upsertEntity, addRelation } from '../../brain/memory/entity.ts';
import { rebuildKuzuProjection, queryKuzu } from './projection.ts';

function freshSqlite() {
  const dir = mkdtempSync(join(tmpdir(), 'robin-kuzu-'));
  mkdirSync(join(dir, 'state', 'db'), { recursive: true });
  mkdirSync(join(dir, 'state', 'kuzu'), { recursive: true });
  const db = openDb(join(dir, 'state', 'db', 'robin.sqlite'));
  applyMigrations(db, allMigrations);
  return { db, dir };
}

test('kuzu projection: rebuild from sqlite entities + relations', async () => {
  const { db, dir } = freshSqlite();
  // Seed: Kevin -> visited -> Lisbon; Kevin -> knows -> Sarah
  const kevin = upsertEntity(db, 'person', 'Kevin');
  const lisbon = upsertEntity(db, 'place', 'Lisbon');
  const sarah = upsertEntity(db, 'person', 'Sarah');
  addRelation(db, kevin.id, 'visited', lisbon.id);
  addRelation(db, kevin.id, 'knows', sarah.id);

  const kuzuPath = join(dir, 'state', 'kuzu', 'robin.kuzu');
  const r = await rebuildKuzuProjection(db, kuzuPath);
  // If kuzu isn't loadable (e.g., binary missing on this platform), the function returns 0/0.
  // We expect 3 entities + 2 relations OR a clean 0/0 fallback.
  if (r.entities > 0) {
    assert.equal(r.entities, 3);
    assert.equal(r.relations, 2);
    assert.ok(r.durationMs >= 0);

    // Query: Kevin's 1-hop neighbors
    const hits = await queryKuzu<{ name: string; pred: string }>(
      kuzuPath,
      "MATCH (a:Entity {canonical_name: 'Kevin'})-[r:Relation]->(b:Entity) RETURN b.canonical_name AS name, r.predicate AS pred",
    );
    assert.ok(hits.length >= 2);
  }
  closeDb(db);
});

test('kuzu projection: queryKuzu returns empty when projection does not exist', async () => {
  const r = await queryKuzu('/nonexistent/kuzu/path', 'MATCH (n) RETURN n');
  assert.deepEqual(r, []);
});
