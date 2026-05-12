import assert from 'node:assert/strict';
import { test } from 'node:test';
import { surrealEnsureRunning } from '../../runtime/cli/commands/surreal-ensure-running.js';

test('surrealEnsureRunning returns true when /health responds OK', async () => {
  const calls = [];
  const fetchFn = async (url) => {
    calls.push(url);
    return { ok: true, status: 200 };
  };
  const ready = await surrealEnsureRunning({
    bind: '127.0.0.1:18127',
    timeoutMs: 1000,
    intervalMs: 10,
    fetchFn,
  });
  assert.equal(ready, true);
  assert.equal(calls[0], 'http://127.0.0.1:18127/health');
});

test('surrealEnsureRunning retries on connection failure until ready', async () => {
  let attempt = 0;
  const fetchFn = async () => {
    attempt += 1;
    if (attempt < 3) throw new Error('ECONNREFUSED');
    return { ok: true, status: 200 };
  };
  const ready = await surrealEnsureRunning({
    bind: '127.0.0.1:8000',
    timeoutMs: 1000,
    intervalMs: 10,
    fetchFn,
  });
  assert.equal(ready, true);
  assert.equal(attempt, 3);
});

test('surrealEnsureRunning returns false on timeout', async () => {
  const fetchFn = async () => {
    throw new Error('ECONNREFUSED');
  };
  const ready = await surrealEnsureRunning({
    bind: '127.0.0.1:8000',
    timeoutMs: 100,
    intervalMs: 20,
    fetchFn,
  });
  assert.equal(ready, false);
});

test('surrealEnsureRunning returns false on non-OK responses (e.g. 5xx)', async () => {
  const fetchFn = async () => ({ ok: false, status: 503 });
  const ready = await surrealEnsureRunning({
    bind: '127.0.0.1:8000',
    timeoutMs: 100,
    intervalMs: 20,
    fetchFn,
  });
  assert.equal(ready, false);
});
