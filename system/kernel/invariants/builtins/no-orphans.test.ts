import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
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

test('no-orphans: does NOT flag or GC state owned by an on-disk job (feed-watch case)', async () => {
  const { db, userData } = freshDb();
  // A user JOB namespaces its cursor in the shared integration_state KV store but
  // has no integration dir — only a job dir. It must be exempted (extraLive), or
  // the check reports a phantom and --fix wipes the live cursor,
  // triggering a spurious "everything is new" duplicate-alert flood.
  const jobDir = join(userData, 'extensions/jobs', 'feed-watch');
  mkdirSync(jobDir, { recursive: true });
  writeFileSync(join(jobDir, 'job.yaml'), 'name: feed-watch\n');
  db.prepare(
    `INSERT INTO integration_state (integration_name, key, value, updated_at)
     VALUES ('feed-watch', 'cursor', '{}', '2027-02-03T00:00:00Z')`,
  ).run();

  const inv = noOrphansInvariant(db, { userData });
  const r = await inv.check();
  assert.equal(r.ok, true, 'on-disk job state is not an orphan');

  await inv.repair?.();
  const left = db
    .prepare("SELECT COUNT(*) AS n FROM integration_state WHERE integration_name = 'feed-watch'")
    .get() as { n: number };
  assert.equal(left.n, 1, 'repair preserved the live job cursor');
  closeDb(db);
});

test('no-orphans: clean tree reports ok', async () => {
  const { db, userData } = freshDb();
  const inv = noOrphansInvariant(db, { userData });
  const r = await inv.check();
  assert.equal(r.ok, true);
  closeDb(db);
});
