import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { closeDb, openDb } from './db.ts';

function makeTempDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'robin-db-'));
  mkdirSync(join(dir, 'state', 'db'), { recursive: true });
  return join(dir, 'state', 'db', 'robin.sqlite');
}

test('db: opens connection and loads sqlite-vec', () => {
  const path = makeTempDbPath();
  const db = openDb(path);
  const row = db.prepare('SELECT vec_version() AS version').get() as { version: string };
  assert.ok(row.version, 'vec_version should return non-empty version');
  closeDb(db);
});

test('db: WAL mode is enabled', () => {
  const path = makeTempDbPath();
  const db = openDb(path);
  const row = db.prepare('PRAGMA journal_mode').get() as { journal_mode: string };
  assert.equal(row.journal_mode, 'wal');
  closeDb(db);
});

test('db: WAL file is truncated back to a bounded size after checkpoints', () => {
  const path = makeTempDbPath();
  const db = openDb(path);
  const row = db.prepare('PRAGMA journal_size_limit').get() as { journal_size_limit: number };
  assert.equal(row.journal_size_limit, 64 * 1024 * 1024);
  closeDb(db);
});

test('db: foreign keys are enabled', () => {
  const path = makeTempDbPath();
  const db = openDb(path);
  const row = db.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number };
  assert.equal(row.foreign_keys, 1);
  closeDb(db);
});
