import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { closeDb, openDb } from './db.ts';
import { addRelation, findEntity, getEntity, relatedEntities, upsertEntity } from './entity.ts';
import { allMigrations, applyMigrations } from './migrations/index.ts';

function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), 'robin-entity-'));
  mkdirSync(join(dir, 'state', 'db'), { recursive: true });
  const db = openDb(join(dir, 'state', 'db', 'robin.sqlite'));
  applyMigrations(db, allMigrations);
  return db;
}

test('entity: upsert is idempotent', () => {
  const db = freshDb();
  const a = upsertEntity(db, 'person', 'Sarah');
  const b = upsertEntity(db, 'person', 'Sarah');
  assert.equal(a.id, b.id);
  closeDb(db);
});

test('entity: find by partial name', () => {
  const db = freshDb();
  upsertEntity(db, 'person', 'Sarah Chen');
  upsertEntity(db, 'place', 'Lisbon');
  const hits = findEntity(db, 'Sarah');
  assert.equal(hits.length, 1);
  assert.equal(hits[0].canonical_name, 'Sarah Chen');
  closeDb(db);
});

test('entity: get by id', () => {
  const db = freshDb();
  const a = upsertEntity(db, 'person', 'Kevin');
  const fetched = getEntity(db, a.id);
  assert.ok(fetched);
  assert.equal(fetched.canonical_name, 'Kevin');
  closeDb(db);
});

test('relations: 1-hop traversal returns connected entities', () => {
  const db = freshDb();
  const kevin = upsertEntity(db, 'person', 'Kevin');
  const lisbon = upsertEntity(db, 'place', 'Lisbon');
  const sarah = upsertEntity(db, 'person', 'Sarah');
  addRelation(db, kevin.id, 'visited', lisbon.id);
  addRelation(db, kevin.id, 'knows', sarah.id);
  const related = relatedEntities(db, kevin.id, 1);
  const names = related.map((e) => e.canonical_name).sort();
  assert.deepEqual(names, ['Lisbon', 'Sarah']);
  closeDb(db);
});
