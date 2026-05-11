import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import { _resetCache, getAccessToken } from '../../src/integrations/_auth/token-cache.js';

function googleSecrets() {
  return {
    GOOGLE_OAUTH_REFRESH_TOKEN: 'r',
    GOOGLE_OAUTH_CLIENT_ID: 'c',
    GOOGLE_OAUTH_CLIENT_SECRET: 's',
  };
}
function spotifySecrets() {
  return {
    SPOTIFY_REFRESH_TOKEN: 'r-sp',
    SPOTIFY_CLIENT_ID: 'c-sp',
    SPOTIFY_CLIENT_SECRET: 's-sp',
  };
}

test('getAccessToken caches per-provider', async () => {
  _resetCache();
  let calls = 0;
  const fakeFetch = mock.fn(async () => {
    calls += 1;
    return { ok: true, json: async () => ({ access_token: `tok-${calls}`, expires_in: 3600 }) };
  });
  const t1 = await getAccessToken({
    provider: 'google',
    secrets: googleSecrets(),
    fetchFn: fakeFetch,
  });
  const t2 = await getAccessToken({
    provider: 'spotify',
    secrets: spotifySecrets(),
    fetchFn: fakeFetch,
  });
  assert.notEqual(t1, t2);
  assert.equal(calls, 2);
});

test('within-TTL hit returns cached', async () => {
  _resetCache();
  let calls = 0;
  const fakeFetch = mock.fn(async () => {
    calls += 1;
    return { ok: true, json: async () => ({ access_token: 'a', expires_in: 3600 }) };
  });
  await getAccessToken({ provider: 'google', secrets: googleSecrets(), fetchFn: fakeFetch });
  await getAccessToken({ provider: 'google', secrets: googleSecrets(), fetchFn: fakeFetch });
  assert.equal(calls, 1);
});

test('refresh-promise dedup is per-provider', async () => {
  _resetCache();
  let calls = 0;
  const fakeFetch = mock.fn(async () => {
    calls += 1;
    await new Promise((r) => setTimeout(r, 10));
    return { ok: true, json: async () => ({ access_token: `tok-${calls}`, expires_in: 3600 }) };
  });
  await Promise.all([
    getAccessToken({ provider: 'google', secrets: googleSecrets(), fetchFn: fakeFetch }),
    getAccessToken({ provider: 'google', secrets: googleSecrets(), fetchFn: fakeFetch }),
    getAccessToken({ provider: 'spotify', secrets: spotifySecrets(), fetchFn: fakeFetch }),
  ]);
  assert.equal(calls, 2);
});

test('saveSecret called when provider rotates and refresh_token returned', async () => {
  _resetCache();
  const saved = [];
  const fakeFetch = mock.fn(async () => ({
    ok: true,
    json: async () => ({ access_token: 'a', refresh_token: 'new-r', expires_in: 3600 }),
  }));
  const fakeSaveSecret = (key, value) => {
    saved.push([key, value]);
  };
  await getAccessToken({
    provider: 'spotify',
    secrets: spotifySecrets(),
    fetchFn: fakeFetch,
    saveSecret: fakeSaveSecret,
  });
  assert.deepEqual(saved, [['SPOTIFY_REFRESH_TOKEN', 'new-r']]);
});

test('saveSecret NOT called when provider does not rotate', async () => {
  _resetCache();
  const saved = [];
  const fakeFetch = mock.fn(async () => ({
    ok: true,
    json: async () => ({ access_token: 'a', refresh_token: 'ignored', expires_in: 3600 }),
  }));
  const fakeSaveSecret = (key, value) => {
    saved.push([key, value]);
  };
  await getAccessToken({
    provider: 'google',
    secrets: googleSecrets(),
    fetchFn: fakeFetch,
    saveSecret: fakeSaveSecret,
  });
  assert.equal(saved.length, 0);
});

test('saveSecret failure logged but cache still populated', async () => {
  _resetCache();
  const fakeFetch = mock.fn(async () => ({
    ok: true,
    json: async () => ({ access_token: 'a-ok', refresh_token: 'new-r', expires_in: 3600 }),
  }));
  const failingSaveSecret = () => {
    throw new Error('disk full');
  };
  const t = await getAccessToken({
    provider: 'spotify',
    secrets: spotifySecrets(),
    fetchFn: fakeFetch,
    saveSecret: failingSaveSecret,
  });
  assert.equal(t, 'a-ok');
});

test('_resetCache(provider) clears one cache only', async () => {
  _resetCache();
  let calls = 0;
  const fakeFetch = mock.fn(async () => {
    calls += 1;
    return { ok: true, json: async () => ({ access_token: `tok-${calls}`, expires_in: 3600 }) };
  });
  await getAccessToken({ provider: 'google', secrets: googleSecrets(), fetchFn: fakeFetch });
  await getAccessToken({ provider: 'spotify', secrets: spotifySecrets(), fetchFn: fakeFetch });
  _resetCache('google');
  await getAccessToken({ provider: 'spotify', secrets: spotifySecrets(), fetchFn: fakeFetch }); // hits cache
  await getAccessToken({ provider: 'google', secrets: googleSecrets(), fetchFn: fakeFetch }); // re-fetches
  assert.equal(calls, 3);
});

test('unknown provider throws', async () => {
  _resetCache();
  await assert.rejects(() =>
    getAccessToken({ provider: 'nope', secrets: {}, fetchFn: async () => ({}) }),
  );
});
