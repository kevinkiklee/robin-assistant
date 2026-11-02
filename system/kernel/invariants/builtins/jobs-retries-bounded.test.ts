import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { closeDb, openDb } from '../../../brain/memory/db.ts';
import { allMigrations, applyMigrations } from '../../../brain/memory/migrations/index.ts';
import { jobsRetriesBoundedInvariant } from './jobs-retries-bounded.ts';

function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), 'robin-jobs-retries-'));
  const db = openDb(join(dir, 'robin.sqlite'));
  applyMigrations(db, allMigrations);
  return db;
}

/** Seed one terminal row with a given retry_count / breadcrumb / age. */
function seedJob(
  db: ReturnType<typeof freshDb>,
  opts: { name: string; retry: number; lastError?: string | null; ageHours?: number },
) {
  db.prepare(
    `INSERT INTO jobs (name, trigger_kind, scheduled_at, state, retry_count, last_error, created_at)
     VALUES (?, 'cron', 'x', 'completed', ?, ?, datetime('now', ?))`,
  ).run(opts.name, opts.retry, opts.lastError ?? null, `-${opts.ageHours ?? 0} hours`);
}

test('jobs.retries_bounded: empty table reports ok', async () => {
  const db = freshDb();
  const r = await jobsRetriesBoundedInvariant(db).check();
  assert.equal(r.ok, true);
  closeDb(db);
});

test('jobs.retries_bounded: retries below threshold report ok', async () => {
  const db = freshDb();
  seedJob(db, { name: 'biographer.run', retry: 3, lastError: 'lease expired (worker=w1)' });
  const r = await jobsRetriesBoundedInvariant(db, { warnRetries: 10 }).check();
  assert.equal(r.ok, true);
  closeDb(db);
});

test('jobs.retries_bounded: a high-retry job trips the check and names job + cause', async () => {
  const db = freshDb();
  seedJob(db, {
    name: 'biographer.run',
    retry: 54,
    lastError: 'lease expired (worker=w1, due=2026-06-06T10:00:00Z)',
  });
  seedJob(db, { name: 'dream.run', retry: 12, lastError: 'worker reset (was=old, now=new)' });
  const r = await jobsRetriesBoundedInvariant(db, { warnRetries: 10 }).check();
  assert.equal(r.ok, false);
  assert.match(r.message ?? '', /biographer\.run/); // worst offender named
  assert.match(r.message ?? '', /54/); // its retry count
  assert.match(r.message ?? '', /lease expired/); // its breadcrumb cause
  assert.match(r.message ?? '', /2 job/); // count of offenders at/over threshold
  closeDb(db);
});

test('jobs.retries_bounded: rows outside the window are ignored', async () => {
  const db = freshDb();
  // 54 retries but 30 days old — outside the default 24h window.
  seedJob(db, { name: 'biographer.run', retry: 54, ageHours: 24 * 30 });
  const r = await jobsRetriesBoundedInvariant(db, { warnRetries: 10, windowHours: 24 }).check();
  assert.equal(r.ok, true);
  closeDb(db);
});

test('jobs.retries_bounded: respects injected threshold', async () => {
  const db = freshDb();
  seedJob(db, { name: 'biographer.run', retry: 5 });
  assert.equal((await jobsRetriesBoundedInvariant(db, { warnRetries: 10 }).check()).ok, true);
  assert.equal((await jobsRetriesBoundedInvariant(db, { warnRetries: 3 }).check()).ok, false);
  closeDb(db);
});
