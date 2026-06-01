import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { closeDb, openDb } from '../../../brain/memory/db.ts';
import { allMigrations, applyMigrations } from '../../../brain/memory/migrations/index.ts';
import { noOrphansInvariant } from './no-orphans.ts';

function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), 'robin-noorphans-'));
  const db = openDb(join(dir, 'robin.sqlite'));
  applyMigrations(db, allMigrations);
  return { db, userData: dir };
}

test('no-orphans: warns on a removed-integration tombstone, then repairs to ok', async () => {
  const { db, userData } = freshDb();
  // `github` has no directory under userData/extensions/integrations (and isn't a
  // builtin) → both its state row and its tick cron are orphans.
  db.prepare(
    `INSERT INTO integration_state (integration_name, key, value, updated_at)
     VALUES ('github', 'last_attempt_at', '2026-05-24T00:00:00Z', '2026-05-24T00:00:00Z')`,
  ).run();
  db.prepare(
    `INSERT INTO jobs (name, trigger_kind, scheduled_at, state)
     VALUES ('integration.github.tick', 'cron', '2026-05-24T00:00:00Z', 'pending')`,
  ).run();

  const inv = noOrphansInvariant(db, { userData });
  const before = await inv.check();
  assert.equal(before.ok, false);
  assert.match(before.message ?? '', /orphan/i);

  await inv.repair?.();

  const after = await inv.check();
  assert.equal(after.ok, true, 'GC repaired the github tombstone');
  const stateLeft = db
    .prepare("SELECT COUNT(*) AS n FROM integration_state WHERE integration_name = 'github'")
    .get() as { n: number };
  assert.equal(stateLeft.n, 0, 'github state rows gone');
  closeDb(db);
});

test('no-orphans: clean tree reports ok', async () => {
  const { db, userData } = freshDb();
  const inv = noOrphansInvariant(db, { userData });
  const r = await inv.check();
  assert.equal(r.ok, true);
  closeDb(db);
});
