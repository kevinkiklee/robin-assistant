import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { closeDb, openDb, type RobinDb } from '../../memory/db.ts';
import { allMigrations, applyMigrations } from '../../memory/migrations/index.ts';
import {
  findNearestHabitByEmbedding,
  getHabit,
  insertHabit,
  listHabits,
  listRetiredEmbeddings,
  recomputeConfidenceFor,
  setHabitStatus,
  updateHabitReinforcement,
} from './habits-store.ts';

function freshDb(): RobinDb {
  const dir = mkdtempSync(join(tmpdir(), 'robin-habits-'));
  mkdirSync(join(dir, 'state', 'db'), { recursive: true });
  const db = openDb(join(dir, 'state', 'db', 'robin.sqlite'));
  applyMigrations(db, allMigrations);
  return db;
}

test('insert + get round-trips all fields', () => {
  const db = freshDb();
  const { id } = insertHabit(db, {
    statement: 'tends to buy camera gear before a planned trip',
    domain: 'finance',
    patternKind: 'purchase',
    confidence: 0.42,
    supportCount: 3,
    supportStreams: 2,
    contradictionCount: 1,
    evidenceEventIds: [10, 20, 30],
    evidenceSummary: 'TC before birding; 20mm for astro; 100-400 before Death Valley',
    embedding: [1, 0, 0],
  });
  assert.ok(id > 0);

  const h = getHabit(db, id);
  assert.ok(h);
  assert.equal(h.statement, 'tends to buy camera gear before a planned trip');
  assert.equal(h.domain, 'finance');
  assert.equal(h.patternKind, 'purchase');
  assert.equal(h.confidence, 0.42);
  assert.equal(h.supportCount, 3);
  assert.equal(h.supportStreams, 2);
  assert.equal(h.contradictionCount, 1);
  assert.deepEqual(h.evidenceEventIds, [10, 20, 30]);
  assert.equal(h.status, 'soft'); // default
  assert.equal(h.graduatedBeliefId, null);
  assert.ok(h.embedding instanceof Float32Array);
  assert.equal(h.embedding?.length, 3);
  assert.ok(h.firstSeen && h.lastSeen && h.lastReinforced);
  closeDb(db);
});

test('insert requires a statement', () => {
  const db = freshDb();
  assert.throws(
    () => insertHabit(db, { statement: '  ', domain: 'finance', patternKind: 'purchase' }),
    /statement required/,
  );
  closeDb(db);
});

test('listHabits filters by status', () => {
  const db = freshDb();
  const a = insertHabit(db, { statement: 'soft one', domain: 'creative', patternKind: 'temporal' });
  const b = insertHabit(db, {
    statement: 'soft two',
    domain: 'health',
    patternKind: 'consumption',
  });
  insertHabit(db, {
    statement: 'retired one',
    domain: 'finance',
    patternKind: 'purchase',
    status: 'retired',
  });

  const soft = listHabits(db, 'soft');
  assert.equal(soft.length, 2);
  const softIds = soft.map((h) => h.id).sort((x, y) => x - y);
  assert.deepEqual(
    softIds,
    [a.id, b.id].sort((x, y) => x - y),
  );

  const retired = listHabits(db, 'retired');
  assert.equal(retired.length, 1);

  assert.equal(listHabits(db).length, 3); // no filter → all
  closeDb(db);
});

test('updateHabitReinforcement bumps support_count + last_reinforced + evidence ids', () => {
  const db = freshDb();
  const { id } = insertHabit(db, {
    statement: 'shoots most at golden hour',
    domain: 'creative',
    patternKind: 'temporal',
    supportCount: 2,
    supportStreams: 1,
    evidenceEventIds: [5],
    lastReinforced: '2026-01-01 00:00:00',
  });

  updateHabitReinforcement(db, id, {
    addEventId: 99,
    supportStreams: 2,
    at: '2026-06-17 00:00:00',
  });

  const h = getHabit(db, id);
  assert.ok(h);
  assert.equal(h.supportCount, 3, 'support_count bumped by 1');
  assert.equal(h.supportStreams, 2, 'support_streams updated');
  assert.deepEqual(h.evidenceEventIds, [5, 99], 'event id appended');
  assert.equal(h.lastReinforced, '2026-06-17 00:00:00', 'last_reinforced refreshed');

  // Re-adding the same event id does not duplicate it.
  updateHabitReinforcement(db, id, { addEventId: 99 });
  assert.deepEqual(getHabit(db, id)?.evidenceEventIds, [5, 99]);
  closeDb(db);
});

test('updateHabitReinforcement throws on a missing habit', () => {
  const db = freshDb();
  assert.throws(() => updateHabitReinforcement(db, 12345), /not found/);
  closeDb(db);
});

test('setHabitStatus moves soft → graduated and wires graduated_belief_id', () => {
  const db = freshDb();
  const { id } = insertHabit(db, {
    statement: 'prefers prime lenses',
    domain: 'preferences',
    patternKind: 'preference',
  });
  // graduated_belief_id is a real FK → belief_candidates(id) (foreign_keys = ON),
  // so seed an actual candidate to point at.
  const beliefId = Number(
    db
      .prepare(`INSERT INTO belief_candidates (topic, claim) VALUES ('lenses', 'prefers primes')`)
      .run().lastInsertRowid,
  );

  setHabitStatus(db, id, 'graduated', beliefId);
  let h = getHabit(db, id);
  assert.equal(h?.status, 'graduated');
  assert.equal(h?.graduatedBeliefId, beliefId);

  // Status-only change leaves graduated_belief_id untouched.
  setHabitStatus(db, id, 'retired');
  h = getHabit(db, id);
  assert.equal(h?.status, 'retired');
  assert.equal(h?.graduatedBeliefId, beliefId);
  closeDb(db);
});

test('recomputeConfidenceFor writes a clamped confidence', () => {
  const db = freshDb();
  const { id } = insertHabit(db, { statement: 's', domain: 'home', patternKind: 'workflow' });
  recomputeConfidenceFor(db, id, 0.73);
  assert.equal(getHabit(db, id)?.confidence, 0.73);
  recomputeConfidenceFor(db, id, 5); // clamps to 1
  assert.equal(getHabit(db, id)?.confidence, 1);
  recomputeConfidenceFor(db, id, -2); // clamps to 0
  assert.equal(getHabit(db, id)?.confidence, 0);
  closeDb(db);
});

test('findNearestHabitByEmbedding returns the best match above threshold', () => {
  const db = freshDb();
  insertHabit(db, {
    statement: 'gear before trips',
    domain: 'finance',
    patternKind: 'purchase',
    embedding: [1, 0, 0],
  });
  const close = insertHabit(db, {
    statement: 'buys gear ahead of travel',
    domain: 'finance',
    patternKind: 'purchase',
    embedding: [0.99, 0.01, 0],
  });

  const hit = findNearestHabitByEmbedding(db, [1, 0, 0], { threshold: 0.9 });
  assert.ok(hit);
  // [1,0,0] is colinear with both; the [1,0,0] row is cosine 1 (best).
  assert.ok(hit.similarity >= 0.9);

  // Orthogonal query → no match.
  const miss = findNearestHabitByEmbedding(db, [0, 1, 0], { threshold: 0.9 });
  assert.equal(miss, null);

  // Status filter excludes non-matching statuses.
  setHabitStatus(db, close.id, 'retired');
  const softOnly = findNearestHabitByEmbedding(db, [0.99, 0.01, 0], {
    threshold: 0.9,
    statuses: ['soft'],
  });
  assert.ok(softOnly);
  assert.notEqual(softOnly.habit.id, close.id, 'retired row excluded by status filter');
  closeDb(db);
});

test('listRetiredEmbeddings returns only retired rows with embeddings', () => {
  const db = freshDb();
  insertHabit(db, {
    statement: 'soft with embed',
    domain: 'creative',
    patternKind: 'temporal',
    embedding: [1, 0],
  });
  const r1 = insertHabit(db, {
    statement: 'retired with embed',
    domain: 'finance',
    patternKind: 'purchase',
    embedding: [0, 1],
    status: 'retired',
  });
  insertHabit(db, {
    statement: 'retired no embed',
    domain: 'health',
    patternKind: 'consumption',
    status: 'retired',
  });

  const retired = listRetiredEmbeddings(db);
  assert.equal(retired.length, 1, 'only the retired row WITH an embedding');
  assert.equal(retired[0].id, r1.id);
  assert.ok(retired[0].embedding instanceof Float32Array);
  closeDb(db);
});
