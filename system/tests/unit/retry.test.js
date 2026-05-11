import assert from 'node:assert/strict';
import { test } from 'node:test';
import { retryWithBackoff } from '../../runtime/daemon/retry.js';

test('returns immediately on first-attempt success', async () => {
  let calls = 0;
  const result = await retryWithBackoff(
    async () => {
      calls++;
      return 'ok';
    },
    { attempts: 3, perAttemptTimeoutMs: 1000, backoffMs: [10, 10, 0] },
  );
  assert.equal(result, 'ok');
  assert.equal(calls, 1);
});

test('retries up to attempts and returns the eventual success', async () => {
  let calls = 0;
  const result = await retryWithBackoff(
    async () => {
      calls++;
      if (calls < 3) throw new Error(`fail ${calls}`);
      return 'eventually';
    },
    { attempts: 3, perAttemptTimeoutMs: 1000, backoffMs: [10, 10, 0] },
  );
  assert.equal(result, 'eventually');
  assert.equal(calls, 3);
});

test('throws the last error after exhausting attempts', async () => {
  let calls = 0;
  await assert.rejects(
    () =>
      retryWithBackoff(
        async () => {
          calls++;
          throw new Error(`fail ${calls}`);
        },
        { attempts: 3, perAttemptTimeoutMs: 1000, backoffMs: [10, 10, 0] },
      ),
    /fail 3/,
  );
  assert.equal(calls, 3);
});

test('honors per-attempt timeout', async () => {
  await assert.rejects(
    () =>
      retryWithBackoff(
        async () => {
          await new Promise((r) => setTimeout(r, 200));
          return 'too late';
        },
        { attempts: 1, perAttemptTimeoutMs: 50, backoffMs: [0] },
      ),
    /timeout/i,
  );
});

test('invokes onRetry between attempts', async () => {
  const events = [];
  await assert.rejects(() =>
    retryWithBackoff(
      async () => {
        throw new Error('boom');
      },
      {
        attempts: 3,
        perAttemptTimeoutMs: 1000,
        backoffMs: [10, 10, 0],
        onRetry: (err, attempt) => events.push({ msg: err.message, attempt }),
      },
    ),
  );
  assert.equal(events.length, 2); // 2 retry events between 3 attempts
  assert.equal(events[0].attempt, 1);
  assert.equal(events[1].attempt, 2);
});
