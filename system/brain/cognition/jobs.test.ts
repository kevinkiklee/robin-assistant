import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openDb, closeDb } from '../memory/db.ts';
import { allMigrations, applyMigrations } from '../memory/migrations/index.ts';
import { COGNITION_JOBS, registerCognitionJobs } from './jobs.ts';

function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), 'robin-cog-jobs-'));
  mkdirSync(join(dir, 'state', 'db'), { recursive: true });
  const db = openDb(join(dir, 'state', 'db', 'robin.sqlite'));
  applyMigrations(db, allMigrations);
  return db;
}

test('cognition jobs: COGNITION_JOBS lists biographer + dream', () => {
  const names = COGNITION_JOBS.map((j) => j.name);
  assert.ok(names.includes('biographer.run'));
  assert.ok(names.includes('dream.run'));
});

test('cognition jobs: registerCognitionJobs seeds cron rows for each', () => {
  const db = freshDb();
  const fakeDaemon = { registerHandler: () => {} } as unknown as Parameters<typeof registerCognitionJobs>[0];
  registerCognitionJobs(fakeDaemon, db, () => null);
  const rows = db.prepare("SELECT name FROM jobs WHERE state='pending'").all() as Array<{ name: string }>;
  const names = rows.map((r) => r.name);
  assert.ok(names.includes('biographer.run'));
  assert.ok(names.includes('dream.run'));
  closeDb(db);
});
