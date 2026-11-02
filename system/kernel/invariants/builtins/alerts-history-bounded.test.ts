import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { closeDb, openDb } from '../../../brain/memory/db.ts';
import { allMigrations, applyMigrations } from '../../../brain/memory/migrations/index.ts';
import { alertsHistoryBoundedInvariant } from './alerts-history-bounded.ts';

function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), 'robin-alerts-bounded-'));
  const db = openDb(join(dir, 'robin.sqlite'));
  applyMigrations(db, allMigrations);
  return db;
}

/** Insert a resolved alert row with an explicit resolved_at offset. */
function insertResolved(db: ReturnType<typeof freshDb>, daysAgo: number, key: string) {
  db.prepare(
    `INSERT INTO alerts (severity, source, key, message, resolved_at)
     VALUES ('info', 'test', ?, 'msg', datetime('now', ?))`,
  ).run(key, `-${daysAgo} days`);
}

/** Insert an open (unresolved) alert row. */
function insertOpen(db: ReturnType<typeof freshDb>, key: string) {
  db.prepare(
    `INSERT INTO alerts (severity, source, key, message)
     VALUES ('info', 'test', ?, 'msg')`,
  ).run(key);
}

test('alerts.history_bounded: empty table reports ok', async () => {
  const db = freshDb();
  const inv = alertsHistoryBoundedInvariant(db);
  const r = await inv.check();
  assert.equal(r.ok, true);
  closeDb(db);
});

test('alerts.history_bounded: under threshold reports ok', async () => {
  const db = freshDb();
  // Seed 3 resolved rows with a ceiling of 5.
  for (let i = 0; i < 3; i++) insertResolved(db, 60, `k${i}`);
  const inv = alertsHistoryBoundedInvariant(db, { warnRows: 5 });
  const r = await inv.check();
  assert.equal(r.ok, true);
  closeDb(db);
});

test('alerts.history_bounded: above threshold fires with count', async () => {
  const db = freshDb();
  // Seed 6 resolved rows with a ceiling of 5.
  for (let i = 0; i < 6; i++) insertResolved(db, 60, `k${i}`);
  const inv = alertsHistoryBoundedInvariant(db, { warnRows: 5, retentionDays: 30 });
  const r = await inv.check();
  assert.equal(r.ok, false, 'over-ceiling table must fail the check');
  assert.match(r.message ?? '', /6/, 'message must include the resolved row count');
  closeDb(db);
});

test('alerts.history_bounded: repair prunes old-resolved only; fresh-resolved and open rows survive', async () => {
  const db = freshDb();
  // old-resolved: 60 days ago — should be pruned (retention = 30 days)
  insertResolved(db, 60, 'old-resolved');
  // fresh-resolved: 1 day ago — within retention, must survive
  insertResolved(db, 1, 'fresh-resolved');
  // open: no resolved_at — must never be counted or pruned
  insertOpen(db, 'open-alert');

  const inv = alertsHistoryBoundedInvariant(db, { warnRows: 0, retentionDays: 30 });

  // Confirm the invariant fires before repair (warnRows=0 means any resolved row trips it).
  const before = await inv.check();
  assert.equal(before.ok, false, 'pre-repair check should fail with resolved rows present');

  await inv.repair?.();

  // old-resolved must be gone.
  const oldRow = db.prepare(`SELECT id FROM alerts WHERE key='old-resolved'`).get();
  assert.equal(oldRow, undefined, 'old-resolved row should have been pruned');

  // fresh-resolved must survive.
  const freshRow = db.prepare(`SELECT id FROM alerts WHERE key='fresh-resolved'`).get();
  assert.notEqual(freshRow, undefined, 'fresh-resolved row must survive retention window');

  // open must survive.
  const openRow = db.prepare(`SELECT id FROM alerts WHERE key='open-alert'`).get();
  assert.notEqual(openRow, undefined, 'open alert row must never be pruned');

  closeDb(db);
});

test('alerts.history_bounded: open rows are never counted toward the bound', async () => {
  const db = freshDb();
  // Seed many open rows — they must not affect the resolved count.
  for (let i = 0; i < 10; i++) insertOpen(db, `open${i}`);
  const inv = alertsHistoryBoundedInvariant(db, { warnRows: 5 });
  const r = await inv.check();
  assert.equal(r.ok, true, 'open rows must not count toward the resolved ceiling');
  closeDb(db);
});
