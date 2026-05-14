import assert from 'node:assert/strict';
import { test } from 'node:test';
import { installQueryRetry, isAnonymousError, singleFlight } from '../../data/db/client.js';

const anonError = () => new Error('Anonymous access not allowed: Not enough permissions to perform this action');

// Mimics the surrealdb v2 builder shape: db.query(sql) returns a builder
// with .collect() that triggers the round-trip and may throw.
function makeFakeDb(queryFn) {
  return { query: queryFn };
}

function makeBuilder(collectImpl) {
  return { collect: collectImpl };
}

test('isAnonymousError matches the SurrealDB message substring', () => {
  assert.equal(isAnonymousError(anonError()), true);
  assert.equal(isAnonymousError(new Error('Connection refused')), false);
  assert.equal(isAnonymousError(null), false);
  assert.equal(isAnonymousError('Anonymous access not allowed: anything'), true);
});

test('singleFlight coalesces concurrent callers into one execution', async () => {
  let calls = 0;
  const f = singleFlight(async () => {
    calls += 1;
    await new Promise((r) => setTimeout(r, 5));
    return calls;
  });
  const results = await Promise.all([f(), f(), f(), f()]);
  assert.equal(calls, 1);
  assert.deepEqual(results, [1, 1, 1, 1]);
  // After settle, the next call runs fresh.
  const r2 = await f();
  assert.equal(calls, 2);
  assert.equal(r2, 2);
});

test('installQueryRetry preserves builder shape (no missing .collect)', async () => {
  const db = makeFakeDb(() => makeBuilder(async () => 'ok'));
  installQueryRetry(db, async () => {});
  const builder = db.query('SELECT 1');
  assert.equal(typeof builder.collect, 'function');
  assert.equal(await builder.collect(), 'ok');
});

test('installQueryRetry passes through successful collects unchanged', async () => {
  let collects = 0;
  const db = makeFakeDb(() =>
    makeBuilder(async () => {
      collects += 1;
      return ['result'];
    }),
  );
  let reauthed = 0;
  installQueryRetry(db, async () => {
    reauthed += 1;
  });
  const result = await db.query('SELECT 1').collect();
  assert.deepEqual(result, ['result']);
  assert.equal(collects, 1);
  assert.equal(reauthed, 0);
});

test('installQueryRetry propagates non-Anonymous errors without retry', async () => {
  let collects = 0;
  const db = makeFakeDb(() =>
    makeBuilder(async () => {
      collects += 1;
      throw new Error('syntax error at token "FROOM"');
    }),
  );
  let reauthed = 0;
  installQueryRetry(db, async () => {
    reauthed += 1;
  });
  await assert.rejects(() => db.query('FROOM events').collect(), /syntax error/);
  assert.equal(collects, 1, 'no retry on non-Anonymous error');
  assert.equal(reauthed, 0);
});

test('installQueryRetry catches Anonymous, re-auths, rebuilds query, and retries', async () => {
  let queryCalls = 0;
  let collectCalls = 0;
  const db = makeFakeDb((sql) => {
    queryCalls += 1;
    // Capture the call index for this builder so we can verify rebuild.
    const myCall = queryCalls;
    return makeBuilder(async () => {
      collectCalls += 1;
      // First builder's collect throws Anonymous; second succeeds.
      if (myCall === 1) throw anonError();
      return [`ok-call-${myCall}-${sql}`];
    });
  });
  let reauthed = 0;
  installQueryRetry(db, async () => {
    reauthed += 1;
  });
  const result = await db.query('SELECT * FROM events').collect();
  assert.equal(queryCalls, 2, 'query was rebuilt on retry');
  assert.equal(collectCalls, 2, 'collect was called on both builders');
  assert.equal(reauthed, 1, 'reauth called once');
  assert.deepEqual(result, ['ok-call-2-SELECT * FROM events']);
});

test('installQueryRetry surfaces second Anonymous error without infinite loop', async () => {
  let collectCalls = 0;
  const db = makeFakeDb(() =>
    makeBuilder(async () => {
      collectCalls += 1;
      throw anonError();
    }),
  );
  let reauthed = 0;
  installQueryRetry(db, async () => {
    reauthed += 1;
  });
  await assert.rejects(() => db.query('SELECT 1').collect(), /Anonymous access not allowed/);
  assert.equal(collectCalls, 2, 'original + one retry');
  assert.equal(reauthed, 1);
});

test('installQueryRetry under concurrent Anonymous failures triggers reauth once', async () => {
  // Simulates the daemon-wedge scenario: many scheduler ticks fail
  // simultaneously after a WebSocket drop. The single-flight reauth must
  // coalesce them.
  let recovered = false;
  const db = makeFakeDb(() =>
    makeBuilder(async () => {
      if (!recovered) throw anonError();
      return ['ok'];
    }),
  );
  let reauthed = 0;
  const reauth = singleFlight(async () => {
    reauthed += 1;
    await new Promise((r) => setTimeout(r, 5));
    recovered = true;
  });
  installQueryRetry(db, reauth);

  const results = await Promise.all([
    db.query('SELECT 1').collect(),
    db.query('SELECT 2').collect(),
    db.query('SELECT 3').collect(),
    db.query('SELECT 4').collect(),
  ]);
  assert.equal(reauthed, 1, 'reauth coalesces under concurrent failures');
  for (const r of results) assert.deepEqual(r, ['ok']);
});

test('installQueryRetry tolerates non-builder return values (defensive)', async () => {
  // If a future version of surrealdb returns a non-builder, we should
  // pass it through unchanged rather than crashing.
  const db = makeFakeDb(() => 'not-a-builder');
  installQueryRetry(db, async () => {});
  assert.equal(db.query('anything'), 'not-a-builder');
});
