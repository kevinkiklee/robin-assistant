import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isTxConflict, withTxRetry } from '../../cognition/memory/tx.js';

test('isTxConflict matches SurrealDB transaction-conflict error text', () => {
  assert.equal(isTxConflict(new Error('Transaction conflict: Write conflict')), true);
  assert.equal(isTxConflict(new Error('Transaction conflict: Read conflict')), true);
  assert.equal(isTxConflict(new Error('some unrelated error')), false);
  assert.equal(isTxConflict(null), false);
  assert.equal(isTxConflict(undefined), false);
  assert.equal(isTxConflict({}), false);
});

test('withTxRetry returns the fn result on first success', async () => {
  let calls = 0;
  const result = await withTxRetry(async () => {
    calls += 1;
    return 'ok';
  });
  assert.equal(result, 'ok');
  assert.equal(calls, 1);
});

test('withTxRetry retries on tx-conflict errors and succeeds', async () => {
  let calls = 0;
  const result = await withTxRetry(async () => {
    calls += 1;
    if (calls < 3) throw new Error('Transaction conflict: Write conflict');
    return calls;
  });
  assert.equal(result, 3);
  assert.equal(calls, 3);
});

test('withTxRetry re-throws non-tx-conflict errors immediately', async () => {
  let calls = 0;
  await assert.rejects(
    withTxRetry(async () => {
      calls += 1;
      throw new Error('something else');
    }),
    /something else/,
  );
  assert.equal(calls, 1);
});

test('withTxRetry gives up after maxRetries and throws the last error', async () => {
  let calls = 0;
  await assert.rejects(
    withTxRetry(
      async () => {
        calls += 1;
        throw new Error('Transaction conflict: Write conflict');
      },
      { maxRetries: 2 },
    ),
    /Transaction conflict/,
  );
  // maxRetries=2 means 1 initial + 2 retries = 3 attempts
  assert.equal(calls, 3);
});
