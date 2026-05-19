import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { closeDb, openDb } from '../../brain/memory/db.ts';
import { allMigrations, applyMigrations } from '../../brain/memory/migrations/index.ts';
import { claimNextJob, enqueueJob } from './claim.ts';

function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), 'robin-sched-'));
  mkdirSync(join(dir, 'state', 'db'), { recursive: true });
  const db = openDb(join(dir, 'state', 'db', 'robin.sqlite'));
  applyMigrations(db, allMigrations);
  return db;
}

test('scheduler: enqueue + claim returns job; second claim returns null', () => {
  const db = freshDb();
  enqueueJob(db, {
    name: 'test.noop',
    trigger_kind: 'manual',
    scheduled_at: new Date().toISOString(),
  });
  const job = claimNextJob(db, { workerId: 'w1', leaseMs: 5000 });
  assert.ok(job);
  assert.equal(job.name, 'test.noop');
  assert.equal(job.state, 'leased');
  const second = claimNextJob(db, { workerId: 'w2', leaseMs: 5000 });
  assert.equal(second, null);
  closeDb(db);
});

test('scheduler: future jobs are not claimed', () => {
  const db = freshDb();
  const future = new Date(Date.now() + 60_000).toISOString();
  enqueueJob(db, { name: 'test.future', trigger_kind: 'cron', scheduled_at: future });
  const job = claimNextJob(db, { workerId: 'w1', leaseMs: 5000 });
  assert.equal(job, null);
  closeDb(db);
});

test('scheduler: claims oldest-scheduled first (FIFO by scheduled_at)', () => {
  const db = freshDb();
  const t1 = new Date(Date.now() - 2000).toISOString();
  const t2 = new Date(Date.now() - 1000).toISOString();
  enqueueJob(db, { name: 'newer', trigger_kind: 'manual', scheduled_at: t2 });
  enqueueJob(db, { name: 'older', trigger_kind: 'manual', scheduled_at: t1 });
  const first = claimNextJob(db, { workerId: 'w1', leaseMs: 5000 });
  assert.equal(first?.name, 'older');
  closeDb(db);
});
