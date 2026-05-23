import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { closeDb, openDb } from '../../brain/memory/db.ts';
import { allMigrations, applyMigrations } from '../../brain/memory/migrations/index.ts';
import {
  claimNextJob,
  enqueueJob,
  recoverDeadWorkerLeases,
  recoverExpiredLeases,
} from './claim.ts';

function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), 'robin-rec-'));
  mkdirSync(join(dir, 'state', 'db'), { recursive: true });
  const db = openDb(join(dir, 'state', 'db', 'robin.sqlite'));
  applyMigrations(db, allMigrations);
  return db;
}

test('recover: returns expired-lease jobs to pending and increments retry_count', () => {
  const db = freshDb();
  enqueueJob(db, { name: 'test', trigger_kind: 'manual', scheduled_at: new Date().toISOString() });

  // Claim with a 1ms lease so it expires immediately
  const job = claimNextJob(db, { workerId: 'w1', leaseMs: 1 });
  assert.ok(job);

  // Wait long enough for the lease to expire (lease was 1ms ago)
  const recovered = recoverExpiredLeases(db, new Date(Date.now() + 100).toISOString());
  assert.equal(recovered, 1);

  const row = db
    .prepare('SELECT state, retry_count, claimed_by FROM jobs WHERE id = ?')
    .get(job.id) as { state: string; retry_count: number; claimed_by: string | null };
  assert.equal(row.state, 'pending');
  assert.equal(row.retry_count, 1);
  assert.equal(row.claimed_by, null);
  closeDb(db);
});

test('recover: does not touch unexpired leases', () => {
  const db = freshDb();
  enqueueJob(db, { name: 'test', trigger_kind: 'manual', scheduled_at: new Date().toISOString() });
  claimNextJob(db, { workerId: 'w1', leaseMs: 60_000 });
  const recovered = recoverExpiredLeases(db, new Date().toISOString());
  assert.equal(recovered, 0);
  closeDb(db);
});

// After `launchctl kickstart -k` the new daemon's worker id differs from the
// predecessor's. `recoverExpiredLeases` alone won't help (lease still has
// LEASE_MS left), so the new daemon would idle for up to 5 min waiting for
// the predecessor's lease to expire naturally.
test('recover: dead-worker reset frees leases held by a different worker', () => {
  const db = freshDb();
  enqueueJob(db, { name: 'test', trigger_kind: 'manual', scheduled_at: new Date().toISOString() });

  // Old worker claims with a long lease.
  const job = claimNextJob(db, { workerId: 'old-daemon', leaseMs: 60_000 });
  assert.ok(job);

  // Expired-lease reaper alone doesn't help (lease still valid).
  assert.equal(recoverExpiredLeases(db, new Date().toISOString()), 0);

  // Dead-worker reset by the new daemon claims it back.
  const recovered = recoverDeadWorkerLeases(db, 'new-daemon');
  assert.equal(recovered, 1);

  const row = db
    .prepare('SELECT state, retry_count, claimed_by FROM jobs WHERE id = ?')
    .get(job.id) as { state: string; retry_count: number; claimed_by: string | null };
  assert.equal(row.state, 'pending');
  assert.equal(row.retry_count, 1);
  assert.equal(row.claimed_by, null);
  closeDb(db);
});

test('recover: dead-worker reset leaves OUR leases alone', () => {
  const db = freshDb();
  enqueueJob(db, { name: 'test', trigger_kind: 'manual', scheduled_at: new Date().toISOString() });
  const job = claimNextJob(db, { workerId: 'our-daemon', leaseMs: 60_000 });
  assert.ok(job);

  const recovered = recoverDeadWorkerLeases(db, 'our-daemon');
  assert.equal(recovered, 0);

  const row = db.prepare('SELECT state, claimed_by FROM jobs WHERE id = ?').get(job.id) as {
    state: string;
    claimed_by: string | null;
  };
  assert.equal(row.state, 'leased');
  assert.equal(row.claimed_by, 'our-daemon');
  closeDb(db);
});

test('recover: dead-worker reset ignores pending/completed rows', () => {
  const db = freshDb();
  enqueueJob(db, {
    name: 'pending-row',
    trigger_kind: 'manual',
    scheduled_at: new Date().toISOString(),
  });
  enqueueJob(db, {
    name: 'leased-row',
    trigger_kind: 'manual',
    scheduled_at: new Date().toISOString(),
  });
  claimNextJob(db, { workerId: 'old', leaseMs: 60_000 });

  // Only the leased-by-old row should reset; the pending row is unaffected.
  const recovered = recoverDeadWorkerLeases(db, 'new');
  assert.equal(recovered, 1);
});
