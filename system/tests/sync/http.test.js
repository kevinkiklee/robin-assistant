import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchJson, AuthError } from '../../scripts/sync/lib/http.js';

function fakeFetch(responses) {
  let i = 0;
  return async () => {
    const r = responses[i++];
    if (!r) throw new Error('fakeFetch: no more responses');
    if (r.networkError) throw new Error(r.networkError);
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      headers: new Map(Object.entries(r.headers ?? {})),
      json: async () => r.json,
      text: async () => r.text ?? JSON.stringify(r.json ?? {}),
    };
  };
}

test('fetchJson returns parsed JSON on 2xx', async () => {
  const fetch = fakeFetch([{ status: 200, json: { ok: true } }]);
  const out = await fetchJson('https://x', {}, { fetch, retryDelayMs: 0 });
  assert.deepEqual(out, { ok: true });
});

test('fetchJson retries on 429 then succeeds', async () => {
  const fetch = fakeFetch([
    { status: 429, text: 'rate limited' },
    { status: 200, json: { ok: true } },
  ]);
  const out = await fetchJson('https://x', {}, { fetch, retryDelayMs: 0, maxRetries: 3 });
  assert.deepEqual(out, { ok: true });
});

test('fetchJson retries on 503 then succeeds', async () => {
  const fetch = fakeFetch([
    { status: 503, text: 'down' },
    { status: 200, json: { ok: true } },
  ]);
  const out = await fetchJson('https://x', {}, { fetch, retryDelayMs: 0, maxRetries: 3 });
  assert.deepEqual(out, { ok: true });
});

test('fetchJson throws AuthError on 401', async () => {
  const fetch = fakeFetch([{ status: 401, text: 'unauth' }]);
  await assert.rejects(
    () => fetchJson('https://x', {}, { fetch, retryDelayMs: 0 }),
    (err) => err instanceof AuthError
  );
});

test('fetchJson throws AuthError on 403', async () => {
  const fetch = fakeFetch([{ status: 403, text: 'forbidden' }]);
  await assert.rejects(
    () => fetchJson('https://x', {}, { fetch, retryDelayMs: 0 }),
    (err) => err instanceof AuthError
  );
});

test('fetchJson throws after exhausting retries', async () => {
  const fetch = fakeFetch([
    { status: 500, text: 'a' },
    { status: 500, text: 'b' },
    { status: 500, text: 'c' },
  ]);
  await assert.rejects(
    () => fetchJson('https://x', {}, { fetch, retryDelayMs: 0, maxRetries: 2 }),
    /HTTP 500/
  );
});

test('fetchJson does not retry on 4xx other than 429', async () => {
  const fetch = fakeFetch([{ status: 404, text: 'not found' }]);
  await assert.rejects(
    () => fetchJson('https://x', {}, { fetch, retryDelayMs: 0, maxRetries: 5 }),
    /HTTP 404/
  );
});
