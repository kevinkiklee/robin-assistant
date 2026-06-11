import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { closeDb, openDb } from './db.ts';
import {
  addRelation,
  findEntity,
  getEntity,
  normalizeEntityType,
  relatedEntities,
  upsertEntity,
} from './entity.ts';
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

test('normalizeEntityType: standard types pass through', () => {
  for (const t of ['person', 'place', 'organization', 'service', 'topic', 'thing']) {
    assert.equal(normalizeEntityType(t), t);
  }
});

test('normalizeEntityType: specific types are preserved, unknown map to thing', () => {
  assert.equal(normalizeEntityType('lens'), 'lens');
  assert.equal(normalizeEntityType('event'), 'event');
  assert.equal(normalizeEntityType('tool'), 'tool');
  assert.equal(normalizeEntityType('camera'), 'camera');
  assert.equal(normalizeEntityType('film'), 'film');
  assert.equal(normalizeEntityType('medication'), 'medication');
  assert.equal(normalizeEntityType('PERSON'), 'person');
  assert.equal(normalizeEntityType('unknown_garbage'), 'thing');
});

test('upsertEntity: specific types are preserved', () => {
  const db = freshDb();
  const e = upsertEntity(db, 'lens', 'Viltrox 85mm f/2');
  assert.equal(e.type, 'lens');
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

// ── profile_generated_at stamping (Task 9) ────────────────────────────────────

test('upsertEntity: upsert with profile sets profile_generated_at (INSERT path)', () => {
  const db = freshDb();
  const ent = upsertEntity(db, 'person', 'Alice', 'Alice is a developer');
  const row = db.prepare('SELECT profile_generated_at FROM entities WHERE id = ?').get(ent.id) as {
    profile_generated_at: string | null;
  };
  assert.ok(
    row.profile_generated_at !== null,
    'profile_generated_at should be set after INSERT with profile',
  );
  // Use SQLite datetime comparison to handle format differences.
  const cmp = db
    .prepare(`SELECT datetime(?) >= datetime('now', '-5 seconds') AS ok`)
    .get(row.profile_generated_at) as { ok: number };
  assert.equal(cmp.ok, 1, `profile_generated_at (${row.profile_generated_at}) should be recent`);
  closeDb(db);
});

test('upsertEntity: upsert without profile leaves profile_generated_at NULL (INSERT path)', () => {
  const db = freshDb();
  const ent = upsertEntity(db, 'person', 'Bob');
  const row = db.prepare('SELECT profile_generated_at FROM entities WHERE id = ?').get(ent.id) as {
    profile_generated_at: string | null;
  };
  assert.equal(
    row.profile_generated_at,
    null,
    'profile_generated_at should be NULL when no profile inserted',
  );
  closeDb(db);
});

test('upsertEntity: updating an existing profile re-stamps profile_generated_at (UPDATE path)', () => {
  const db = freshDb();
  // Insert with a profile, then manually backdate profile_generated_at to simulate an old write.
  const ent = upsertEntity(db, 'person', 'Carol', 'old profile');
  db.prepare(`UPDATE entities SET profile_generated_at = '2020-01-01 00:00:00' WHERE id = ?`).run(
    ent.id,
  );

  // Update with a new profile — should re-stamp.
  upsertEntity(db, 'person', 'Carol', 'new profile');
  const row = db.prepare('SELECT profile_generated_at FROM entities WHERE id = ?').get(ent.id) as {
    profile_generated_at: string | null;
  };
  assert.ok(
    row.profile_generated_at !== null,
    'profile_generated_at should be set after profile update',
  );
  // Should be recent (not the 2020 backdate).
  const cmp = db
    .prepare(`SELECT datetime(?) >= datetime('now', '-5 seconds') AS ok`)
    .get(row.profile_generated_at) as { ok: number };
  assert.equal(
    cmp.ok,
    1,
    `profile_generated_at (${row.profile_generated_at}) should be refreshed after profile update`,
  );
  closeDb(db);
});

test('upsertEntity: same profile does not change profile_generated_at', () => {
  const db = freshDb();
  const ent = upsertEntity(db, 'person', 'Dave', 'same profile');
  db.prepare(`UPDATE entities SET profile_generated_at = '2020-01-01 00:00:00' WHERE id = ?`).run(
    ent.id,
  );
  // Upserting the same profile should NOT trigger an update (existing code guard).
  upsertEntity(db, 'person', 'Dave', 'same profile');
  const row = db.prepare('SELECT profile_generated_at FROM entities WHERE id = ?').get(ent.id) as {
    profile_generated_at: string | null;
  };
  assert.equal(
    row.profile_generated_at,
    '2020-01-01 00:00:00',
    'profile_generated_at should be unchanged when profile unchanged',
  );
  closeDb(db);
});
