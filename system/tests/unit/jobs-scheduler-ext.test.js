import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { close, connect } from '../../data/db/client.js';
import { runMigrations } from '../../data/db/migrate.js';
import { setEnabled, upsertFromDiscovered } from '../../cognition/jobs/db.js';
import { listDueJobs, planNextRunAt } from '../../cognition/jobs/scheduler-ext.js';

import { writeConfig as __wc } from '../../config/paths.js';

const __h = join(tmpdir(), `robin-test-${process.pid}-${Math.random().toString(36).slice(2)}`);
mkdirSync(__h, { recursive: true });
process.env.ROBIN_HOME = __h;
await __wc({ embedder_profile: 'mxbai-1024' });

async function fresh() {
  const db = await connect({ engine: 'mem://' });
  await runMigrations(db, resolve(import.meta.dirname, '../../src/schema/migrations'));
  return db;
}

const JOB = (over = {}) => ({
  name: 'foo',
  schedule: '@hourly',
  runtime: 'agent',
  enabled: true,
  catch_up: false,
  notify: 'capture',
  notify_on_failure: true,
  timeout_minutes: 10,
  manually_runnable: true,
  ...over,
});

test('planNextRunAt — first fire with catch_up:false uses nextFire', async () => {
  const db = await fresh();
  const j = JOB({ catch_up: false });
  await upsertFromDiscovered(db, [j]);
  // Note: nextFire/parseCron uses process.env.TZ; for @hourly the TZ doesn't matter
  // because the minute=0 happens every hour regardless of zone.
  const now = new Date('2026-05-10T12:34:00.000Z');
  await planNextRunAt(db, [j], now);
  const [rows] = await db.query("SELECT * FROM runtime_jobs WHERE name = 'foo'").collect();
  // @hourly = "0 * * * *" → next is 13:00:00 (regardless of TZ)
  assert.equal(rows[0].next_run_at.toISOString(), '2026-05-10T13:00:00.000Z');
  await close(db);
});

test('planNextRunAt — first fire with catch_up:true sets next_run_at = now', async () => {
  const db = await fresh();
  const j = JOB({ catch_up: true });
  await upsertFromDiscovered(db, [j]);
  const now = new Date('2026-05-10T12:34:00.000Z');
  await planNextRunAt(db, [j], now);
  const [rows] = await db.query("SELECT * FROM runtime_jobs WHERE name = 'foo'").collect();
  assert.equal(rows[0].next_run_at.toISOString(), now.toISOString());
  await close(db);
});

test('listDueJobs — returns enabled jobs with next_run_at <= now and not in_flight', async () => {
  const db = await fresh();
  await upsertFromDiscovered(db, [JOB({ name: 'a' }), JOB({ name: 'b' }), JOB({ name: 'c' })]);
  const now = new Date('2026-05-10T13:00:00.000Z');
  // a: due now
  await db
    .query(`UPDATE runtime_jobs MERGE { next_run_at: d'2026-05-10T12:59:00Z' } WHERE name = 'a'`)
    .collect();
  // b: due now but in_flight
  await db
    .query(
      `UPDATE runtime_jobs MERGE { next_run_at: d'2026-05-10T12:59:00Z', in_flight: true } WHERE name = 'b'`,
    )
    .collect();
  // c: not due
  await db
    .query(`UPDATE runtime_jobs MERGE { next_run_at: d'2026-05-10T14:00:00Z' } WHERE name = 'c'`)
    .collect();
  const due = await listDueJobs(db, now);
  assert.deepEqual(due, [{ name: 'a', kind: 'job' }]);
  await close(db);
});

test('listDueJobs — skips disabled jobs', async () => {
  const db = await fresh();
  await upsertFromDiscovered(db, [JOB({ name: 'a' })]);
  await setEnabled(db, 'a', false);
  await db
    .query(`UPDATE runtime_jobs MERGE { next_run_at: time::now() - 1m } WHERE name = 'a'`)
    .collect();
  const due = await listDueJobs(db, new Date());
  assert.deepEqual(due, []);
  await close(db);
});

test('planNextRunAt — catch_up:true, last_run >1.5× cadence behind → fires now', async () => {
  // @hourly cadence is 1h; 2h behind > 1.5× → fire on next tick.
  const db = await fresh();
  const j = JOB({ catch_up: true });
  await upsertFromDiscovered(db, [j]);
  const twoHoursAgo = new Date(Date.now() - 2 * 3600_000);
  await db
    .query(
      `UPDATE runtime_jobs MERGE { last_run_at: d'${twoHoursAgo.toISOString()}' } WHERE name = 'foo'`,
    )
    .collect();
  const now = new Date();
  await planNextRunAt(db, [j], now);
  const [rows] = await db
    .query("SELECT next_run_at FROM runtime_jobs WHERE name = 'foo'")
    .collect();
  const delta = Math.abs(new Date(rows[0].next_run_at).getTime() - now.getTime());
  assert.ok(delta < 1000, `expected immediate fire on catch-up; got ${delta}ms drift`);
  await close(db);
});

test('planNextRunAt — catch_up:false, last_run far behind → schedules forward, not now', async () => {
  const db = await fresh();
  const j = JOB({ catch_up: false });
  await upsertFromDiscovered(db, [j]);
  const twoHoursAgo = new Date(Date.now() - 2 * 3600_000);
  await db
    .query(
      `UPDATE runtime_jobs MERGE { last_run_at: d'${twoHoursAgo.toISOString()}' } WHERE name = 'foo'`,
    )
    .collect();
  const now = new Date();
  await planNextRunAt(db, [j], now);
  const [rows] = await db
    .query("SELECT next_run_at FROM runtime_jobs WHERE name = 'foo'")
    .collect();
  const delta = new Date(rows[0].next_run_at).getTime() - now.getTime();
  assert.ok(delta > 0, `catch_up:false must schedule forward, not fire-now; got delta=${delta}ms`);
  await close(db);
});
