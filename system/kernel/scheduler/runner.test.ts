import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { closeDb, openDb } from '../../brain/memory/db.ts';
import { allMigrations, applyMigrations } from '../../brain/memory/migrations/index.ts';
import { enqueueJob } from './claim.ts';
import { scheduleCronJob } from './cron.ts';
import { type JobHandler, Scheduler } from './runner.ts';

function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), 'robin-run-'));
  mkdirSync(join(dir, 'state', 'db'), { recursive: true });
  const db = openDb(join(dir, 'state', 'db', 'robin.sqlite'));
  applyMigrations(db, allMigrations);
  return db;
}

test('scheduler runner: claims pending job and runs its handler', async () => {
  const db = freshDb();
  let calls = 0;
  const handlers = new Map<string, JobHandler>([
    [
      'test.noop',
      async () => {
        calls++;
      },
    ],
  ]);
  const sched = new Scheduler({
    db,
    handlers,
    workerId: 'w1',
    leaseMs: 5000,
    isPaused: () => false,
  });

  enqueueJob(db, {
    name: 'test.noop',
    trigger_kind: 'manual',
    scheduled_at: new Date().toISOString(),
  });
  await sched.tickOnce();
  assert.equal(calls, 1);
  const state = (
    db.prepare("SELECT state FROM jobs WHERE name = 'test.noop'").get() as { state: string }
  ).state;
  assert.equal(state, 'completed');
  closeDb(db);
});

test('scheduler runner: handler error marks job errored', async () => {
  const db = freshDb();
  const handlers = new Map<string, JobHandler>([
    [
      'test.boom',
      async () => {
        throw new Error('kaboom');
      },
    ],
  ]);
  const sched = new Scheduler({
    db,
    handlers,
    workerId: 'w1',
    leaseMs: 5000,
    isPaused: () => false,
  });

  enqueueJob(db, {
    name: 'test.boom',
    trigger_kind: 'manual',
    scheduled_at: new Date().toISOString(),
  });
  await sched.tickOnce();
  const row = db.prepare("SELECT state, last_error FROM jobs WHERE name = 'test.boom'").get() as {
    state: string;
    last_error: string;
  };
  assert.equal(row.state, 'errored');
  assert.match(row.last_error, /kaboom/);
  closeDb(db);
});

test('scheduler runner: hung handler times out and is marked errored (does not wedge the loop)', {
  timeout: 5000,
}, async () => {
  const db = freshDb();
  const handlers = new Map<string, JobHandler>([
    // A handler that never settles — the wedge that took the daemon down for ~31h.
    ['test.hang', () => new Promise<void>(() => {})],
  ]);
  const sched = new Scheduler({
    db,
    handlers,
    workerId: 'w1',
    leaseMs: 5000,
    isPaused: () => false,
    handlerTimeoutMs: 50,
  });

  enqueueJob(db, {
    name: 'test.hang',
    trigger_kind: 'manual',
    scheduled_at: new Date().toISOString(),
  });

  // Must resolve well within the test timeout — the whole point is the loop is freed.
  const ran = await sched.tickOnce();
  assert.equal(ran, true);
  const row = db.prepare("SELECT state, last_error FROM jobs WHERE name = 'test.hang'").get() as {
    state: string;
    last_error: string;
  };
  assert.equal(row.state, 'errored');
  assert.match(row.last_error, /timed out/i);
  closeDb(db);
});

test('scheduler runner: loop keeps serving other jobs after a handler times out', {
  timeout: 5000,
}, async () => {
  const db = freshDb();
  let goodCalls = 0;
  const handlers = new Map<string, JobHandler>([
    ['test.hang', () => new Promise<void>(() => {})],
    [
      'test.good',
      async () => {
        goodCalls++;
      },
    ],
  ]);
  const sched = new Scheduler({
    db,
    handlers,
    workerId: 'w1',
    leaseMs: 5000,
    isPaused: () => false,
    handlerTimeoutMs: 50,
  });

  // Enqueue the poison job first (lower id → claimed first), then a healthy one.
  enqueueJob(db, {
    name: 'test.hang',
    trigger_kind: 'manual',
    scheduled_at: new Date(Date.now() - 1000).toISOString(),
  });
  enqueueJob(db, {
    name: 'test.good',
    trigger_kind: 'manual',
    scheduled_at: new Date().toISOString(),
  });

  await sched.tickOnce(); // poison job times out
  await sched.tickOnce(); // healthy job must still run
  assert.equal(goodCalls, 1);
  closeDb(db);
});

test('scheduler runner: handler finishing under the timeout completes normally', async () => {
  const db = freshDb();
  let calls = 0;
  const handlers = new Map<string, JobHandler>([
    [
      'test.fast',
      async () => {
        calls++;
      },
    ],
  ]);
  const sched = new Scheduler({
    db,
    handlers,
    workerId: 'w1',
    leaseMs: 5000,
    isPaused: () => false,
    handlerTimeoutMs: 60_000,
  });

  enqueueJob(db, {
    name: 'test.fast',
    trigger_kind: 'manual',
    scheduled_at: new Date().toISOString(),
  });
  await sched.tickOnce();
  assert.equal(calls, 1);
  const state = (
    db.prepare("SELECT state FROM jobs WHERE name = 'test.fast'").get() as { state: string }
  ).state;
  assert.equal(state, 'completed');
  closeDb(db);
});

test('scheduler runner: skips claim when paused', async () => {
  const db = freshDb();
  let calls = 0;
  const handlers = new Map<string, JobHandler>([
    [
      'test.noop',
      async () => {
        calls++;
      },
    ],
  ]);
  const sched = new Scheduler({
    db,
    handlers,
    workerId: 'w1',
    leaseMs: 5000,
    isPaused: () => true,
  });

  enqueueJob(db, {
    name: 'test.noop',
    trigger_kind: 'manual',
    scheduled_at: new Date().toISOString(),
  });
  await sched.tickOnce();
  assert.equal(calls, 0);
  const state = (
    db.prepare("SELECT state FROM jobs WHERE name = 'test.noop'").get() as { state: string }
  ).state;
  assert.equal(state, 'pending');
  closeDb(db);
});

test('scheduler runner: cron job re-arms a pending row after successful completion (Bug C regression)', async () => {
  const db = freshDb();
  let calls = 0;
  const handlers = new Map<string, JobHandler>([
    [
      'test.cron',
      async () => {
        calls++;
      },
    ],
  ]);
  const sched = new Scheduler({
    db,
    handlers,
    workerId: 'w1',
    leaseMs: 5000,
    isPaused: () => false,
  });

  // Seed an every-minute cron at a past time so claimNextJob picks it up immediately.
  const past = new Date(Date.now() - 60_000);
  scheduleCronJob(db, { name: 'test.cron', cron: '* * * * *', tz: 'UTC' }, past);

  await sched.tickOnce();
  assert.equal(calls, 1);

  // After completion, the runner must have inserted a new pending row for the next minute.
  const rows = db
    .prepare("SELECT state, COUNT(*) OVER () as total FROM jobs WHERE name='test.cron' ORDER BY id")
    .all() as { state: string; total: number }[];
  assert.equal(rows.length, 2, 'expected exactly two rows: completed + next pending');
  assert.equal(rows[0].state, 'completed');
  assert.equal(rows[1].state, 'pending');
  closeDb(db);
});

test('scheduler runner: cron job re-arms even after handler error (transient failure)', async () => {
  const db = freshDb();
  const handlers = new Map<string, JobHandler>([
    [
      'test.cron-err',
      async () => {
        throw new Error('transient');
      },
    ],
  ]);
  const sched = new Scheduler({
    db,
    handlers,
    workerId: 'w1',
    leaseMs: 5000,
    isPaused: () => false,
  });

  const past = new Date(Date.now() - 60_000);
  scheduleCronJob(db, { name: 'test.cron-err', cron: '* * * * *', tz: 'UTC' }, past);
  await sched.tickOnce();

  const rows = db
    .prepare("SELECT state FROM jobs WHERE name='test.cron-err' ORDER BY id")
    .all() as { state: string }[];
  // Error on the first row, but a fresh pending row must still be enqueued so the
  // cron survives transient failures.
  assert.equal(rows.length, 2);
  assert.equal(rows[0].state, 'errored');
  assert.equal(rows[1].state, 'pending');
  closeDb(db);
});

test('scheduler runner: non-cron rows are not rescheduled on completion', async () => {
  const db = freshDb();
  const handlers = new Map<string, JobHandler>([['test.oneshot', async () => {}]]);
  const sched = new Scheduler({
    db,
    handlers,
    workerId: 'w1',
    leaseMs: 5000,
    isPaused: () => false,
  });

  enqueueJob(db, {
    name: 'test.oneshot',
    trigger_kind: 'manual',
    scheduled_at: new Date(Date.now() - 1000).toISOString(),
  });
  await sched.tickOnce();

  const rows = db.prepare("SELECT state FROM jobs WHERE name='test.oneshot' ORDER BY id").all() as {
    state: string;
  }[];
  assert.equal(rows.length, 1, 'manual jobs should not re-arm');
  assert.equal(rows[0].state, 'completed');
  closeDb(db);
});

test('scheduler runner: missing handler marks job errored with clear message', async () => {
  const db = freshDb();
  const handlers = new Map<string, JobHandler>();
  const sched = new Scheduler({
    db,
    handlers,
    workerId: 'w1',
    leaseMs: 5000,
    isPaused: () => false,
  });

  enqueueJob(db, {
    name: 'test.unknown',
    trigger_kind: 'manual',
    scheduled_at: new Date().toISOString(),
  });
  await sched.tickOnce();
  const row = db
    .prepare("SELECT state, last_error FROM jobs WHERE name = 'test.unknown'")
    .get() as { state: string; last_error: string };
  assert.equal(row.state, 'errored');
  assert.match(row.last_error, /no handler/i);
  closeDb(db);
});
