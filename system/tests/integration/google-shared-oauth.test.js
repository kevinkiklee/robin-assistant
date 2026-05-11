import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import { _resetCache, getAccessToken } from '../../src/integrations/_auth/token-cache.js';

test('gmail + calendar + drive share one token fetch via cache singleton', async () => {
  _resetCache('google');
  let tokenCalls = 0;
  const fetchFn = mock.fn(async (url) => {
    if (url.includes('/token')) {
      tokenCalls += 1;
      return { ok: true, json: async () => ({ access_token: 'shared-token', expires_in: 3600 }) };
    }
    return { ok: true, json: async () => ({}) };
  });
  const secrets = {
    GOOGLE_OAUTH_REFRESH_TOKEN: 'r',
    GOOGLE_OAUTH_CLIENT_ID: 'c',
    GOOGLE_OAUTH_CLIENT_SECRET: 's',
  };
  const [t1, t2, t3] = await Promise.all([
    getAccessToken({ provider: 'google', secrets, fetchFn }),
    getAccessToken({ provider: 'google', secrets, fetchFn }),
    getAccessToken({ provider: 'google', secrets, fetchFn }),
  ]);
  assert.equal(t1, 'shared-token');
  assert.equal(t2, 'shared-token');
  assert.equal(t3, 'shared-token');
  assert.equal(tokenCalls, 1);
});

test('sequential gmail + calendar + drive calls hit cache', async () => {
  _resetCache('google');
  let tokenCalls = 0;
  const fetchFn = mock.fn(async (url) => {
    if (url.includes('/token')) {
      tokenCalls += 1;
      return { ok: true, json: async () => ({ access_token: 'shared-token', expires_in: 3600 }) };
    }
    return { ok: true, json: async () => ({}) };
  });
  const secrets = {
    GOOGLE_OAUTH_REFRESH_TOKEN: 'r',
    GOOGLE_OAUTH_CLIENT_ID: 'c',
    GOOGLE_OAUTH_CLIENT_SECRET: 's',
  };
  await getAccessToken({ provider: 'google', secrets, fetchFn });
  await getAccessToken({ provider: 'google', secrets, fetchFn });
  await getAccessToken({ provider: 'google', secrets, fetchFn });
  assert.equal(tokenCalls, 1);
});
