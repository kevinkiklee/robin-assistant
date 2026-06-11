import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { closeDb, openDb, type RobinDb } from '../../../brain/memory/db.ts';
import { allMigrations, applyMigrations } from '../../../brain/memory/migrations/index.ts';
import { jobsErroringInvariant } from './jobs-erroring.ts';

function freshDb(): RobinDb {
  const dir = mkdtempSync(join(tmpdir(), 'robin-jobs-erroring-'));
  const db = openDb(join(dir, 'robin.sqlite'));
  applyMigrations(db, allMigrations);
  return db;
}

/** Insert a jobs row with the given state and an explicit created_at offset. */
function insertJob(db: RobinDb, name: string, state: string, createdAt: string): void {
  db.prepare(
    `INSERT INTO jobs (name, trigger_kind, scheduled_at, state, created_at)
     VALUES (?, 'cron', ?, ?, ?)`,
  ).run(name, createdAt, state, createdAt);
}

const NOW_ISO = '2026-06-10T12:00:00.000Z';

/** ISO string `hoursAgo` hours before NOW_ISO */
function hoursAgo(h: number): string {
  return new Date(new Date(NOW_ISO).getTime() - h * 3_600_000).toISOString();
}

/** ISO string `daysAgo` days before NOW_ISO */
function daysAgo(d: number): string {
  return new Date(new Date(NOW_ISO).getTime() - d * 86_400_000).toISOString();
}

test('jobs-erroring: empty table → ok', async () => {
  const db = freshDb();
  const inv = jobsErroringInvariant(db);
  const r = await inv.check();
  assert.equal(r.ok, true, JSON.stringify(r));
  closeDb(db);
});

test('jobs-erroring: one errored row in the last 24h → fires with name and count', async () => {
  const db = freshDb();
  insertJob(db, 'biographer', 'errored', hoursAgo(1));
  const inv = jobsErroringInvariant(db);
  const r = await inv.check();
  assert.equal(r.ok, false, JSON.stringify(r));
  assert.match(r.message ?? '', /biographer/);
  assert.match(r.message ?? '', /1×/);
  assert.ok(r.remediation, 'remediation should be present');
  closeDb(db);
});

test('jobs-erroring: multiple errored rows for same job → count aggregated', async () => {
  const db = freshDb();
  insertJob(db, 'biographer', 'errored', hoursAgo(2));
  insertJob(db, 'biographer', 'errored', hoursAgo(3));
  insertJob(db, 'biographer', 'errored', hoursAgo(5));
  const inv = jobsErroringInvariant(db);
  const r = await inv.check();
  assert.equal(r.ok, false, JSON.stringify(r));
  assert.match(r.message ?? '', /biographer errored 3×/);
  closeDb(db);
});

test('jobs-erroring: errored row 2 days old (outside 24h window) → ok', async () => {
  const db = freshDb();
  insertJob(db, 'biographer', 'errored', daysAgo(2));
  const inv = jobsErroringInvariant(db);
  const r = await inv.check();
  assert.equal(r.ok, true, JSON.stringify(r));
  closeDb(db);
});

test('jobs-erroring: completed rows in last 24h → ok', async () => {
  const db = freshDb();
  insertJob(db, 'biographer', 'completed', hoursAgo(1));
  insertJob(db, 'embedder', 'completed', hoursAgo(2));
  const inv = jobsErroringInvariant(db);
  const r = await inv.check();
  assert.equal(r.ok, true, JSON.stringify(r));
  closeDb(db);
});

test('jobs-erroring: mix of errored and completed rows — only errored jobs flagged', async () => {
  const db = freshDb();
  insertJob(db, 'biographer', 'completed', hoursAgo(1));
  insertJob(db, 'embedder', 'errored', hoursAgo(2));
  const inv = jobsErroringInvariant(db);
  const r = await inv.check();
  assert.equal(r.ok, false, JSON.stringify(r));
  assert.match(r.message ?? '', /embedder/);
  assert.doesNotMatch(r.message ?? '', /biographer/);
  closeDb(db);
});
