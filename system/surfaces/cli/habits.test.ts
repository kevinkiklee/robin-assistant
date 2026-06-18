import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { insertHabit, setHabitStatus } from '../../brain/cognition/behavior/habits-store.ts';
import { closeDb, openDb, type RobinDb } from '../../brain/memory/db.ts';
import { allMigrations, applyMigrations } from '../../brain/memory/migrations/index.ts';
import { habitsText, selectHabits } from './habits.ts';

function freshDb(): RobinDb {
  const dir = mkdtempSync(join(tmpdir(), 'robin-cli-habits-'));
  mkdirSync(join(dir, 'state', 'db'), { recursive: true });
  const db = openDb(join(dir, 'state', 'db', 'robin.sqlite'));
  applyMigrations(db, allMigrations);
  return db;
}

test('habitsText renders a summary header and one line per habit, confidence desc', () => {
  const db = freshDb();
  insertHabit(db, {
    statement: 'tends to buy camera gear before a planned trip',
    domain: 'finance',
    patternKind: 'purchase',
    confidence: 0.42,
    supportCount: 3,
    supportStreams: 2,
  });
  insertHabit(db, {
    statement: 'shoots black-and-white on weekend walks',
    domain: 'creative',
    patternKind: 'workflow',
    confidence: 0.71,
    supportCount: 5,
    supportStreams: 3,
  });

  const text = habitsText(db);

  // Summary header with counts by status
  assert.ok(text.includes('Inferred habits (2: 2 soft)'), `missing summary header: ${text}`);
  // Both statements rendered
  assert.ok(text.includes('tends to buy camera gear before a planned trip'));
  assert.ok(text.includes('shoots black-and-white on weekend walks'));
  // Support count/streams + domain/patternKind shown
  assert.ok(text.includes('support=5/3str'), `missing support col: ${text}`);
  assert.ok(text.includes('[creative/workflow]'), `missing domain/kind: ${text}`);
  assert.ok(text.includes('conf=0.71'));

  // Sorted by confidence desc → 0.71 line before 0.42 line
  const idxHigh = text.indexOf('conf=0.71');
  const idxLow = text.indexOf('conf=0.42');
  assert.ok(idxHigh < idxLow, 'expected higher-confidence habit first');

  closeDb(db);
});

test('default view excludes retired; --all and --status include it', () => {
  const db = freshDb();
  insertHabit(db, {
    statement: 'soft habit kept',
    domain: 'creative',
    patternKind: 'workflow',
    confidence: 0.3,
  });
  const { id: graduatedId } = insertHabit(db, {
    statement: 'graduated habit kept',
    domain: 'creative',
    patternKind: 'preference',
    confidence: 0.5,
  });
  setHabitStatus(db, graduatedId, 'graduated');
  const { id: retiredId } = insertHabit(db, {
    statement: 'retired habit hidden',
    domain: 'creative',
    patternKind: 'consumption',
    confidence: 0.9,
  });
  setHabitStatus(db, retiredId, 'retired');

  // Default: soft + graduated only
  const dflt = habitsText(db);
  assert.ok(dflt.includes('soft habit kept'));
  assert.ok(dflt.includes('graduated habit kept'));
  assert.ok(!dflt.includes('retired habit hidden'), 'retired leaked into default view');
  assert.ok(dflt.includes('2 soft') || dflt.includes('1 soft, 1 graduated'));

  // --all includes retired
  const all = habitsText(db, { all: true });
  assert.ok(all.includes('retired habit hidden'), 'retired missing from --all');

  // --status=retired pins to retired only
  const retiredOnly = selectHabits(db, { status: 'retired' });
  assert.equal(retiredOnly.length, 1);
  assert.equal(retiredOnly[0].statement, 'retired habit hidden');

  closeDb(db);
});

test('empty store prints the friendly weekly-synthesis message without throwing', () => {
  const db = freshDb();
  const text = habitsText(db);
  assert.equal(text, 'No habits inferred yet — the weekly synthesis runs Sunday 5am.');
  closeDb(db);
});
