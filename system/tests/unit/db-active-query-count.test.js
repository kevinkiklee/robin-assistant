// Verifies that `getActiveQueryCount()` reflects in-flight `db.query(...).collect()`
// calls. Drives the `mcp.daemon_authenticated_after_reconnect` invariant's
// "skip during workload" gate — when the counter is 0, the weekly probe runs;
// when > 0, it defers to avoid disturbing real traffic.

import assert from 'node:assert';
import test from 'node:test';
import { close, connect, getActiveQueryCount, installQueryCounter } from '../../data/db/client.js';

test('getActiveQueryCount starts at 0', () => {
  assert.strictEqual(getActiveQueryCount(), 0);
});

test('getActiveQueryCount returns to 0 after a successful query', async () => {
  const db = await connect({ engine: 'mem://' });
  try {
    const result = await db.query('RETURN 1;').collect();
    assert.deepStrictEqual(result, [1]);
    assert.strictEqual(getActiveQueryCount(), 0, 'returns to 0 after query');
  } finally {
    await close(db);
  }
});

test('getActiveQueryCount returns to 0 after a failed query', async () => {
  const db = await connect({ engine: 'mem://' });
  try {
    await assert.rejects(() => db.query('THIS IS NOT VALID SURQL ;;;').collect());
    assert.strictEqual(getActiveQueryCount(), 0, 'returns to 0 after error');
  } finally {
    await close(db);
  }
});

test('installQueryCounter increments during await and restores on success', async () => {
  // Stub db with a controllable .collect() so we can observe the counter
  // mid-flight without racing the real DB event loop.
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const stub = {
    query: () => ({
      collect: async () => {
        await gate;
        return [42];
      },
    }),
  };
  const before = getActiveQueryCount();
  installQueryCounter(stub);
  const p = stub.query('RETURN 42;').collect();
  // Counter incremented synchronously inside the wrapped collect() before
  // the first await suspends.
  assert.strictEqual(getActiveQueryCount(), before + 1, 'increments while in flight');
  release([42]);
  const result = await p;
  assert.deepStrictEqual(result, [42]);
  assert.strictEqual(getActiveQueryCount(), before, 'decrements after success');
});

test('installQueryCounter decrements on rejection', async () => {
  let releaseReject;
  const gate = new Promise((_, reject) => {
    releaseReject = reject;
  });
  const stub = {
    query: () => ({
      collect: async () => {
        await gate;
      },
    }),
  };
  const before = getActiveQueryCount();
  installQueryCounter(stub);
  const p = stub.query('RETURN 1;').collect();
  assert.strictEqual(getActiveQueryCount(), before + 1);
  releaseReject(new Error('boom'));
  await assert.rejects(p, /boom/);
  assert.strictEqual(getActiveQueryCount(), before, 'decrements after rejection');
});

test('installQueryCounter counts concurrent queries', async () => {
  const gates = [];
  const stub = {
    query: () => ({
      collect: async () => {
        await new Promise((resolve) => gates.push(resolve));
      },
    }),
  };
  const before = getActiveQueryCount();
  installQueryCounter(stub);
  const p1 = stub.query().collect();
  const p2 = stub.query().collect();
  const p3 = stub.query().collect();
  assert.strictEqual(getActiveQueryCount(), before + 3);
  // Release in any order; counter must return to baseline.
  for (const r of gates) r();
  await Promise.all([p1, p2, p3]);
  assert.strictEqual(getActiveQueryCount(), before);
});
