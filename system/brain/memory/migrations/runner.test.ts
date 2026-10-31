import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { closeDb, openDb } from '../db.ts';
import { applyMigrations } from './runner.ts';
import type { Migration } from './types.ts';

function makeDb() {
  const dir = mkdtempSync(join(tmpdir(), 'robin-mig-'));
  mkdirSync(join(dir, 'state', 'db'), { recursive: true });
  return openDb(join(dir, 'state', 'db', 'robin.sqlite'));
}

const migrationA: Migration = {
  version: 1,
  name: 'create-foo',
  up: (db) => db.exec('CREATE TABLE foo (id INTEGER PRIMARY KEY, val TEXT)'),
};

const migrationB: Migration = {
  version: 2,
  name: 'create-baz',
  up: (db) => db.exec('CREATE TABLE baz (id INTEGER PRIMARY KEY, data TEXT)'),
};

test('migrations: applies pending migrations in order', () => {
  const db = makeDb();
  applyMigrations(db, [migrationA, migrationB]);
  const fooExists = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='foo'")
    .all();
  const bazExists = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='baz'")
    .all();
  assert.equal(fooExists.length, 1);
  assert.equal(bazExists.length, 1);
  closeDb(db);
});

test('migrations: skips already-applied migrations', () => {
  const db = makeDb();
  applyMigrations(db, [migrationA]);
  applyMigrations(db, [migrationA, migrationB]); // re-run; only B should apply
  const applied = db.prepare('SELECT version FROM _migrations ORDER BY version').all() as Array<{
    version: number;
  }>;
  assert.deepEqual(
    applied.map((r) => r.version),
    [1, 2],
  );
  closeDb(db);
});

test('migrations: rolls back on failure', () => {
  const db = makeDb();
  const bad: Migration = { version: 99, name: 'bad', up: (d) => d.exec('NOT VALID SQL') };
  assert.throws(() => applyMigrations(db, [bad]));
  // _migrations table exists but version 99 not in it
  const rows = db.prepare('SELECT version FROM _migrations WHERE version = 99').all();
  assert.deepEqual(rows, []);
  closeDb(db);
});

test('migrations: rejects non-monotonic version', () => {
  const db = makeDb();
  applyMigrations(db, [migrationB]); // version 2 first
  assert.throws(() => applyMigrations(db, [migrationA]), /non-monotonic|already.*ahead/i);
  closeDb(db);
});
