import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { closeDb, openDb, type RobinDb } from '../../../brain/memory/db.ts';
import { allMigrations, applyMigrations } from '../../../brain/memory/migrations/index.ts';
import { sessionStateBoundedInvariant } from './session-state-bounded.ts';

function freshDb(): RobinDb {
  const dir = mkdtempSync(join(tmpdir(), 'robin-session-state-'));
  const db = openDb(join(dir, 'robin.sqlite'));
  applyMigrations(db, allMigrations);
  return db;
}

/** Insert a claude_code session-dedup KV row stamped `daysAgo` days ago. */
function insertSessionState(db: RobinDb, id: string, daysAgo: number): void {
  db.prepare(
    `INSERT INTO integration_state (integration_name, key, value, updated_at)
     VALUES ('claude_code', ?, '1700000000000', datetime('now', ?))`,
  ).run(`session:-:${id}`, `-${daysAgo} days`);
}

test('session-state-bounded: under ceiling → ok', async () => {
  const db = freshDb();
  for (let i = 0; i < 10; i++) insertSessionState(db, `s${i}`, 1);
  const r = await sessionStateBoundedInvariant(db, { warnRows: 100 }).check();
  assert.equal(r.ok, true, JSON.stringify(r));
  closeDb(db);
});

test('session-state-bounded: above ceiling fires; repair prunes stale rows but keeps recent', async () => {
  const db = freshDb();
  for (let i = 0; i < 60; i++) insertSessionState(db, `old${i}`, 40); // stale
  for (let i = 0; i < 20; i++) insertSessionState(db, `new${i}`, 1); // recent
  const inv = sessionStateBoundedInvariant(db, { warnRows: 50, retentionDays: 14 });

  const before = await inv.check();
  assert.equal(before.ok, false, JSON.stringify(before));
  assert.match(before.message ?? '', /80.*session-state rows/);
  assert.ok(before.remediation, 'remediation should be present');

  inv.repair?.();

  const remaining = db
    .prepare(
      "SELECT COUNT(*) AS n FROM integration_state WHERE integration_name='claude_code' AND key LIKE 'session:%'",
    )
    .get() as { n: number };
  assert.equal(remaining.n, 20, 'only the recent (within-retention) rows remain');

  const after = await inv.check();
  assert.equal(after.ok, true);
  closeDb(db);
});

test('session-state-bounded: repair is scoped to session:* keys (heartbeat rows survive)', async () => {
  const db = freshDb();
  db.prepare(
    `INSERT INTO integration_state (integration_name, key, value, updated_at)
     VALUES ('claude_code','consecutive_errors','0', datetime('now','-40 days'))`,
  ).run();
  for (let i = 0; i < 5; i++) insertSessionState(db, `old${i}`, 40);

  sessionStateBoundedInvariant(db, { retentionDays: 14 }).repair?.();

  const kept = db
    .prepare(
      "SELECT value FROM integration_state WHERE integration_name='claude_code' AND key='consecutive_errors'",
    )
    .get();
  assert.ok(kept, 'non-session bookkeeping rows must not be pruned');
  closeDb(db);
});
