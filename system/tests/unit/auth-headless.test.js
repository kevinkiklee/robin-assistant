import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import { runHeadlessAuth } from '../../io/integrations/_auth/oauth2.js';

test('runHeadlessAuth prints URL with scopes and exchanges code', async () => {
  const prompts = [];
  const fakeFetch = mock.fn(async () => ({
    ok: true,
    json: async () => ({ access_token: 'a', refresh_token: 'r', expires_in: 3600 }),
  }));
  const r = await runHeadlessAuth({
    provider: 'google',
    scopes: ['scope1', 'scope2'],
    secrets: { GOOGLE_OAUTH_CLIENT_ID: 'cid', GOOGLE_OAUTH_CLIENT_SECRET: 'csec' },
    prompt: (s) => prompts.push(s),
    readCode: async () => 'fake-code',
    fetchFn: fakeFetch,
  });
  assert.equal(r.access_token, 'a');
  assert.equal(r.refresh_token, 'r');
  const allPrompts = prompts.join(' ');
  // The prompts include the auth URL, which embeds the requested scopes.
  assert.match(allPrompts, /scope1/);
  assert.match(allPrompts, /scope2/);
  // exchangeCode was called once via fetchFn.
  assert.equal(fakeFetch.mock.callCount(), 1);
});

test('runHeadlessAuth surfaces non-2xx exchange errors', async () => {
  const fakeFetch = mock.fn(async () => ({
    ok: false,
    status: 400,
    text: async () => 'invalid_grant',
  }));
  await assert.rejects(
    () =>
      runHeadlessAuth({
        provider: 'google',
        scopes: ['s'],
        secrets: { GOOGLE_OAUTH_CLIENT_ID: 'cid', GOOGLE_OAUTH_CLIENT_SECRET: 'csec' },
        prompt: () => {},
        readCode: async () => 'bad-code',
        fetchFn: fakeFetch,
      }),
    /exchange failed.*invalid_grant/,
  );
});

test('runHeadlessAuth works for spotify provider (no google-specific params)', async () => {
  const prompts = [];
  const fakeFetch = mock.fn(async () => ({
    ok: true,
    json: async () => ({ access_token: 'a', refresh_token: 'r', expires_in: 3600 }),
  }));
  await runHeadlessAuth({
    provider: 'spotify',
    scopes: ['user-read-private'],
    secrets: { SPOTIFY_CLIENT_ID: 'sid', SPOTIFY_CLIENT_SECRET: 'sec' },
    prompt: (s) => prompts.push(s),
    readCode: async () => 'code',
    fetchFn: fakeFetch,
  });
  const allPrompts = prompts.join(' ');
  assert.match(allPrompts, /accounts\.spotify\.com\/authorize/);
  assert.doesNotMatch(allPrompts, /access_type=offline/);
});
