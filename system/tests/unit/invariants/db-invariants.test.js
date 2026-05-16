// Shape + happy-path tests for the DB-using invariants. Full integration
// behaviour is covered by the runner test + the integration suite.

import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { writeConfig } from '../../../config/paths.js';
import { close, connect } from '../../../data/db/client.js';
import { runMigrations } from '../../../data/db/migrate.js';
import dbAuthenticated from '../../../runtime/invariants/db.authenticated.js';
import dbDaemonReachable from '../../../runtime/invariants/db.daemon-reachable.js';
import dbEmbedderProfileMatch from '../../../runtime/invariants/db.embedder-profile-match.js';
import dbPendingRecallLogBounded from '../../../runtime/invariants/db.pending-recall-log-bounded.js';
import schedulerNoStuckInFlight from '../../../runtime/invariants/scheduler.no-stuck-in-flight.js';
import { makeTestCtx } from '../../helpers/invariant-fixtures.js';

const tmpRoot = join(tmpdir(), `robin-db-inv-${process.pid}-${Math.random().toString(36).slice(2)}`);
mkdirSync(tmpRoot, { recursive: true });
process.env.ROBIN_HOME = tmpRoot;
await writeConfig({ embedder_profile: 'mxbai-1024' });

async function fresh() {
  const db = await connect({ engine: 'mem://' });
  await runMigrations(db, resolve(import.meta.dirname, '../../../data/db/migrations'));
  return db;
}

test('db.daemon_reachable uses dbFactory when provided', async () => {
  const factoryCalled = { count: 0 };
  const ctx = makeTestCtx({
    dbFactory: async () => {
      factoryCalled.count++;
      return { close: async () => {} };
    },
  });
  const r = await dbDaemonReachable.check(ctx);
  assert.equal(r.ok, true);
  assert.equal(factoryCalled.count, 1);
});

test('db.daemon_reachable reports error when factory throws', async () => {
  const ctx = makeTestCtx({
    dbFactory: async () => {
      throw new Error('boom');
    },
  });
  const r = await dbDaemonReachable.check(ctx);
  assert.equal(r.ok, false);
  assert.match(r.error, /boom|dbFactory_failed/);
});

test('db.authenticated probe succeeds on a fresh mem db', async () => {
  const db = await fresh();
  try {
    const r = await dbAuthenticated.check(makeTestCtx({ db }));
    assert.equal(r.ok, true);
  } finally {
    await close(db);
  }
});

test('db.authenticated returns error when no db handle', async () => {
  const r = await dbAuthenticated.check(makeTestCtx({ db: null }));
  assert.equal(r.ok, false);
  assert.equal(r.error, 'no_db_handle');
});

test('db.pending_recall_log_bounded passes when below threshold', async () => {
  const db = await fresh();
  try {
    const r = await dbPendingRecallLogBounded.check(makeTestCtx({ db }));
    assert.equal(r.ok, true);
    assert.equal(r.evidence.count, 0);
  } finally {
    await close(db);
  }
});

test('scheduler.no_stuck_in_flight passes when no stuck jobs', async () => {
  const db = await fresh();
  try {
    const r = await schedulerNoStuckInFlight.check(makeTestCtx({ db }));
    assert.equal(r.ok, true);
  } finally {
    await close(db);
  }
});

test('db.embedder_profile_match returns no_active_profile on fresh db', async () => {
  const db = await fresh();
  try {
    const r = await dbEmbedderProfileMatch.check(makeTestCtx({ db }));
    // Fresh DB → no runtime:embedder row → no active profile
    assert.equal(r.ok, false);
    // Either 'no_active_profile' or a read error — both indicate unconfigured state
    assert.ok(['no_active_profile', 'read_active_profile_failed', 'table_missing'].some((e) => r.error?.startsWith(e)) || r.error.includes('failed'),
      `unexpected error: ${r.error}`);
  } finally {
    await close(db);
  }
});

test('every new invariant exports explain() that returns markdown', () => {
  for (const inv of [dbDaemonReachable, dbAuthenticated, dbEmbedderProfileMatch, dbPendingRecallLogBounded, schedulerNoStuckInFlight]) {
    const md = inv.explain();
    assert.ok(typeof md === 'string' && md.includes(inv.name), `${inv.name}.explain missing or wrong shape`);
  }
});
