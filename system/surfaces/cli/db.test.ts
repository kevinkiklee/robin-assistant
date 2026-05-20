import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { closeDb, openDb } from '../../brain/memory/db.ts';
import { allMigrations, applyMigrations } from '../../brain/memory/migrations/index.ts';
import { dbFilePath } from '../../lib/paths.ts';
import { runDbBackup, runDbVacuum } from './db.ts';

function freshUserData(): string {
  const dir = mkdtempSync(join(tmpdir(), 'robin-db-cli-'));
  mkdirSync(join(dir, 'state', 'db'), { recursive: true });
  const db = openDb(dbFilePath(dir));
  applyMigrations(db, allMigrations);
  // Insert a couple rows so vacuum has data to compact
  db.prepare(`INSERT INTO events (ts, kind, source, status, payload) VALUES (?, ?, ?, ?, ?)`).run(
    new Date().toISOString(),
    'test',
    't',
    'ok',
    '{}',
  );
  closeDb(db);
  return dir;
}

test('db backup: writes a copy to <db>.bak-<ts>', () => {
  const dir = freshUserData();
  process.env.ROBIN_USER_DATA_DIR = dir;
  runDbBackup();
  const dbDir = join(dir, 'state', 'db');
  const files = readdirSync(dbDir);
  assert.ok(
    files.some((f) => f.startsWith('robin.sqlite.bak-')),
    `expected a .bak- file, got ${files.join(', ')}`,
  );
});

test('db backup: respects custom --path', () => {
  const dir = freshUserData();
  process.env.ROBIN_USER_DATA_DIR = dir;
  const custom = join(dir, 'state', 'db', 'mybackup.sqlite');
  runDbBackup({ path: custom });
  assert.ok(existsSync(custom));
});

test('db vacuum: completes without error', () => {
  const dir = freshUserData();
  process.env.ROBIN_USER_DATA_DIR = dir;
  runDbVacuum();
  // No throw is success
});
