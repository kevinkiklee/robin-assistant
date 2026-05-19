import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { closeDb, openDb } from '../../../brain/memory/db.ts';
import { allMigrations, applyMigrations } from '../../../brain/memory/migrations/index.ts';
import { runInvariants } from '../runner.ts';
import {
  daemonHeartbeatingInvariant,
  dbReachableInvariant,
  dbSchemaCurrentInvariant,
  dbWalSizeBoundedInvariant,
  userDataWritableInvariant,
} from './index.ts';

function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), 'robin-inv-'));
  mkdirSync(join(dir, 'state', 'db'), { recursive: true });
  const db = openDb(join(dir, 'state', 'db', 'robin.sqlite'));
  applyMigrations(db, allMigrations);
  return { db, dir };
}

test('builtin invariants: all pass on a fresh, healthy state', async () => {
  const { db, dir } = freshDb();
  const reports = await runInvariants([
    userDataWritableInvariant(dir),
    dbReachableInvariant(db),
    dbSchemaCurrentInvariant(db),
    dbWalSizeBoundedInvariant(db),
    daemonHeartbeatingInvariant({ lastTickAt: () => new Date(), maxIntervalMs: 60_000 }),
  ]);
  const failures = reports.filter((r) => !r.ok);
  assert.deepEqual(failures, [], `expected no failures, got ${JSON.stringify(failures)}`);
  closeDb(db);
});

test('daemon.heartbeating: fails when no tick has been recorded', async () => {
  const reports = await runInvariants([
    daemonHeartbeatingInvariant({ lastTickAt: () => null, maxIntervalMs: 1000 }),
  ]);
  assert.equal(reports[0].ok, false);
});

test('install.user_data_writable: fails on a non-existent path', async () => {
  const reports = await runInvariants([userDataWritableInvariant('/nonexistent/robin/path')]);
  assert.equal(reports[0].ok, false);
});
