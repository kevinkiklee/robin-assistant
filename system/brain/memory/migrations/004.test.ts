import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openDb, closeDb } from '../db.ts';
import { allMigrations, applyMigrations } from './index.ts';

test('schema 004: lifecycle tables exist', () => {
  const dir = mkdtempSync(join(tmpdir(), 'robin-mig4-'));
  mkdirSync(join(dir, 'state', 'db'), { recursive: true });
  const db = openDb(join(dir, 'state', 'db', 'robin.sqlite'));
  applyMigrations(db, allMigrations);
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as Array<{ name: string }>;
  const names = tables.map((t) => t.name);
  for (const expected of ['predictions', 'corrections', 'refusals', 'audit_meta', 'metrics_daily', 'journals']) {
    assert.ok(names.includes(expected), `${expected} missing`);
  }
  closeDb(db);
});
