import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { TimeoutError, withTimeout } from './with-timeout.ts';

test('withTimeout: resolves when promise completes before timeout', async () => {
  const result = await withTimeout(Promise.resolve('ok'), 1000, 'noop');
  assert.equal(result, 'ok');
});

test('withTimeout: rejects with TimeoutError when promise exceeds budget', async () => {
  const slow = sleep(200).then(() => 'late');
  await assert.rejects(withTimeout(slow, 50, 'slow-op'), (err: unknown) => {
    assert.ok(err instanceof TimeoutError);
    assert.equal((err as TimeoutError).opName, 'slow-op');
    assert.equal((err as TimeoutError).ms, 50);
    return true;
  });
});

test('withTimeout: forwards original rejection unchanged', async () => {
  const rejecting = Promise.reject(new Error('original'));
  await assert.rejects(withTimeout(rejecting, 1000, 'wraps'), /original/);
});

test('withTimeout: validates positive finite ms', () => {
  assert.throws(() => withTimeout(Promise.resolve(1), 0, 'op'), /positive finite/);
  assert.throws(() => withTimeout(Promise.resolve(1), -1, 'op'), /positive finite/);
  assert.throws(() => withTimeout(Promise.resolve(1), Number.NaN, 'op'), /positive finite/);
});
