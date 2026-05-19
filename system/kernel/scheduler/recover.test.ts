import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { closeDb, openDb } from '../../brain/memory/db.ts';
import { allMigrations, applyMigrations } from '../../brain/memory/migrations/index.ts';
import { claimNextJob, enqueueJob, recoverExpiredLeases } from './claim.ts';

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
