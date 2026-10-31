import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { closeDb, openDb } from '../db.ts';
import { allMigrations, applyMigrations } from './index.ts';

test('schema 002: entities/relations/recall_log/embedding_profiles/events_vec exist', () => {
  const dir = mkdtempSync(join(tmpdir(), 'robin-mig2-'));
  mkdirSync(join(dir, 'state', 'db'), { recursive: true });
  const db = openDb(join(dir, 'state', 'db', 'robin.sqlite'));
  applyMigrations(db, allMigrations);
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type IN ('table','virtual') ORDER BY name")
    .all() as Array<{ name: string }>;
  const names = tables.map((t) => t.name);
  for (const expected of ['entities', 'relations', 'recall_log', 'embedding_profiles']) {
    assert.ok(names.includes(expected), `${expected} missing`);
  }
  const vec = db.prepare("SELECT name FROM sqlite_master WHERE name='events_vec'").get();
  assert.ok(vec, 'events_vec virtual table missing');
  closeDb(db);
});
