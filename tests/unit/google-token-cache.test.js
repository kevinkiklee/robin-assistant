import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import {
  _resetCache,
  getGoogleAccessToken,
} from '../../src/integrations/_auth/google-token-cache.js';

function fakeSecrets() {
  return {
    GOOGLE_OAUTH_REFRESH_TOKEN: 'r',
    GOOGLE_OAUTH_CLIENT_ID: 'c',
    GOOGLE_OAUTH_CLIENT_SECRET: 's',
  };
}

test('cache returns same token within TTL', async () => {
  _resetCache();
  let calls = 0;
  const fetchFn = mock.fn(async () => {
    calls += 1;
    return { ok: true, json: async () => ({ access_token: 'a1', expires_in: 3600 }) };
  });
  const t1 = await getGoogleAccessToken({ secrets: fakeSecrets(), fetchFn });
  const t2 = await getGoogleAccessToken({ secrets: fakeSecrets(), fetchFn });
  assert.equal(t1, 'a1');
  assert.equal(t2, 'a1');
  assert.equal(calls, 1);
});

test('cache dedupes concurrent refresh', async () => {
  _resetCache();
  let calls = 0;
  const fetchFn = mock.fn(async () => {
    calls += 1;
    await new Promise((r) => setTimeout(r, 10));
    return { ok: true, json: async () => ({ access_token: 'a1', expires_in: 3600 }) };
  });
  const [t1, t2, t3] = await Promise.all([
    getGoogleAccessToken({ secrets: fakeSecrets(), fetchFn }),
    getGoogleAccessToken({ secrets: fakeSecrets(), fetchFn }),
    getGoogleAccessToken({ secrets: fakeSecrets(), fetchFn }),
  ]);
  assert.equal(t1, 'a1');
  assert.equal(t2, 'a1');
  assert.equal(t3, 'a1');
  assert.equal(calls, 1);
});

test('cache refreshes when token near expiry', async () => {
  _resetCache();
  let calls = 0;
  const fetchFn = mock.fn(async () => {
    calls += 1;
    return {
      ok: true,
      json: async () => ({
        access_token: `token-${calls}`,
        expires_in: calls === 1 ? 30 : 3600,
      }),
    };
  });
  const t1 = await getGoogleAccessToken({ secrets: fakeSecrets(), fetchFn });
  // Token is below the 60s threshold, so next call refreshes
  const t2 = await getGoogleAccessToken({ secrets: fakeSecrets(), fetchFn });
  assert.equal(t1, 'token-1');
  assert.equal(t2, 'token-2');
  assert.equal(calls, 2);
});
