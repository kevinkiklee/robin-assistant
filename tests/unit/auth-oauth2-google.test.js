import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import {
  buildAuthUrl,
  exchangeCode,
  generatePKCE,
  refreshAccessToken,
} from '../../src/integrations/_auth/oauth2-google.js';

test('generatePKCE produces base64url verifier+challenge', () => {
  const { verifier, challenge } = generatePKCE();
  assert.match(verifier, /^[A-Za-z0-9_-]+$/);
  assert.match(challenge, /^[A-Za-z0-9_-]+$/);
});

test('buildAuthUrl includes PKCE + offline access', () => {
  const url = buildAuthUrl({
    client_id: 'c',
    scopes: ['s1', 's2'],
    challenge: 'chal',
    state: 'st',
  });
  assert.match(url, /code_challenge=chal/);
  assert.match(url, /code_challenge_method=S256/);
  assert.match(url, /access_type=offline/);
  assert.match(url, /prompt=consent/);
});

test('exchangeCode posts to token endpoint and parses response', async () => {
  const fakeFetch = mock.fn(async () => ({
    ok: true,
    json: async () => ({
      access_token: 'a',
      refresh_token: 'r',
      expires_in: 3600,
      token_type: 'Bearer',
      scope: 's',
    }),
  }));
  const r = await exchangeCode({
    client_id: 'c',
    client_secret: 's',
    code: 'cd',
    verifier: 'v',
    fetchFn: fakeFetch,
  });
  assert.equal(r.access_token, 'a');
  assert.equal(r.refresh_token, 'r');
  assert.ok(r.expires_at > Date.now());
});

test('refreshAccessToken returns new access_token + expires_at', async () => {
  const fakeFetch = mock.fn(async () => ({
    ok: true,
    json: async () => ({ access_token: 'a2', expires_in: 3600 }),
  }));
  const r = await refreshAccessToken({
    client_id: 'c',
    client_secret: 's',
    refresh_token: 'r',
    fetchFn: fakeFetch,
  });
  assert.equal(r.access_token, 'a2');
});
