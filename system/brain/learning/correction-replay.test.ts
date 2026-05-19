import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openDb, closeDb } from '../memory/db.ts';
import { allMigrations, applyMigrations } from '../memory/migrations/index.ts';
import { relevantCorrections } from './correction-replay.ts';

function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), 'robin-cr-'));
  mkdirSync(join(dir, 'state', 'db'), { recursive: true });
  const db = openDb(join(dir, 'state', 'db', 'robin.sqlite'));
  applyMigrations(db, allMigrations);
  return db;
}

test('correction-replay: returns most recent corrections', () => {
  const db = freshDb();
  const ins = db.prepare(`INSERT INTO corrections (what, correction, context) VALUES (?, ?, ?)`);
  ins.run('Kevin lives in NJ', 'Kevin lives in NY', 'about Kevin');
  ins.run('photo-tools is Vue', 'photo-tools is Next.js', 'about photo-tools');
  const recent = relevantCorrections(db, { limit: 5 });
  assert.equal(recent.length, 2);
  closeDb(db);
});

test('correction-replay: topic filter narrows results', () => {
  const db = freshDb();
  const ins = db.prepare(`INSERT INTO corrections (what, correction, context) VALUES (?, ?, ?)`);
  ins.run('Kevin lives in NJ', 'Kevin lives in NY', 'about Kevin');
  ins.run('photo-tools is Vue', 'photo-tools is Next.js', 'about photo-tools');
  const r = relevantCorrections(db, { topic: 'Kevin' });
  assert.equal(r.length, 1);
  assert.match(r[0].what, /Kevin/);
  closeDb(db);
});
