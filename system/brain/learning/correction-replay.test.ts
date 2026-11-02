import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { closeDb, openDb } from '../memory/db.ts';
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
  ins.run('Sam lives in Oregon', 'Sam lives in Washington', 'about Sam');
  ins.run('widget-kit is Vue', 'widget-kit is Svelte', 'about widget-kit');
  const recent = relevantCorrections(db, { limit: 5 });
  assert.equal(recent.length, 2);
  closeDb(db);
});

test('correction-replay: topic filter narrows results', () => {
  const db = freshDb();
  const ins = db.prepare(`INSERT INTO corrections (what, correction, context) VALUES (?, ?, ?)`);
  ins.run('Sam lives in Oregon', 'Sam lives in Washington', 'about Sam');
  ins.run('widget-kit is Vue', 'widget-kit is Svelte', 'about widget-kit');
  const r = relevantCorrections(db, { topic: 'Sam' });
  assert.equal(r.length, 1);
  assert.match(r[0].what, /Sam/);
  closeDb(db);
});
