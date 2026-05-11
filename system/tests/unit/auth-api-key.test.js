import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import { validateApiKey } from '../../src/integrations/_auth/api-key.js';

test('validateApiKey hits test endpoint with header', async () => {
  const calls = [];
  const fakeFetch = mock.fn(async (url, opts) => {
    calls.push({ url, opts });
    return { ok: true, json: async () => ({ user: 'me' }) };
  });
  const r = await validateApiKey({
    baseUrl: 'https://api.example.com',
    key: 'k',
    testPath: '/me',
    fetchFn: fakeFetch,
  });
  assert.equal(r.user, 'me');
  assert.equal(calls[0].url, 'https://api.example.com/me');
  assert.equal(calls[0].opts.headers.Authorization, 'Bearer k');
});

test('validateApiKey throws on non-OK', async () => {
  const fakeFetch = mock.fn(async () => ({ ok: false, status: 401 }));
  await assert.rejects(() =>
    validateApiKey({ baseUrl: 'x', key: 'k', testPath: '/y', fetchFn: fakeFetch }),
  );
});
