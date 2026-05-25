import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { closeDb, openDb } from '../memory/db.ts';
import { allMigrations, applyMigrations } from '../memory/migrations/index.ts';
import { COGNITION_JOBS, registerCognitionJobs } from './jobs.ts';

function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), 'robin-cog-jobs-'));
  mkdirSync(join(dir, 'state', 'db'), { recursive: true });
  const db = openDb(join(dir, 'state', 'db', 'robin.sqlite'));
  applyMigrations(db, allMigrations);
  return db;
}

test('cognition jobs: COGNITION_JOBS lists biographer + dream + automatic doc ingest', () => {
  const names = COGNITION_JOBS.map((j) => j.name);
  assert.ok(names.includes('biographer.run'));
  assert.ok(names.includes('dream.run'));
  // ingest-docs runs on a cron so the user never has to invoke it by hand.
  assert.ok(names.includes('ingest-docs.run'));
});

test('cognition jobs: registerCognitionJobs seeds cron rows for each', () => {
  const db = freshDb();
  const fakeDaemon = { registerHandler: () => {} } as unknown as Parameters<
    typeof registerCognitionJobs
  >[0];
  registerCognitionJobs(fakeDaemon, db, () => null);
  const rows = db.prepare("SELECT name FROM jobs WHERE state='pending'").all() as Array<{
    name: string;
  }>;
  const names = rows.map((r) => r.name);
  assert.ok(names.includes('biographer.run'));
  assert.ok(names.includes('dream.run'));
  closeDb(db);
});
