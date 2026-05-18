// `installConnectionRecovery` is the third resilience layer in the DB
// client. The Surreal client's autoreconnect gave up overnight on 2026-05-18
// (8.5h outage, 622 failed ticks) — this layer would have rebuilt the
// connection in-process on the first failed query.
//
// Layer matrix:
//   1. installQueryCounter      — tracks .collect() in-flight count
//   2. installQueryRetry        — catches Anonymous; reauths and retries
//   3. installConnectionRecovery — catches ConnectionUnavailable; rebuilds
//
// This file exercises layer 3 against a fake db that throws on first call
// and succeeds on second.

import assert from 'node:assert';
import { test } from 'node:test';
import {
  installConnectionRecovery,
  isConnectionUnavailableError,
} from '../../data/db/client.js';

function makeFakeBuilder(behavior) {
  return {
    collect: async () => behavior(),
  };
}

function makeFakeDb({ onCollect, onRebuildSignal }) {
  const calls = { collect: 0, rebuild: 0 };
  const db = {
    calls,
    query: () =>
      makeFakeBuilder(async () => {
        calls.collect += 1;
        return onCollect(calls.collect);
      }),
  };
  const rebuild = async () => {
    calls.rebuild += 1;
    if (onRebuildSignal) onRebuildSignal(calls.rebuild);
  };
  installConnectionRecovery(db, rebuild);
  return { db, rebuild, calls };
}

test('isConnectionUnavailableError matches the v2.0.3 message', () => {
  const err = new Error(
    'You must be connected to a SurrealDB instance before performing this operation',
  );
  assert.strictEqual(isConnectionUnavailableError(err), true);
});

test('isConnectionUnavailableError matches by error name', () => {
  const err = new Error('something');
  err.name = 'ConnectionUnavailableError';
  assert.strictEqual(isConnectionUnavailableError(err), true);
});

test('isConnectionUnavailableError does not match Anonymous errors', () => {
  const err = new Error('Anonymous access not allowed: Not enough permissions');
  assert.strictEqual(isConnectionUnavailableError(err), false);
});

test('installConnectionRecovery rebuilds + retries once on ConnectionUnavailable', async () => {
  const { db, calls } = makeFakeDb({
    onCollect: (n) => {
      if (n === 1) {
        throw new Error(
          'You must be connected to a SurrealDB instance before performing this operation',
        );
      }
      return [['ok']];
    },
  });
  const result = await db.query('RETURN 1;').collect();
  assert.deepEqual(result, [['ok']]);
  assert.strictEqual(calls.collect, 2, 'expected 2 collect calls (initial + retry)');
  assert.strictEqual(calls.rebuild, 1, 'expected 1 rebuild');
});

test('installConnectionRecovery does not retry on non-connection errors', async () => {
  const { db, calls } = makeFakeDb({
    onCollect: () => {
      throw new Error('something completely unrelated');
    },
  });
  await assert.rejects(
    () => db.query('RETURN 1;').collect(),
    /something completely unrelated/,
  );
  assert.strictEqual(calls.collect, 1);
  assert.strictEqual(calls.rebuild, 0);
});

test('installConnectionRecovery re-throws if retry also fails', async () => {
  const { db, calls } = makeFakeDb({
    onCollect: () => {
      throw new Error(
        'You must be connected to a SurrealDB instance before performing this operation',
      );
    },
  });
  await assert.rejects(
    () => db.query('RETURN 1;').collect(),
    /must be connected to a SurrealDB instance/,
  );
  // Initial + retry, both fail. Rebuild ran once. The retry's failure
  // propagates without triggering a second rebuild — the layer retries
  // exactly once.
  assert.strictEqual(calls.collect, 2);
  assert.strictEqual(calls.rebuild, 1);
});

test('installConnectionRecovery does nothing when db.query is missing', () => {
  const db = {};
  installConnectionRecovery(db, async () => {});
  // No throw; no query wrapper installed.
  assert.strictEqual(db.query, undefined);
});
