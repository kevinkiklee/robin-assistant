// `db.connection_alive` is the heartbeat-paced invariant that backs up the
// in-process installConnectionRecovery layer. If the probe still fails
// after that layer ran, repair() SIGTERMs self so launchctl respawns.
//
// Exercises: check() on healthy db, check() on dead WS, check() on
// undefined db, repair() in dryRun (no SIGTERM), and repair() failure
// path when process.kill throws.

import assert from 'node:assert';
import { test } from 'node:test';
import dbConnectionAlive from '../../../runtime/invariants/db.connection-alive.js';

function fakeDb(onCollect) {
  return {
    query: () => ({ collect: async () => onCollect() }),
  };
}

test('check returns ok when probe succeeds', async () => {
  const db = fakeDb(() => [[1]]);
  const result = await dbConnectionAlive.check({ db });
  assert.deepEqual(result, { ok: true });
});

test('check returns connection_unavailable on ConnectionUnavailableError', async () => {
  const db = fakeDb(() => {
    throw new Error(
      'You must be connected to a SurrealDB instance before performing this operation',
    );
  });
  const result = await dbConnectionAlive.check({ db });
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.error, 'connection_unavailable');
  assert.match(result.evidence.message, /must be connected/);
});

test('check returns probe_failed on other errors', async () => {
  const db = fakeDb(() => {
    throw new Error('something else broke');
  });
  const result = await dbConnectionAlive.check({ db });
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.error, 'probe_failed');
  assert.match(result.evidence.message, /something else broke/);
});

test('check returns no_db_handle when ctx.db is missing', async () => {
  const result = await dbConnectionAlive.check({});
  assert.deepEqual(result, { ok: false, error: 'no_db_handle' });
});

test('repair in dry-run mode reports would_sigterm_self without killing', async () => {
  const result = await dbConnectionAlive.repair({ dryRun: true });
  assert.strictEqual(result.repaired, false);
  assert.strictEqual(result.action, 'would_sigterm_self');
  assert.strictEqual(result.evidence.pid, process.pid);
});

test('repair handles process.kill throwing (sigterm_failed branch)', async () => {
  // Inject by swapping process.kill temporarily.
  const original = process.kill;
  process.kill = () => {
    throw new Error('EPERM: not permitted');
  };
  try {
    const result = await dbConnectionAlive.repair({});
    assert.strictEqual(result.repaired, false);
    assert.strictEqual(result.action, 'sigterm_failed');
    assert.match(result.evidence.message, /EPERM/);
  } finally {
    process.kill = original;
  }
});

test('invariant config: critical level, heartbeat enabled, boot disabled', () => {
  assert.strictEqual(dbConnectionAlive.level, 'critical');
  assert.strictEqual(dbConnectionAlive.runWhen.heartbeat.enabled, true);
  assert.strictEqual(dbConnectionAlive.runWhen.boot.enabled, false);
  // 60s cooldown — matches scheduler's heartbeat bucket cadence.
  assert.strictEqual(dbConnectionAlive.runWhen.heartbeat.cooldownMs, 60_000);
});

test('invariant registered in INVARIANTS array', async () => {
  const { INVARIANTS } = await import('../../../runtime/invariants/index.js');
  const found = INVARIANTS.find((i) => i.name === 'db.connection_alive');
  assert.ok(found, 'db.connection_alive should be in INVARIANTS');
  assert.strictEqual(found, dbConnectionAlive);
});
