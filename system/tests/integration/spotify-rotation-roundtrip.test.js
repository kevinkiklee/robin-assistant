import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import { _resetCache, getAccessToken } from '../../io/integrations/_auth/token-cache.js';

test('Spotify refresh rotation calls injected saveSecret with the new refresh_token', async () => {
  _resetCache('spotify');
  const saved = [];
  const fakeSaveSecret = (key, value) => {
    saved.push({ key, value });
  };
  let refreshCount = 0;
  const fetchFn = mock.fn(async () => {
    refreshCount += 1;
    return {
      ok: true,
      json: async () => ({
        access_token: `tok-${refreshCount}`,
        refresh_token: `r-rotated-${refreshCount}`,
        expires_in: 3600,
      }),
    };
  });

  const t1 = await getAccessToken({
    provider: 'spotify',
    secrets: {
      SPOTIFY_REFRESH_TOKEN: 'r-orig',
      SPOTIFY_CLIENT_ID: 'c',
      SPOTIFY_CLIENT_SECRET: 's',
    },
    fetchFn,
    saveSecret: fakeSaveSecret,
  });

  assert.equal(t1, 'tok-1');
  assert.deepEqual(saved, [{ key: 'SPOTIFY_REFRESH_TOKEN', value: 'r-rotated-1' }]);
});

test('subsequent Spotify refresh uses the rotated refresh_token from the prior cycle', async () => {
  _resetCache('spotify');
  const saved = [];
  const fakeSaveSecret = (key, value) => {
    saved.push({ key, value });
  };

  // Caller-managed secrets bag: simulates the dotenv-io behavior where
  // saveSecret persists the rotated value and subsequent reads see it.
  const secrets = {
    SPOTIFY_REFRESH_TOKEN: 'r-orig',
    SPOTIFY_CLIENT_ID: 'c',
    SPOTIFY_CLIENT_SECRET: 's',
  };
  const persistAndUpdate = (key, value) => {
    fakeSaveSecret(key, value);
    secrets[key] = value;
  };

  const refreshTokensReceived = [];
  const fetchFn = mock.fn(async (_url, opts) => {
    const body = opts?.body?.toString() ?? '';
    const params = new URLSearchParams(body);
    refreshTokensReceived.push(params.get('refresh_token'));
    const i = refreshTokensReceived.length;
    return {
      ok: true,
      json: async () => ({
        access_token: `tok-${i}`,
        refresh_token: `r-rotated-${i}`,
        expires_in: 3600,
      }),
    };
  });

  // First refresh: uses r-orig, returns r-rotated-1
  const t1 = await getAccessToken({
    provider: 'spotify',
    secrets,
    fetchFn,
    saveSecret: persistAndUpdate,
  });
  assert.equal(t1, 'tok-1');
  assert.equal(refreshTokensReceived[0], 'r-orig');
  assert.equal(secrets.SPOTIFY_REFRESH_TOKEN, 'r-rotated-1');

  // Force a second refresh by clearing the cache (simulates expiry).
  _resetCache('spotify');

  const t2 = await getAccessToken({
    provider: 'spotify',
    secrets,
    fetchFn,
    saveSecret: persistAndUpdate,
  });
  assert.equal(t2, 'tok-2');
  assert.equal(
    refreshTokensReceived[1],
    'r-rotated-1',
    'second refresh uses the rotated value from the first cycle',
  );
  assert.equal(secrets.SPOTIFY_REFRESH_TOKEN, 'r-rotated-2');
  assert.deepEqual(saved, [
    { key: 'SPOTIFY_REFRESH_TOKEN', value: 'r-rotated-1' },
    { key: 'SPOTIFY_REFRESH_TOKEN', value: 'r-rotated-2' },
  ]);
});
