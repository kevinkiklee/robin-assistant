import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { closeDb, openDb } from '../memory/db.ts';
import { addRelation, upsertEntity } from '../memory/entity.ts';
import { allMigrations, applyMigrations } from '../memory/migrations/index.ts';
import { loadNoiseBlocklist, runHygiene } from './hygiene.ts';

function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), 'hygiene-test-'));
  const db = openDb(join(dir, 'test.db'));
  applyMigrations(db, allMigrations);
  return db;
}

test('hygiene: deletes MCP tool name entities', () => {
  const db = freshDb();
  const e1 = upsertEntity(db, 'thing', 'mcp__robin__recall');
  const e2 = upsertEntity(db, 'person', 'Kevin');
  addRelation(db, e1.id, 'uses', e2.id);
  const r = runHygiene(db);
  assert.equal(r.entitiesDeleted, 1);
  assert.equal(r.blocklistGrown, 1);
  const remaining = db.prepare('SELECT canonical_name FROM entities').all() as Array<{
    canonical_name: string;
  }>;
  assert.ok(remaining.some((e) => e.canonical_name === 'Kevin'));
  assert.ok(!remaining.some((e) => e.canonical_name === 'mcp__robin__recall'));
  closeDb(db);
});

test('hygiene: deletes commit message prefix entities', () => {
  const db = freshDb();
  upsertEntity(db, 'thing', 'feat(linear): wave 2');
  const keep = upsertEntity(db, 'thing', 'Nikon Zf');
  addRelation(db, keep.id, 'owns', keep.id);
  const r = runHygiene(db);
  assert.ok(r.entitiesDeleted >= 1);
  const names = (
    db.prepare('SELECT canonical_name FROM entities').all() as Array<{ canonical_name: string }>
  ).map((e) => e.canonical_name);
  assert.ok(!names.includes('feat(linear): wave 2'));
  closeDb(db);
});

test('hygiene: deletes Phase/Track codenames', () => {
  const db = freshDb();
  upsertEntity(db, 'thing', 'Phase 4a edge');
  upsertEntity(db, 'topic', 'Track B Phase 1');
  const r = runHygiene(db);
  assert.ok(r.entitiesDeleted >= 2);
  closeDb(db);
});

test('hygiene: deletes env var entities', () => {
  const db = freshDb();
  upsertEntity(db, 'thing', 'ANTHROPIC_API_KEY');
  const r = runHygiene(db);
  assert.ok(r.entitiesDeleted >= 1);
  closeDb(db);
});

test('hygiene: deletes camelCase code identifiers', () => {
  const db = freshDb();
  upsertEntity(db, 'thing', 'fetchHistory');
  upsertEntity(db, 'topic', 'sessionIds');
  const r = runHygiene(db);
  assert.ok(r.entitiesDeleted >= 2);
  closeDb(db);
});

test('hygiene: deletes bare domain names captured as thing/topic', () => {
  const db = freshDb();
  upsertEntity(db, 'thing', 'leadhearth.com');
  upsertEntity(db, 'topic', 'sub.example.io');
  // A real project typed as service must NOT be touched even if it looks domain-y.
  const keep = upsertEntity(db, 'service', 'askrobin.io');
  addRelation(db, keep.id, 'owns', keep.id);
  const r = runHygiene(db);
  assert.ok(r.entitiesDeleted >= 2);
  const names = (
    db.prepare('SELECT canonical_name FROM entities').all() as Array<{ canonical_name: string }>
  ).map((e) => e.canonical_name);
  assert.ok(!names.includes('leadhearth.com'));
  assert.ok(!names.includes('sub.example.io'));
  assert.ok(names.includes('askrobin.io'), 'typed service domain is preserved');
  closeDb(db);
});

test('hygiene: deletes sentence-length thing/topic', () => {
  const db = freshDb();
  upsertEntity(db, 'thing', 'Implementer subagent fixes quality issues and merges code');
  const r = runHygiene(db);
  assert.ok(r.entitiesDeleted >= 1);
  closeDb(db);
});

test('hygiene: does NOT delete Tier 1 matches on non-noise types (person, place)', () => {
  const db = freshDb();
  const e1 = upsertEntity(db, 'person', 'Kevin');
  const e2 = upsertEntity(db, 'place', 'Astoria');
  addRelation(db, e1.id, 'lives_in', e2.id);
  const r = runHygiene(db);
  assert.equal(r.entitiesDeleted, 0);
  closeDb(db);
});

test('hygiene: deletes occurs_with relations', () => {
  const db = freshDb();
  const e1 = upsertEntity(db, 'person', 'Kevin');
  const e2 = upsertEntity(db, 'service', 'Vercel');
  addRelation(db, e1.id, 'occurs_with', e2.id);
  addRelation(db, e1.id, 'uses', e2.id);
  const r = runHygiene(db);
  assert.equal(r.relationsDeleted, 1);
  assert.equal(r.entitiesDeleted, 0);
  closeDb(db);
});

test('hygiene: Tier 2 auto-culls profileless single-word thing (no human review)', () => {
  const db = freshDb();
  const e1 = upsertEntity(db, 'thing', 'state');
  const e2 = upsertEntity(db, 'person', 'Kevin');
  addRelation(db, e1.id, 'uses', e2.id);
  const r = runHygiene(db);
  // Auto-culled inline — no flag, no review.
  assert.equal(r.entitiesAutoCulled, 1);
  const ent = db.prepare('SELECT id FROM entities WHERE id = ?').get(e1.id);
  assert.equal(ent, undefined, 'noise entity deleted');
  // Crucially: score-based culls do NOT add to blocklist (allow re-extraction with context).
  const bl = loadNoiseBlocklist(db);
  assert.ok(!bl.has('state'), 'Tier 2 auto-cull does not blocklist');
  closeDb(db);
});

test('hygiene: Tier 2 does NOT auto-cull entity with score < 2 (e.g. person + place)', () => {
  const db = freshDb();
  const e1 = upsertEntity(db, 'person', 'Kevin');
  const e2 = upsertEntity(db, 'place', 'NYC');
  addRelation(db, e1.id, 'lives_in', e2.id);
  const r = runHygiene(db);
  assert.equal(r.entitiesAutoCulled, 0);
  closeDb(db);
});

test('hygiene: blocklist grows when Tier 1 entities are deleted', () => {
  const db = freshDb();
  upsertEntity(db, 'thing', 'SENTRY_AUTH_TOKEN');
  const r = runHygiene(db);
  assert.ok(r.blocklistGrown >= 1);
  const bl = loadNoiseBlocklist(db);
  assert.ok(bl.has('sentry_auth_token'));
  closeDb(db);
});

test('hygiene: retroactive blocklist sweep deletes pre-existing entities', () => {
  const db = freshDb();
  const e = upsertEntity(db, 'thing', 'Dream DAG');
  const e2 = upsertEntity(db, 'person', 'Kevin');
  addRelation(db, e.id, 'uses', e2.id);
  db.prepare(
    "INSERT INTO noise_blocklist (name, reason, source, added_at) VALUES ('Dream DAG', 'manual', 'hygiene', datetime('now'))",
  ).run();
  const r = runHygiene(db);
  assert.ok(r.entitiesDeleted >= 1);
  const names = (
    db.prepare('SELECT canonical_name FROM entities').all() as Array<{ canonical_name: string }>
  ).map((e) => e.canonical_name);
  assert.ok(!names.includes('Dream DAG'));
  closeDb(db);
});

test('hygiene: orphan sweep deletes entities with zero relations', () => {
  const db = freshDb();
  upsertEntity(db, 'person', 'Orphan Entity');
  const r = runHygiene(db);
  assert.ok(r.orphansDeleted >= 1);
  closeDb(db);
});

test('hygiene: logs a hygiene.run event', () => {
  const db = freshDb();
  runHygiene(db);
  const evt = db.prepare("SELECT * FROM events WHERE kind = 'hygiene.run'").get() as
    | { payload: string }
    | undefined;
  assert.ok(evt);
  const payload = JSON.parse(evt.payload);
  assert.ok('entitiesDeleted' in payload);
  assert.ok('relationsDeleted' in payload);
  closeDb(db);
});
