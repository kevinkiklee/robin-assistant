import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import {
  buildAuthUrl,
  ensureFreshToken,
  exchangeCode,
  generatePKCE,
  PROVIDERS,
  refreshAccessToken,
} from '../../src/integrations/_auth/oauth2.js';

test('PROVIDERS registry has google, spotify, whoop', () => {
  assert.ok(PROVIDERS.google);
  assert.ok(PROVIDERS.spotify);
  assert.ok(PROVIDERS.whoop);
});

test('PROVIDERS rotation flags', () => {
  assert.equal(PROVIDERS.google.rotatesRefreshToken, false);
  assert.equal(PROVIDERS.spotify.rotatesRefreshToken, true);
  assert.equal(PROVIDERS.whoop.rotatesRefreshToken, true);
});

test('unknown provider throws', () => {
  assert.throws(() => buildAuthUrl({ provider: 'nope', scopes: [], challenge: 'c', state: 's' }));
});

test('buildAuthUrl includes PKCE + provider extraAuthParams (google access_type/prompt)', () => {
  const url = buildAuthUrl({
    provider: 'google',
    scopes: ['s1', 's2'],
    challenge: 'chal',
    state: 'st',
    secrets: { GOOGLE_OAUTH_CLIENT_ID: 'cid' },
  });
  assert.match(url, /code_challenge=chal/);
  assert.match(url, /code_challenge_method=S256/);
  assert.match(url, /access_type=offline/);
  assert.match(url, /prompt=consent/);
  assert.match(url, /client_id=cid/);
});

test('buildAuthUrl for spotify lacks google-specific params', () => {
  const url = buildAuthUrl({
    provider: 'spotify',
    scopes: ['s1'],
    challenge: 'c',
    state: 'st',
    secrets: { SPOTIFY_CLIENT_ID: 'sid' },
  });
  assert.doesNotMatch(url, /access_type=offline/);
  assert.doesNotMatch(url, /prompt=consent/);
  assert.match(url, /client_id=sid/);
});

test('exchangeCode posts to provider tokenUrl and parses response', async () => {
  const calls = [];
  const fakeFetch = mock.fn(async (url) => {
    calls.push(url);
    return {
      ok: true,
      json: async () => ({
        access_token: 'a',
        refresh_token: 'r',
        expires_in: 3600,
        token_type: 'Bearer',
        scope: 's',
      }),
    };
  });
  const r = await exchangeCode({
    provider: 'spotify',
    code: 'cd',
    verifier: 'v',
    secrets: { SPOTIFY_CLIENT_ID: 'c', SPOTIFY_CLIENT_SECRET: 's' },
    fetchFn: fakeFetch,
  });
  assert.equal(calls[0], 'https://accounts.spotify.com/api/token');
  assert.equal(r.access_token, 'a');
  assert.equal(r.refresh_token, 'r');
  assert.ok(r.expires_at > Date.now());
});

test('refreshAccessToken returns new access_token + expires_at (google, no rotation)', async () => {
  const fakeFetch = mock.fn(async () => ({
    ok: true,
    json: async () => ({ access_token: 'a2', expires_in: 3600 }),
  }));
  const r = await refreshAccessToken({
    provider: 'google',
    refresh_token: 'r',
    secrets: { GOOGLE_OAUTH_CLIENT_ID: 'c', GOOGLE_OAUTH_CLIENT_SECRET: 's' },
    fetchFn: fakeFetch,
  });
  assert.equal(r.access_token, 'a2');
  assert.equal(r.refresh_token, undefined);
});

test('refreshAccessToken returns refresh_token when provider rotates (spotify)', async () => {
  const fakeFetch = mock.fn(async () => ({
    ok: true,
    json: async () => ({ access_token: 'a2', refresh_token: 'r2', expires_in: 3600 }),
  }));
  const r = await refreshAccessToken({
    provider: 'spotify',
    refresh_token: 'r',
    secrets: { SPOTIFY_CLIENT_ID: 'c', SPOTIFY_CLIENT_SECRET: 's' },
    fetchFn: fakeFetch,
  });
  assert.equal(r.refresh_token, 'r2');
});

test('ensureFreshToken reads refresh_token from secrets via provider env key', async () => {
  const fakeFetch = mock.fn(async () => ({
    ok: true,
    json: async () => ({ access_token: 'a', expires_in: 3600 }),
  }));
  const r = await ensureFreshToken(
    'google',
    {
      GOOGLE_OAUTH_REFRESH_TOKEN: 'r-token',
      GOOGLE_OAUTH_CLIENT_ID: 'c',
      GOOGLE_OAUTH_CLIENT_SECRET: 's',
    },
    { fetchFn: fakeFetch },
  );
  assert.ok(r.access_token);
});

test('PKCE verifier+challenge are base64url', () => {
  const { verifier, challenge } = generatePKCE();
  assert.match(verifier, /^[A-Za-z0-9_-]+$/);
  assert.match(challenge, /^[A-Za-z0-9_-]+$/);
});
