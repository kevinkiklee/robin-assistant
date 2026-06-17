import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { closeDb, openDb, type RobinDb } from '../../memory/db.ts';
import { allMigrations, applyMigrations } from '../../memory/migrations/index.ts';
import { getReinforceCursor, setReinforceCursor } from './cursor.ts';
import { getHabit, insertHabit, listHabits } from './habits-store.ts';
import { runBehaviorReinforce } from './tier-a.ts';

function freshDb(): RobinDb {
  const dir = mkdtempSync(join(tmpdir(), 'robin-tier-a-'));
  mkdirSync(join(dir, 'state', 'db'), { recursive: true });
  const db = openDb(join(dir, 'state', 'db', 'robin.sqlite'));
  applyMigrations(db, allMigrations);
  return db;
}

/** Insert a raw lunch_money.transaction event (an allowlisted behavioral signal). */
function insertPurchaseEvent(db: RobinDb, merchant: string, ts = '2026-06-17 12:00:00'): number {
  const info = db
    .prepare(
      `INSERT INTO events (ts, kind, source, actor, status, payload)
       VALUES (?, 'lunch_money.transaction', 'lunch_money', 'user', 'ok', ?)`,
    )
    .run(ts, JSON.stringify({ merchant }));
  return Number(info.lastInsertRowid);
}

test('disabled → skip, no state change', async () => {
  const db = freshDb();
  const { id } = insertHabit(db, {
    statement: 'prefers the Voigt 35 for street',
    domain: 'creative',
    patternKind: 'preference',
    confidence: 0.5,
    supportCount: 2,
    supportStreams: 2,
  });
  insertPurchaseEvent(db, 'Voigt 35');

  const result = await runBehaviorReinforce(db, { enabled: false });
  assert.equal(result.skipped, true);
  assert.deepEqual(
    [result.confidenceRecomputed, result.retired, result.reinforced, result.staged, result.cursor],
    [0, 0, 0, 0, 0],
  );
  // Untouched: confidence, support, and cursor all unchanged.
  const h = getHabit(db, id);
  assert.equal(h?.confidence, 0.5);
  assert.equal(h?.supportCount, 2);
  assert.equal(getReinforceCursor(db), 0);
  closeDb(db);
});

test('recomputes confidence over soft + graduated, not retired', async () => {
  const db = freshDb();
  // Soft, fresh, well-supported → high confidence.
  const soft = insertHabit(db, {
    statement: 'shoots most at golden hour',
    domain: 'creative',
    patternKind: 'temporal',
    confidence: 0,
    supportCount: 4,
    supportStreams: 2,
    lastReinforced: '2026-06-17 00:00:00',
  });
  // Graduated, fresh → also recomputed.
  const grad = insertHabit(db, {
    statement: 'prefers prime lenses',
    domain: 'preferences',
    patternKind: 'preference',
    confidence: 0,
    supportCount: 5,
    supportStreams: 2,
    lastReinforced: '2026-06-17 00:00:00',
    status: 'graduated',
  });
  // Retired → must NOT be recomputed (left exactly as seeded).
  const retired = insertHabit(db, {
    statement: 'old retired pattern',
    domain: 'home',
    patternKind: 'workflow',
    confidence: 0.99,
    supportCount: 1,
    supportStreams: 1,
    status: 'retired',
  });

  const now = new Date('2026-06-17T12:00:00Z');
  const result = await runBehaviorReinforce(db, { now });
  assert.equal(result.skipped, false);
  assert.equal(result.confidenceRecomputed, 2, 'only soft + graduated recomputed');

  assert.ok((getHabit(db, soft.id)?.confidence ?? 0) > 0.5, 'fresh soft habit got a real score');
  assert.ok((getHabit(db, grad.id)?.confidence ?? 0) > 0.5, 'fresh graduated habit got a score');
  assert.equal(getHabit(db, retired.id)?.confidence, 0.99, 'retired habit left untouched');
  closeDb(db);
});

test('retires a stale low-confidence habit (both floors)', async () => {
  const db = freshDb();
  // Stale (>120d) AND weak (1 support / 1 stream) → decays below the floor → retire.
  const stale = insertHabit(db, {
    statement: 'briefly tried film cameras',
    domain: 'creative',
    patternKind: 'consumption',
    supportCount: 1,
    supportStreams: 1,
    lastReinforced: '2026-01-01 00:00:00', // ~167 days before `now`
  });
  // Stale but strong → low-confidence floor NOT crossed → kept.
  const strong = insertHabit(db, {
    statement: 'long-standing golden-hour habit',
    domain: 'creative',
    patternKind: 'temporal',
    supportCount: 8,
    supportStreams: 2,
    lastReinforced: '2026-03-01 00:00:00', // ~108 days — also below the staleness window
  });
  // Recently reinforced & weak → staleness window NOT crossed → kept.
  const recentWeak = insertHabit(db, {
    statement: 'just-started workout cadence',
    domain: 'health',
    patternKind: 'temporal',
    supportCount: 1,
    supportStreams: 1,
    lastReinforced: '2026-06-15 00:00:00',
  });

  const now = new Date('2026-06-17T12:00:00Z');
  const result = await runBehaviorReinforce(db, { now });

  assert.equal(result.retired, 1, 'exactly the stale + weak habit retired');
  assert.equal(getHabit(db, stale.id)?.status, 'retired');
  assert.equal(getHabit(db, strong.id)?.status, 'soft', 'strong habit survives staleness');
  assert.equal(getHabit(db, recentWeak.id)?.status, 'soft', 'recent weak habit survives');
  // Retired ones drop out of the active list.
  assert.equal(listHabits(db, 'retired').length, 1);
  closeDb(db);
});

test('exact-entity signal reinforces; non-matching signal does not', async () => {
  const db = freshDb();
  const target = insertHabit(db, {
    statement: 'tends to buy the Voigt 35 lens line',
    domain: 'finance',
    patternKind: 'purchase',
    supportCount: 2,
    supportStreams: 1,
    lastReinforced: '2026-06-10 00:00:00',
  });
  const baseSupport = getHabit(db, target.id)?.supportCount ?? 0;

  // Matching entity: merchant normalizes to object "Voigt 35", a contiguous run inside
  // the statement → reinforces.
  const matchEvent = insertPurchaseEvent(db, 'Voigt 35');
  // Non-matching: "Whole Foods" appears nowhere in the statement → no reinforcement.
  insertPurchaseEvent(db, 'Whole Foods');

  const now = new Date('2026-06-17T12:00:00Z');
  const result = await runBehaviorReinforce(db, { now });

  assert.equal(result.staged, 2, 'both signals seen');
  assert.equal(result.reinforced, 1, 'only the exact-entity signal reinforced');

  const h = getHabit(db, target.id);
  assert.equal(h?.supportCount, baseSupport + 1, 'support_count bumped once');
  assert.ok(h?.evidenceEventIds.includes(matchEvent), 'matched event recorded in evidence');
  assert.equal(h?.lastReinforced, '2026-06-17 12:00:00', 'last_reinforced refreshed to now');
  closeDb(db);
});

test('a short/generic object token does NOT over-attribute', async () => {
  const db = freshDb();
  const target = insertHabit(db, {
    statement: 'tends to buy camera gear before a trip',
    domain: 'finance',
    patternKind: 'purchase',
    supportCount: 2,
    supportStreams: 2,
  });
  // "gear" is a single short generic token present in the statement — must NOT match
  // (Tier A only attributes specific named entities, never generic words).
  insertPurchaseEvent(db, 'gear');

  const now = new Date('2026-06-17T12:00:00Z');
  const result = await runBehaviorReinforce(db, { now });
  assert.equal(result.reinforced, 0, 'generic single-word object did not reinforce');
  assert.equal(getHabit(db, target.id)?.supportCount, 2, 'support_count unchanged');
  closeDb(db);
});

test('cursor advances past seen events and persists', async () => {
  const db = freshDb();
  insertHabit(db, {
    statement: 'no matching entity here',
    domain: 'finance',
    patternKind: 'purchase',
  });
  const e1 = insertPurchaseEvent(db, 'Merchant A');
  const e2 = insertPurchaseEvent(db, 'Merchant B');
  const maxId = Math.max(e1, e2);

  assert.equal(getReinforceCursor(db), 0, 'cold start');
  const now = new Date('2026-06-17T12:00:00Z');
  const result = await runBehaviorReinforce(db, { now });

  assert.equal(result.cursor, maxId, 'cursor advanced to the max event id seen');
  assert.equal(getReinforceCursor(db), maxId, 'cursor persisted');

  // A second pass starting from the persisted cursor sees no new signals.
  const again = await runBehaviorReinforce(db, { now });
  assert.equal(again.staged, 0, 'no re-scan of already-seen events');
  assert.equal(again.cursor, maxId, 'cursor holds steady');
  closeDb(db);
});

test('honors a pre-set cursor (only newer events staged)', async () => {
  const db = freshDb();
  const old = insertPurchaseEvent(db, 'Old Merchant');
  setReinforceCursor(db, old); // pretend `old` was already processed
  const fresh = insertPurchaseEvent(db, 'Fresh Merchant');

  const now = new Date('2026-06-17T12:00:00Z');
  const result = await runBehaviorReinforce(db, { now });
  assert.equal(result.staged, 1, 'only the event newer than the cursor is staged');
  assert.equal(result.cursor, fresh);
  closeDb(db);
});
