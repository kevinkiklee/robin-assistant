import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getAccessToken, runAuthCodeFlow, getProvider } from '../../scripts/sync/lib/oauth.js';

function workspace() {
  const ws = mkdtempSync(join(tmpdir(), 'oauth-'));
  mkdirSync(join(ws, 'user-data/runtime/secrets'), { recursive: true });
  mkdirSync(join(ws, 'user-data/runtime/state/sync'), { recursive: true });
  return ws;
}

function writeEnv(ws, kv) {
  const lines = Object.entries(kv).map(([k, v]) => `${k}=${v}`).join('\n') + '\n';
  writeFileSync(join(ws, 'user-data/runtime/secrets/.env'), lines);
}

function fakeFetch(responses) {
  let i = 0;
  return async () => {
    const r = responses[i++];
    if (!r) throw new Error('fakeFetch: no more responses');
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      headers: new Map(),
      json: async () => r.json,
      text: async () => JSON.stringify(r.json),
    };
  };
}

test('getProvider returns config for google and spotify', () => {
  assert.equal(getProvider('google').refreshTokenEnv, 'GOOGLE_OAUTH_REFRESH_TOKEN');
  assert.equal(getProvider('spotify').refreshTokenEnv, 'SPOTIFY_REFRESH_TOKEN');
});

test('getProvider throws on unknown provider', () => {
  assert.throws(() => getProvider('nope'), /Unknown OAuth provider: nope/);
});

test('getAccessToken returns cached token when not expired', async () => {
  const ws = workspace();
  writeEnv(ws, {
    GOOGLE_OAUTH_REFRESH_TOKEN: 'rt-1',
    GOOGLE_OAUTH_CLIENT_ID: 'cid',
    GOOGLE_OAUTH_CLIENT_SECRET: 'csec',
  });
  // Pre-seed state with a fresh access token
  const futureExpiry = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  writeFileSync(
    join(ws, 'user-data/runtime/state/sync/google.json'),
    JSON.stringify({ access_token: 'cached-token', access_token_expires_at: futureExpiry }) + '\n'
  );
  // fakeFetch with no responses — call should not hit network
  const fetch = fakeFetch([]);
  const token = await getAccessToken(ws, 'google', { fetch });
  assert.equal(token, 'cached-token');
  rmSync(ws, { recursive: true });
});

test('getAccessToken refreshes when access token expired', async () => {
  const ws = workspace();
  writeEnv(ws, {
    GOOGLE_OAUTH_REFRESH_TOKEN: 'rt-1',
    GOOGLE_OAUTH_CLIENT_ID: 'cid',
    GOOGLE_OAUTH_CLIENT_SECRET: 'csec',
  });
  const pastExpiry = new Date(Date.now() - 60 * 1000).toISOString();
  writeFileSync(
    join(ws, 'user-data/runtime/state/sync/google.json'),
    JSON.stringify({ access_token: 'old-token', access_token_expires_at: pastExpiry }) + '\n'
  );
  const fetch = fakeFetch([
    { status: 200, json: { access_token: 'new-token', expires_in: 3600 } },
  ]);
  const token = await getAccessToken(ws, 'google', { fetch });
  assert.equal(token, 'new-token');
  // Cached for next call
  const state = JSON.parse(readFileSync(join(ws, 'user-data/runtime/state/sync/google.json'), 'utf-8'));
  assert.equal(state.access_token, 'new-token');
  assert.equal(state.auth_status, 'ok');
  assert.ok(Date.parse(state.access_token_expires_at) > Date.now());
  rmSync(ws, { recursive: true });
});

test('getAccessToken refreshes when no cached token in state', async () => {
  const ws = workspace();
  writeEnv(ws, {
    GOOGLE_OAUTH_REFRESH_TOKEN: 'rt-1',
    GOOGLE_OAUTH_CLIENT_ID: 'cid',
    GOOGLE_OAUTH_CLIENT_SECRET: 'csec',
  });
  // No state file
  const fetch = fakeFetch([
    { status: 200, json: { access_token: 'fresh-token', expires_in: 3600 } },
  ]);
  const token = await getAccessToken(ws, 'google', { fetch });
  assert.equal(token, 'fresh-token');
  rmSync(ws, { recursive: true });
});

test('getAccessToken writes back rotated refresh token', async () => {
  const ws = workspace();
  writeEnv(ws, {
    SPOTIFY_REFRESH_TOKEN: 'rt-old',
    SPOTIFY_CLIENT_ID: 'cid',
    SPOTIFY_CLIENT_SECRET: 'csec',
  });
  const fetch = fakeFetch([
    { status: 200, json: { access_token: 'at', expires_in: 3600, refresh_token: 'rt-new' } },
  ]);
  await getAccessToken(ws, 'spotify', { fetch });
  const env = readFileSync(join(ws, 'user-data/runtime/secrets/.env'), 'utf-8');
  assert.match(env, /SPOTIFY_REFRESH_TOKEN=rt-new/);
  assert.doesNotMatch(env, /rt-old/);
  rmSync(ws, { recursive: true });
});

test('getAccessToken throws AuthError when refresh fails with no access_token in response', async () => {
  const ws = workspace();
  writeEnv(ws, {
    GOOGLE_OAUTH_REFRESH_TOKEN: 'rt-1',
    GOOGLE_OAUTH_CLIENT_ID: 'cid',
    GOOGLE_OAUTH_CLIENT_SECRET: 'csec',
  });
  const fetch = fakeFetch([
    { status: 200, json: { error: 'invalid_grant' } },
  ]);
  await assert.rejects(
    () => getAccessToken(ws, 'google', { fetch }),
    /No access_token in refresh response/
  );
  rmSync(ws, { recursive: true });
});

test('runAuthCodeFlow validates required inputs', async () => {
  await assert.rejects(
    () => runAuthCodeFlow({ provider: 'google' }),
    /clientId and clientSecret are required/
  );
  await assert.rejects(
    () => runAuthCodeFlow({ provider: 'google', clientId: 'a', clientSecret: 'b' }),
    /scopes must be a non-empty array/
  );
  await assert.rejects(
    () => runAuthCodeFlow({ provider: 'google', clientId: 'a', clientSecret: 'b', scopes: [] }),
    /scopes must be a non-empty array/
  );
});

// Note: the full localhost-callback round trip is integration-level — it needs
// a browser or simulated HTTP request to the callback. We exercise the
// validation surface here; manual smoke at setup time covers the happy path.
