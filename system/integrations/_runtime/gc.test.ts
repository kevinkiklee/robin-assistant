import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { closeDb, openDb } from '../../brain/memory/db.ts';
import { allMigrations, applyMigrations } from '../../brain/memory/migrations/index.ts';
import { gcStaleTerminalJobs } from './gc.ts';

function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), 'robin-gc-jobs-'));
  const db = openDb(join(dir, 'robin.sqlite'));
  applyMigrations(db, allMigrations);
  return db;
}

function insertJob(db: ReturnType<typeof freshDb>, name: string, state: string, createdAt: string) {
  db.prepare(
    `INSERT INTO jobs (name, trigger_kind, scheduled_at, state, created_at)
     VALUES (?, 'cron', ?, ?, ?)`,
  ).run(name, createdAt, state, createdAt);
}

test('gcStaleTerminalJobs: deletes terminal rows older than retention, keeps recent + non-terminal', () => {
  const db = freshDb();
  const old = "datetime('now','-30 days')";
  const recent = "datetime('now','-1 days')";
  // Build the rows with SQL-computed timestamps so the test is clock-independent.
  db.prepare(
    `INSERT INTO jobs (name, trigger_kind, scheduled_at, state, created_at)
     VALUES ('a.tick','cron','x','completed',${old})`,
  ).run();
  db.prepare(
    `INSERT INTO jobs (name, trigger_kind, scheduled_at, state, created_at)
     VALUES ('b.tick','cron','x','errored',${old})`,
  ).run();
  db.prepare(
    `INSERT INTO jobs (name, trigger_kind, scheduled_at, state, created_at)
     VALUES ('c.tick','cron','x','completed',${recent})`,
  ).run();
  db.prepare(
    `INSERT INTO jobs (name, trigger_kind, scheduled_at, state, created_at)
     VALUES ('d.tick','cron','x','pending',${old})`,
  ).run();

  const deleted = gcStaleTerminalJobs(db, 7);
  assert.equal(deleted, 2, 'the two terminal rows older than 7d are pruned');

  const remaining = db.prepare('SELECT name, state FROM jobs ORDER BY name').all() as Array<{
    name: string;
    state: string;
  }>;
  assert.deepEqual(
    remaining.map((r) => r.name),
    ['c.tick', 'd.tick'],
    'recent terminal row and old pending row are kept',
  );
  closeDb(db);
});

test('gcStaleTerminalJobs: no-op when nothing is stale', () => {
  const db = freshDb();
  insertJob(db, 'a.tick', 'completed', new Date().toISOString());
  assert.equal(gcStaleTerminalJobs(db, 7), 0);
  closeDb(db);
});
