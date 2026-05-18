import test from 'node:test';
import assert from 'node:assert';
import { sendWithRetry } from '../../io/integrations/discord/sender.js';

// `sleep: () => Promise.resolve()` keeps these tests under a millisecond
// each by skipping the exponential-backoff wait. The retry logic still
// runs (loop count, attempt counter, 429 detection); only the wall-clock
// sleep is bypassed.

test('sendWithRetry succeeds on first try when sendFn returns ok', async () => {
  const sendFn = async () => ({ ok: true });
  const r = await sendWithRetry('msg', sendFn, { sleep: () => Promise.resolve() });
  assert.deepStrictEqual(r, { ok: true });
});

test('sendWithRetry retries on 429 up to 3 attempts', async () => {
  let calls = 0;
  const sendFn = async () => {
    calls++;
    const e = new Error('rate limited');
    e.code = 429;
    throw e;
  };
  await assert.rejects(
    sendWithRetry('msg', sendFn, { sleep: () => Promise.resolve() }),
    /rate_limited/,
  );
  assert.strictEqual(calls, 3);
});

test('sendWithRetry succeeds on 2nd attempt after a single 429', async () => {
  let calls = 0;
  const sendFn = async () => {
    calls++;
    if (calls === 1) {
      const e = new Error('rate limited');
      e.code = 429;
      throw e;
    }
    return { ok: true };
  };
  const r = await sendWithRetry('msg', sendFn, { sleep: () => Promise.resolve() });
  assert.strictEqual(calls, 2);
  assert.deepStrictEqual(r, { ok: true });
});

test('sendWithRetry honors Retry-After header (in seconds) over backoff floor', async () => {
  const waits = [];
  let calls = 0;
  const sendFn = async () => {
    calls++;
    if (calls === 1) {
      const e = new Error('rate limited');
      e.status = 429;
      e.headers = { 'retry-after': '2' }; // 2 seconds → 2000ms
      throw e;
    }
    return { ok: true };
  };
  const sleep = (ms) => {
    waits.push(ms);
    return Promise.resolve();
  };
  await sendWithRetry('msg', sendFn, { sleep });
  assert.strictEqual(calls, 2);
  assert.strictEqual(waits.length, 1);
  // 2000ms Retry-After should win against the ~500ms jittered backoff.
  assert.ok(waits[0] >= 2000, `expected >= 2000ms wait, got ${waits[0]}`);
});

test('sendWithRetry re-throws non-429 errors without retrying', async () => {
  let calls = 0;
  const sendFn = async () => {
    calls++;
    const e = new Error('upstream broken');
    e.code = 500;
    throw e;
  };
  await assert.rejects(
    sendWithRetry('msg', sendFn, { sleep: () => Promise.resolve() }),
    /upstream broken/,
  );
  assert.strictEqual(calls, 1, 'non-429 should not retry');
});
