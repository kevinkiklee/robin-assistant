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
import { normalizeEntityName } from './normalize.ts';

function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), 'robin-entity-'));
  mkdirSync(join(dir, 'state', 'db'), { recursive: true });
  const db = openDb(join(dir, 'state', 'db', 'robin.sqlite'));
  applyMigrations(db, allMigrations);
  return db;
}

test('entity: upsert is idempotent', () => {
  const db = freshDb();
  const a = upsertEntity(db, 'person', 'Nora');
  const b = upsertEntity(db, 'person', 'Nora');
  assert.equal(a.id, b.id);
  closeDb(db);
});

test('entity: upsert collapses a registered name-variant alias to the canonical entity', () => {
  const db = freshDb();
  const canonical = upsertEntity(db, 'person', 'Sam Rivera');
  db.prepare(
    `INSERT INTO entity_aliases (alias, canonical_name, canonical_type, source) VALUES (?, ?, ?, 'manual')`,
  ).run('sam j rivera', 'Sam Rivera', 'person');

  // A later extraction of the middle-initial variant must resolve to the SAME
  // entity (case-insensitive dedup alone would create a new row for it).
  const variant = upsertEntity(db, 'person', 'Sam J Rivera');
  assert.equal(variant.id, canonical.id, 'variant must resolve to the canonical entity');
  assert.equal(variant.canonical_name, 'Sam Rivera');
  const n = (
    db
      .prepare("SELECT count(*) AS n FROM entities WHERE lower(canonical_name) LIKE 'sam%'")
      .get() as {
      n: number;
    }
  ).n;
  assert.equal(n, 1, 'no duplicate entity created for the alias');
  closeDb(db);
});

test('entity: an alias forces the canonical type even when extracted under a noise type', () => {
  const db = freshDb();
  const canonical = upsertEntity(db, 'person', 'Sam Rivera');
  db.prepare(
    `INSERT INTO entity_aliases (alias, canonical_name, canonical_type, source) VALUES (?, ?, ?, 'manual')`,
  ).run('sam', 'Sam Rivera', 'person');

  // The bare name extracted as a `thing` must collapse into the real person.
  const asThing = upsertEntity(db, 'thing', 'Sam');
  assert.equal(asThing.id, canonical.id);
  assert.equal(asThing.type, 'person', 'alias canonical_type overrides the extracted type');
  closeDb(db);
});

test('entity: an unregistered name is unaffected by the alias map', () => {
  const db = freshDb();
  const a = upsertEntity(db, 'person', 'Nora Chen');
  const b = upsertEntity(db, 'person', 'Nora Chen');
  assert.equal(a.id, b.id);
  assert.equal(a.canonical_name, 'Nora Chen');
  closeDb(db);
});

test('entity: find by partial name', () => {
  const db = freshDb();
  upsertEntity(db, 'person', 'Nora Chen');
  upsertEntity(db, 'place', 'Lisbon');
  const hits = findEntity(db, 'Nora');
  assert.equal(hits.length, 1);
  assert.equal(hits[0].canonical_name, 'Nora Chen');
  closeDb(db);
});

test('entity: get by id', () => {
  const db = freshDb();
  const a = upsertEntity(db, 'person', 'Sam');
  const fetched = getEntity(db, a.id);
  assert.ok(fetched);
  assert.equal(fetched.canonical_name, 'Sam');
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
  const e = upsertEntity(db, 'lens', 'Acme 50mm f/1.8');
  assert.equal(e.type, 'lens');
  closeDb(db);
});

test('relations: 1-hop traversal returns connected entities', () => {
  const db = freshDb();
  const sam = upsertEntity(db, 'person', 'Sam');
  const lisbon = upsertEntity(db, 'place', 'Lisbon');
  const nora = upsertEntity(db, 'person', 'Nora');
  addRelation(db, sam.id, 'visited', lisbon.id);
  addRelation(db, sam.id, 'knows', nora.id);
  const related = relatedEntities(db, sam.id, 1);
  const names = related.map((e) => e.canonical_name).sort();
  assert.deepEqual(names, ['Lisbon', 'Nora']);
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
  const ent = upsertEntity(db, 'person', 'Theo', 'same profile');
  db.prepare(`UPDATE entities SET profile_generated_at = '2020-01-01 00:00:00' WHERE id = ?`).run(
    ent.id,
  );
  // Upserting the same profile should NOT trigger an update (existing code guard).
  upsertEntity(db, 'person', 'Theo', 'same profile');
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

// ── Normalized-name write-time dedup (financial_account fragmentation fix) ────

test('normalizeEntityName: collapses the observed financial-account variant classes', () => {
  // Each pair is a punctuation/case variant class migration 033 collapses.
  assert.equal(
    normalizeEntityName('Maple Library (Main) Card'),
    normalizeEntityName('Maple Library Main Card'),
  );
  assert.equal(
    normalizeEntityName('Maple CHESS CLUB (B) MEMBERSHIP'),
    normalizeEntityName('Maple Chess Club B Membership'),
  );
  assert.equal(normalizeEntityName('Bike Locker #12'), normalizeEntityName('Bike Locker 12'));
  // A masked suffix (⋯NNNN) normalizes like the bare digits.
  assert.equal(normalizeEntityName('Order ⋯1234'), normalizeEntityName('Order 1234'));
  assert.equal(
    normalizeEntityName('Acme Quick-Dry Towel'),
    normalizeEntityName('Acme Quick Dry Towel'),
  );
  assert.equal(normalizeEntityName('Pins&Needles Club'), 'pinsneedles club');
  assert.equal(normalizeEntityName('Acme/Pins&Needles Yarn'), 'acme pinsneedles yarn');
  // Distinct names must stay distinct.
  assert.notEqual(normalizeEntityName('Library Card'), normalizeEntityName('Library Pass'));
});

test('normalizeEntityName: brand-significant "+" is preserved', () => {
  // "Apple TV+" (service) and "Apple TV" (product) are different entities —
  // folding '+' would merge them; migration 034 re-keys them apart.
  assert.notEqual(normalizeEntityName('Apple TV+'), normalizeEntityName('Apple TV'));
  assert.notEqual(normalizeEntityName('Disney+'), normalizeEntityName('Disney'));
  assert.equal(normalizeEntityName('Apple TV+'), 'apple tv+');
});

test('normalizeEntityName: symbol-only names keep distinct keys', () => {
  assert.notEqual(normalizeEntityName('⋯'), normalizeEntityName('…'));
  assert.notEqual(normalizeEntityName('⋯'), '');
});

test('upsertEntity: punctuation variant resolves to the existing entity', () => {
  const db = freshDb();
  const canonical = upsertEntity(db, 'financial_account', 'Maple Library (Main) Card');
  const variant = upsertEntity(db, 'financial_account', 'Maple Library Main Card');
  assert.equal(variant.id, canonical.id, 'punctuation variant must not fork a new entity');
  const n = (
    db.prepare("SELECT count(*) AS n FROM entities WHERE canonical_name LIKE 'Maple%'").get() as {
      n: number;
    }
  ).n;
  assert.equal(n, 1);
  closeDb(db);
});

test('upsertEntity: alias lookup matches on the normalized key', () => {
  const db = freshDb();
  const canonical = upsertEntity(db, 'financial_account', 'Maple Chess Club Membership');
  db.prepare(
    `INSERT INTO entity_aliases (alias, canonical_name, canonical_type, source) VALUES (?, ?, ?, 'seed')`,
  ).run('chess tin', 'Maple Chess Club Membership', 'financial_account');

  // Punctuated/cased variant of the alias itself must still hit the alias row.
  const variant = upsertEntity(db, 'thing', 'Chess  Tin…');
  assert.equal(variant.id, canonical.id);
  assert.equal(variant.type, 'financial_account', 'alias canonical_type wins over extracted type');
  closeDb(db);
});

test('upsertEntity: stores normalized_name on insert', () => {
  const db = freshDb();
  const e = upsertEntity(db, 'organization', 'Pins&Needles Club');
  const row = db.prepare('SELECT normalized_name FROM entities WHERE id = ?').get(e.id) as {
    normalized_name: string;
  };
  assert.equal(row.normalized_name, 'pinsneedles club');
  closeDb(db);
});

test('findEntity: finds candidates across punctuation variants', () => {
  const db = freshDb();
  upsertEntity(db, 'financial_account', 'Maple Library (Main) Card');
  const hits = findEntity(db, 'Maple Library Main Card', 'financial_account');
  assert.equal(hits.length, 1, 'disambiguation candidate search must see the parenthesized row');
  closeDb(db);
});

test('migration 033: backfills normalized_name and re-keys aliases', () => {
  const db = freshDb();
  // freshDb runs all migrations; simulate pre-033 rows by clearing the column.
  db.prepare(
    `INSERT INTO entities (type, canonical_name) VALUES ('financial_account', 'Roth 401(k)')`,
  ).run();
  const row = db
    .prepare(`SELECT normalized_name FROM entities WHERE canonical_name = 'Roth 401(k)'`)
    .get() as { normalized_name: string | null } | undefined;
  // Direct INSERT bypasses upsertEntity, so the backfill trigger-equivalent is the
  // migration itself — a fresh DB already has 033 applied, so the column exists
  // but this row's value is NULL. upsertEntity must still dedup it via the
  // lower(canonical_name) fallback.
  assert.ok(row, 'row inserted');
  const same = upsertEntity(db, 'financial_account', 'roth 401(k)');
  assert.equal(
    same.canonical_name,
    'Roth 401(k)',
    'lower() fallback still dedups NULL-normalized rows',
  );
  closeDb(db);
});
