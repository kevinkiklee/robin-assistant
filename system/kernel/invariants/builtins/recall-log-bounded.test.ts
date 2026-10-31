import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { closeDb, openDb } from '../../../brain/memory/db.ts';
import { allMigrations, applyMigrations } from '../../../brain/memory/migrations/index.ts';
import { recallLogBoundedInvariant } from './recall-log-bounded.ts';

function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), 'robin-recall-log-bounded-'));
  const db = openDb(join(dir, 'robin.sqlite'));
  applyMigrations(db, allMigrations);
  return db;
}

function insertRow(db: ReturnType<typeof freshDb>, daysAgo: number) {
  db.prepare(
    `INSERT INTO recall_log (ts, query_hash, result_count) VALUES (datetime('now', ?), 'h', 0)`,
  ).run(`-${daysAgo} days`);
}

test('recall.history_bounded: empty table reports ok', async () => {
  const db = freshDb();
  assert.equal((await recallLogBoundedInvariant(db).check()).ok, true);
  closeDb(db);
});

test('recall.history_bounded: warns above the row ceiling', async () => {
  const db = freshDb();
  insertRow(db, 1);
  insertRow(db, 2);
  const inv = recallLogBoundedInvariant(db, { warnRows: 1 });
  const r = await inv.check();
  assert.equal(r.ok, false);
  assert.match(r.message ?? '', /2 recall_log rows/);
  closeDb(db);
});

test('recall.history_bounded: repair prunes only rows past the retention window', async () => {
  const db = freshDb();
  insertRow(db, 1);
  insertRow(db, 100);
  insertRow(db, 200);
  const inv = recallLogBoundedInvariant(db, { warnRows: 1, retentionDays: 180 });
  await inv.repair?.();
  const n = (db.prepare(`SELECT count(*) AS n FROM recall_log`).get() as { n: number }).n;
  assert.equal(n, 2, 'the 200-day-old row is gone; 1- and 100-day rows stay');
  closeDb(db);
});
