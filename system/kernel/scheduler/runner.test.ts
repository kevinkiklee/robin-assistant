import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { closeDb, openDb } from '../../brain/memory/db.ts';
import { allMigrations, applyMigrations } from '../../brain/memory/migrations/index.ts';
import { enqueueJob } from './claim.ts';
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
