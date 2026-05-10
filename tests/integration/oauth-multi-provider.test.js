import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import { _resetCache, getAccessToken } from '../../src/integrations/_auth/token-cache.js';

test('parallel calls to different providers hit separate token endpoints (per-provider lock)', async () => {
  // Reset both provider caches so neither has a warm entry.
  _resetCache('google');
  _resetCache('spotify');

  let googleCalls = 0;
  let spotifyCalls = 0;
  const fetchFn = mock.fn(async (url) => {
    if (url.includes('oauth2.googleapis.com/token')) {
      googleCalls += 1;
      // Tiny delay so concurrent callers race the in-flight promise.
      await new Promise((r) => setTimeout(r, 5));
      return {
        ok: true,
        json: async () => ({ access_token: 'g-tok', expires_in: 3600 }),
      };
    }
    if (url.includes('accounts.spotify.com/api/token')) {
      spotifyCalls += 1;
      await new Promise((r) => setTimeout(r, 5));
      return {
        ok: true,
        json: async () => ({
          access_token: 's-tok',
          // Echo the same refresh_token so saveSecret is a no-op shape;
          // rotation behavior is covered in spotify-rotation-roundtrip.
          refresh_token: 'r',
          expires_in: 3600,
        }),
      };
    }
    throw new Error(`unexpected: ${url}`);
  });

  const googleSecrets = {
    GOOGLE_OAUTH_REFRESH_TOKEN: 'r',
    GOOGLE_OAUTH_CLIENT_ID: 'c',
    GOOGLE_OAUTH_CLIENT_SECRET: 's',
  };
  const spotifySecrets = {
    SPOTIFY_REFRESH_TOKEN: 'r',
    SPOTIFY_CLIENT_ID: 'c',
    SPOTIFY_CLIENT_SECRET: 's',
  };
  // Spotify rotates refresh tokens; supply a no-op saveSecret so the cache
  // doesn't try to write to ~/.robin during a unit-style integration test.
  const noopSaveSecret = () => {};

  const [g1, s1, g2, s2] = await Promise.all([
    getAccessToken({ provider: 'google', secrets: googleSecrets, fetchFn }),
    getAccessToken({
      provider: 'spotify',
      secrets: spotifySecrets,
      fetchFn,
      saveSecret: noopSaveSecret,
    }),
    getAccessToken({ provider: 'google', secrets: googleSecrets, fetchFn }),
    getAccessToken({
      provider: 'spotify',
      secrets: spotifySecrets,
      fetchFn,
      saveSecret: noopSaveSecret,
    }),
  ]);

  assert.equal(g1, 'g-tok');
  assert.equal(s1, 's-tok');
  assert.equal(g1, g2, 'google calls share the same access token');
  assert.equal(s1, s2, 'spotify calls share the same access token');
  // Per-provider dedup: one refresh per provider, NOT deduped together.
  assert.equal(googleCalls, 1, 'google refresh deduped within provider');
  assert.equal(spotifyCalls, 1, 'spotify refresh deduped within provider');
});

test('parallel calls hit two separate token endpoints (provider isolation)', async () => {
  _resetCache('google');
  _resetCache('spotify');

  const urlsHit = [];
  const fetchFn = mock.fn(async (url) => {
    urlsHit.push(url);
    if (url.includes('oauth2.googleapis.com/token')) {
      return { ok: true, json: async () => ({ access_token: 'g', expires_in: 3600 }) };
    }
    if (url.includes('accounts.spotify.com/api/token')) {
      return {
        ok: true,
        json: async () => ({ access_token: 's', refresh_token: 'r', expires_in: 3600 }),
      };
    }
    throw new Error(`unexpected: ${url}`);
  });

  await Promise.all([
    getAccessToken({
      provider: 'google',
      secrets: {
        GOOGLE_OAUTH_REFRESH_TOKEN: 'r',
        GOOGLE_OAUTH_CLIENT_ID: 'c',
        GOOGLE_OAUTH_CLIENT_SECRET: 's',
      },
      fetchFn,
    }),
    getAccessToken({
      provider: 'spotify',
      secrets: {
        SPOTIFY_REFRESH_TOKEN: 'r',
        SPOTIFY_CLIENT_ID: 'c',
        SPOTIFY_CLIENT_SECRET: 's',
      },
      fetchFn,
      saveSecret: () => {},
    }),
  ]);

  assert.equal(urlsHit.length, 2, 'each provider hits its own token endpoint');
  assert.ok(urlsHit.some((u) => u.includes('oauth2.googleapis.com/token')));
  assert.ok(urlsHit.some((u) => u.includes('accounts.spotify.com/api/token')));
});
