import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { closeDb, openDb } from '../memory/db.ts';
import { addRelation, upsertEntity } from '../memory/entity.ts';
import { allMigrations, applyMigrations } from '../memory/migrations/index.ts';
import { loadNoiseBlocklist, resolveHygieneItem, runHygiene } from './hygiene.ts';

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

test('hygiene: flags profileless single-word thing with 1 relation', () => {
  const db = freshDb();
  const e1 = upsertEntity(db, 'thing', 'state');
  const e2 = upsertEntity(db, 'person', 'Kevin');
  addRelation(db, e1.id, 'uses', e2.id);
  const r = runHygiene(db);
  assert.equal(r.entitiesFlagged, 1);
  const review = db.prepare('SELECT * FROM hygiene_review WHERE entity_id = ?').get(e1.id) as
    | { reason: string; signals: number }
    | undefined;
  assert.ok(review);
  assert.ok(review.signals >= 2);
  closeDb(db);
});

test('hygiene: does NOT flag entity with score < 2', () => {
  const db = freshDb();
  const e1 = upsertEntity(db, 'person', 'Kevin');
  const e2 = upsertEntity(db, 'place', 'NYC');
  addRelation(db, e1.id, 'lives_in', e2.id);
  const r = runHygiene(db);
  assert.equal(r.entitiesFlagged, 0);
  closeDb(db);
});

test('hygiene: does not re-flag already pending items', () => {
  const db = freshDb();
  const e1 = upsertEntity(db, 'thing', 'state');
  const e2 = upsertEntity(db, 'person', 'Kevin');
  addRelation(db, e1.id, 'uses', e2.id);
  runHygiene(db);
  const r2 = runHygiene(db);
  assert.equal(r2.entitiesFlagged, 0);
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

test('hygiene: resolveHygieneItem delete removes entity and adds to blocklist', () => {
  const db = freshDb();
  const e = upsertEntity(db, 'thing', 'suspicious');
  const e2 = upsertEntity(db, 'person', 'Kevin');
  addRelation(db, e.id, 'uses', e2.id);
  db.prepare(`
    INSERT INTO hygiene_review (entity_id, entity_name, entity_type, reason, signals, flagged_at)
    VALUES (?, 'suspicious', 'thing', 'test', 2, datetime('now'))
  `).run(e.id);
  const reviewId = (
    db.prepare('SELECT id FROM hygiene_review WHERE entity_id = ?').get(e.id) as { id: number }
  ).id;
  resolveHygieneItem(db, reviewId, 'delete');
  const ent = db.prepare('SELECT id FROM entities WHERE id = ?').get(e.id);
  assert.equal(ent, undefined);
  const bl = loadNoiseBlocklist(db);
  assert.ok(bl.has('suspicious'));
  const review = db.prepare('SELECT resolution FROM hygiene_review WHERE id = ?').get(reviewId) as {
    resolution: string;
  };
  assert.equal(review.resolution, 'delete');
  closeDb(db);
});

test('hygiene: resolveHygieneItem keep marks resolved but does NOT blocklist', () => {
  const db = freshDb();
  const e = upsertEntity(db, 'thing', 'legitimate');
  const e2 = upsertEntity(db, 'person', 'Kevin');
  addRelation(db, e.id, 'uses', e2.id);
  db.prepare(`
    INSERT INTO hygiene_review (entity_id, entity_name, entity_type, reason, signals, flagged_at)
    VALUES (?, 'legitimate', 'thing', 'test', 2, datetime('now'))
  `).run(e.id);
  const reviewId = (
    db.prepare('SELECT id FROM hygiene_review WHERE entity_id = ?').get(e.id) as { id: number }
  ).id;
  resolveHygieneItem(db, reviewId, 'keep');
  const ent = db.prepare('SELECT id FROM entities WHERE id = ?').get(e.id);
  assert.ok(ent);
  const bl = loadNoiseBlocklist(db);
  assert.ok(!bl.has('legitimate'));
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
