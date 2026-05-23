import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { closeDb, openDb } from '../../../brain/memory/db.ts';
import { allMigrations, applyMigrations } from '../../../brain/memory/migrations/index.ts';
import { jobsDiscoverableInvariant } from './jobs-discoverable.ts';

function freshSetup() {
  const dir = mkdtempSync(join(tmpdir(), 'robin-inv-jobs-'));
  mkdirSync(join(dir, 'state', 'db'), { recursive: true });
  mkdirSync(join(dir, 'extensions', 'jobs'), { recursive: true });
  const db = openDb(join(dir, 'state', 'db', 'robin.sqlite'));
  applyMigrations(db, allMigrations);
  process.env.ROBIN_USER_DATA_DIR = dir;
  return { dir, db };
}

test('jobs.discoverable: ok when no jobs are scheduled', async () => {
  const { db } = freshSetup();
  const r = await jobsDiscoverableInvariant(db).check();
  assert.equal(r.ok, true);
  closeDb(db);
});

test('jobs.discoverable: fails when a scheduled job has no source files', async () => {
  const { db } = freshSetup();
  // Schedule a job but never create its directory — exactly the daily-brief incident shape.
  db.prepare(
    `INSERT INTO jobs (name, trigger_kind, scheduled_at, state) VALUES (?, 'cron', datetime('now'), 'pending')`,
  ).run('job.ghost.run');
  const r = await jobsDiscoverableInvariant(db).check();
  assert.equal(r.ok, false);
  assert.match(r.message ?? '', /ghost/);
  closeDb(db);
});

test('jobs.discoverable: fails when only prompt.md remains (the actual deletion mode)', async () => {
  const { dir, db } = freshSetup();
  const jobDir = join(dir, 'extensions', 'jobs', 'half-deleted');
  mkdirSync(jobDir, { recursive: true });
  // Only prompt.md remains — mirrors what we found for daily-brief.
  writeFileSync(join(jobDir, 'prompt.md'), '# prompt');
  db.prepare(
    `INSERT INTO jobs (name, trigger_kind, scheduled_at, state) VALUES (?, 'cron', datetime('now'), 'pending')`,
  ).run('job.half-deleted.run');
  const r = await jobsDiscoverableInvariant(db).check();
  assert.equal(r.ok, false);
  assert.match(r.message ?? '', /half-deleted/);
  closeDb(db);
});

test('jobs.discoverable: ok when both manifest and entry exist under user-data/extensions/jobs', async () => {
  const { dir, db } = freshSetup();
  const jobDir = join(dir, 'extensions', 'jobs', 'real-job');
  mkdirSync(jobDir, { recursive: true });
  writeFileSync(join(jobDir, 'job.yaml'), 'name: real-job\nversion: 1.0.0\n');
  writeFileSync(join(jobDir, 'index.ts'), 'export const job = { async run() { return { status: "ok" }; } };\n');
  db.prepare(
    `INSERT INTO jobs (name, trigger_kind, scheduled_at, state) VALUES (?, 'cron', datetime('now'), 'pending')`,
  ).run('job.real-job.run');
  const r = await jobsDiscoverableInvariant(db).check();
  assert.equal(r.ok, true);
  closeDb(db);
});
