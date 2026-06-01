import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { closeDb, openDb } from '../../../brain/memory/db.ts';
import { allMigrations, applyMigrations } from '../../../brain/memory/migrations/index.ts';
import { jobsHistoryBoundedInvariant } from './jobs-history-bounded.ts';

function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), 'robin-jobs-bounded-'));
  const db = openDb(join(dir, 'robin.sqlite'));
  applyMigrations(db, allMigrations);
  return db;
}

test('jobs.history_bounded: warns above ceiling, repair prunes stale terminal rows back under it', async () => {
  const db = freshDb();
  // Inject a tiny ceiling so the test stays fast. Seed > ceiling terminal rows
  // aged past retention; repair (prune older than retention) clears them.
  const insert = db.prepare(
    `INSERT INTO jobs (name, trigger_kind, scheduled_at, state, created_at)
     VALUES ('x.tick','cron','x','completed',datetime('now','-30 days'))`,
  );
  const tx = db.transaction((n: number) => {
    for (let i = 0; i < n; i++) insert.run();
  });
  tx(6);

  const inv = jobsHistoryBoundedInvariant(db, { warnRows: 5, retentionDays: 7 });
  const before = await inv.check();
  assert.equal(before.ok, false, 'over-ceiling table fails the check');
  assert.match(before.message ?? '', /\d/);

  await inv.repair?.();

  const after = await inv.check();
  assert.equal(after.ok, true, 'repair pruned stale rows back under the ceiling');
  closeDb(db);
});

test('jobs.history_bounded: recent rows within retention are NOT pruned even above ceiling', async () => {
  const db = freshDb();
  // Recent terminal rows must survive repair: pruning is age-based, not count-based.
  const insert = db.prepare(
    `INSERT INTO jobs (name, trigger_kind, scheduled_at, state, created_at)
     VALUES ('x.tick','cron','x','completed',datetime('now','-1 day'))`,
  );
  const tx = db.transaction((n: number) => {
    for (let i = 0; i < n; i++) insert.run();
  });
  tx(6);

  const inv = jobsHistoryBoundedInvariant(db, { warnRows: 5, retentionDays: 7 });
  assert.equal((await inv.check()).ok, false);
  await inv.repair?.();
  // Still over ceiling — the rows are recent, so age-based pruning keeps them.
  assert.equal((await inv.check()).ok, false, 'recent rows survive; ceiling stays tripped');
  closeDb(db);
});

test('jobs.history_bounded: small table reports ok', async () => {
  const db = freshDb();
  const inv = jobsHistoryBoundedInvariant(db);
  const r = await inv.check();
  assert.equal(r.ok, true);
  closeDb(db);
});
