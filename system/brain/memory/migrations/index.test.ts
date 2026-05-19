import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { closeDb, openDb } from '../db.ts';
import { allMigrations, applyMigrations } from './index.ts';

function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), 'robin-mig-'));
  mkdirSync(join(dir, 'state', 'db'), { recursive: true });
  return openDb(join(dir, 'state', 'db', 'robin.sqlite'));
}

test('schema 001: all expected tables exist after apply', () => {
  const db = freshDb();
  applyMigrations(db, allMigrations);
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
    .all() as Array<{ name: string }>;
  const names = tables.map((t) => t.name);
  for (const expected of ['events', 'events_content', 'jobs', 'integration_state', '_migrations']) {
    assert.ok(names.includes(expected), `table ${expected} missing from schema 001`);
  }
  closeDb(db);
});

test('schema 001: events table has expected columns', () => {
  const db = freshDb();
  applyMigrations(db, allMigrations);
  const cols = db.prepare('PRAGMA table_info(events)').all() as Array<{
    name: string;
    notnull: number;
  }>;
  const colNames = cols.map((c) => c.name).sort();
  assert.deepEqual(colNames, [
    'actor',
    'content_ref',
    'duration_ms',
    'id',
    'kind',
    'payload',
    'source',
    'status',
    'ts',
  ]);
  closeDb(db);
});

test('schema 001: indexes on events are created', () => {
  const db = freshDb();
  applyMigrations(db, allMigrations);
  const idx = db
    .prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='events'")
    .all() as Array<{ name: string }>;
  const names = idx.map((i) => i.name);
  assert.ok(names.includes('events_ts'));
  assert.ok(names.includes('events_kind_ts'));
  assert.ok(names.includes('events_source_ts'));
  closeDb(db);
});
