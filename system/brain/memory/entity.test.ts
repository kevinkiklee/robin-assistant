import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { closeDb, openDb } from './db.ts';
import {
  addRelation,
  type EntityRow,
  findEntity,
  getEntity,
  normalizeEntityType,
  relatedEntities,
  upsertEntity,
  withFreshProfile,
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

test('entity: upsert collapses a registered name-variant alias to the canonical entity', () => {
  const db = freshDb();
  const canonical = upsertEntity(db, 'person', 'Kevin Lee');
  db.prepare(
    `INSERT INTO entity_aliases (alias, canonical_name, canonical_type, source) VALUES (?, ?, ?, 'manual')`,
  ).run('kevin k lee', 'Kevin Lee', 'person');

  // A later extraction of the middle-initial variant must resolve to the SAME
  // entity (case-insensitive dedup alone would create a new row for it).
  const variant = upsertEntity(db, 'person', 'Kevin K Lee');
  assert.equal(variant.id, canonical.id, 'variant must resolve to the canonical entity');
  assert.equal(variant.canonical_name, 'Kevin Lee');
  const n = (
    db
      .prepare("SELECT count(*) AS n FROM entities WHERE lower(canonical_name) LIKE 'kevin%'")
      .get() as {
      n: number;
    }
  ).n;
  assert.equal(n, 1, 'no duplicate entity created for the alias');
  closeDb(db);
});

test('entity: an alias forces the canonical type even when extracted under a noise type', () => {
  const db = freshDb();
  const canonical = upsertEntity(db, 'person', 'Kevin Lee');
  db.prepare(
    `INSERT INTO entity_aliases (alias, canonical_name, canonical_type, source) VALUES (?, ?, ?, 'manual')`,
  ).run('kevin', 'Kevin Lee', 'person');

  // The bare name extracted as a `thing` must collapse into the real person.
  const asThing = upsertEntity(db, 'thing', 'Kevin');
  assert.equal(asThing.id, canonical.id);
  assert.equal(asThing.type, 'person', 'alias canonical_type overrides the extracted type');
  closeDb(db);
});

test('entity: an unregistered name is unaffected by the alias map', () => {
  const db = freshDb();
  const a = upsertEntity(db, 'person', 'Sarah Chen');
  const b = upsertEntity(db, 'person', 'Sarah Chen');
  assert.equal(a.id, b.id);
  assert.equal(a.canonical_name, 'Sarah Chen');
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

// ── withFreshProfile (Task 10) ────────────────────────────────────────────────

test('withFreshProfile passes fresh profiles through untouched', () => {
  const db = freshDb();
  const ent = upsertEntity(db, 'person', 'Eve', 'Eve is a designer');
  // profile_generated_at was just set by upsertEntity — clearly fresh
  const row = db.prepare('SELECT * FROM entities WHERE id = ?').get(ent.id) as EntityRow;
  const result = withFreshProfile(db, row);
  assert.equal(result.profile, 'Eve is a designer');
  assert.ok(!('profile_stale' in result) || result.profile_stale !== true);
  closeDb(db);
});

test('withFreshProfile replaces a >30-day profile with a deterministic relation summary', () => {
  const db = freshDb();
  const eve = upsertEntity(db, 'person', 'Eve', 'Eve is a designer');
  const acme = upsertEntity(db, 'company', 'Acme Corp');
  const sf = upsertEntity(db, 'place', 'San Francisco');
  const robin = upsertEntity(db, 'project', 'Robin');
  // Backdate profile_generated_at to 40 days ago
  db.prepare(
    `UPDATE entities SET profile_generated_at = datetime('now', '-40 days') WHERE id = ?`,
  ).run(eve.id);
  // Add relations
  db.prepare(
    `INSERT INTO relations (subject_id, predicate, object_id, ts) VALUES (?, ?, ?, datetime('now'))`,
  ).run(eve.id, 'works_at', acme.id);
  db.prepare(
    `INSERT INTO relations (subject_id, predicate, object_id, ts) VALUES (?, ?, ?, datetime('now'))`,
  ).run(eve.id, 'lives_in', sf.id);
  db.prepare(
    `INSERT INTO relations (subject_id, predicate, object_id, ts) VALUES (?, ?, ?, datetime('now'))`,
  ).run(robin.id, 'created_by', eve.id);

  const row = db.prepare('SELECT * FROM entities WHERE id = ?').get(eve.id) as EntityRow;
  const result = withFreshProfile(db, row);

  assert.equal(result.profile_stale, true, 'profile_stale should be true for 40-day-old profile');
  assert.ok(result.profile !== null, 'profile should be non-null when relations exist');
  assert.ok(
    typeof result.profile === 'string' && result.profile.startsWith('recent relations:'),
    `profile should be a relation summary, got: ${result.profile}`,
  );
  // Verify specific relations appear
  assert.ok(result.profile!.includes('works_at'), `expected 'works_at' in: ${result.profile}`);
  closeDb(db);
});

test('withFreshProfile on a stale profile with no relations nulls the profile', () => {
  const db = freshDb();
  const frank = upsertEntity(db, 'person', 'Frank', 'Frank is an engineer');
  // Backdate to 40 days ago, no relations
  db.prepare(
    `UPDATE entities SET profile_generated_at = datetime('now', '-40 days') WHERE id = ?`,
  ).run(frank.id);

  const row = db.prepare('SELECT * FROM entities WHERE id = ?').get(frank.id) as EntityRow;
  const result = withFreshProfile(db, row);

  assert.equal(result.profile_stale, true);
  assert.equal(result.profile, null, 'profile should be null when no relations exist');
  closeDb(db);
});

test('NULL profile_generated_at with a non-null profile is treated as stale (pre-migration writers)', () => {
  const db = freshDb();
  // Simulate a pre-migration row: profile set, profile_generated_at is NULL
  const grace = upsertEntity(db, 'person', 'Grace', 'Grace is an architect');
  db.prepare(`UPDATE entities SET profile_generated_at = NULL WHERE id = ?`).run(grace.id);

  const row = db.prepare('SELECT * FROM entities WHERE id = ?').get(grace.id) as EntityRow;
  assert.equal(row.profile_generated_at, null, 'precondition: profile_generated_at is NULL');
  assert.ok(row.profile !== null, 'precondition: profile is non-null');

  const result = withFreshProfile(db, row);
  assert.equal(result.profile_stale, true, 'NULL profile_generated_at should be treated as stale');
  closeDb(db);
});
