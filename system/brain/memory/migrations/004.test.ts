import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { closeDb, openDb } from '../db.ts';
import { allMigrations, applyMigrations } from './index.ts';

test('schema 004: lifecycle tables exist', () => {
  const dir = mkdtempSync(join(tmpdir(), 'robin-mig4-'));
  mkdirSync(join(dir, 'state', 'db'), { recursive: true });
  const db = openDb(join(dir, 'state', 'db', 'robin.sqlite'));
  applyMigrations(db, allMigrations);
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
    .all() as Array<{ name: string }>;
  const names = tables.map((t) => t.name);
  for (const expected of [
    'predictions',
    'corrections',
    'refusals',
    'audit_meta',
    'metrics_daily',
    'journals',
  ]) {
    assert.ok(names.includes(expected), `${expected} missing`);
  }
  closeDb(db);
});
