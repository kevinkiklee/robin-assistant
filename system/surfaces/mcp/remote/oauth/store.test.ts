import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type TestContext, test } from 'node:test';
import { closeDb, openDb, type RobinDb } from '../../../../brain/memory/db.ts';
import { allMigrations, applyMigrations } from '../../../../brain/memory/migrations/index.ts';
import {
  issueCode,
  issueTokens,
  redeemCode,
  redeemRefreshToken,
  registerClient,
  verifyAccessToken,
} from './store.ts';

const RESOURCE = 'https://mcp.example.com/mcp';
const REDIRECT = 'https://claude.ai/api/mcp/auth_callback';

function db(t: TestContext): RobinDb {
  const dir = mkdtempSync(join(tmpdir(), 'robin-oauth-'));
  mkdirSync(join(dir, 'state', 'db'), { recursive: true });
  const handle = openDb(join(dir, 'state', 'db', 'robin.sqlite'));
  applyMigrations(handle, allMigrations);
  t.after(() => closeDb(handle));
  return handle;
}

/** A PKCE pair, built the way a real client does. */
function pkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
}

function newClient(handle: RobinDb): string {
  return registerClient(handle, { clientName: 'claude', redirectUris: [REDIRECT] }).client_id;
}

function authorized(handle: RobinDb, clientId: string, challenge: string): string {
  return issueCode(handle, {
    clientId,
    redirectUri: REDIRECT,
    codeChallenge: challenge,
    resource: RESOURCE,
    scope: 'robin:read',
  });
}

test('oauth: a registered client round-trips with its redirect URIs', (t) => {
  const handle = db(t);
  const client = registerClient(handle, { clientName: 'claude', redirectUris: [REDIRECT] });
  assert.ok(client.client_id.length >= 16, 'client_id must not be guessable');
  assert.deepEqual(client.redirect_uris, [REDIRECT]);
  // Public client: Claude registers via DCR and authenticates with PKCE, not a secret.
  assert.equal(client.token_endpoint_auth_method, 'none');
});

test('oauth: the happy path yields a token that verifies for its resource', (t) => {
  const handle = db(t);
  const clientId = newClient(handle);
  const { verifier, challenge } = pkce();
  const code = authorized(handle, clientId, challenge);

  const redeemed = redeemCode(handle, {
    code,
    clientId,
    redirectUri: REDIRECT,
    codeVerifier: verifier,
  });
  assert.ok('resource' in redeemed, 'a correct redemption must succeed');

  const tokens = issueTokens(handle, { clientId, resource: RESOURCE, scope: 'robin:read' });
  const auth = verifyAccessToken(handle, tokens.access_token, RESOURCE);
  assert.ok(auth, 'the freshly issued token must verify');
  assert.equal(auth?.clientId, clientId);
});

test('oauth: a wrong PKCE verifier is refused', (t) => {
  const handle = db(t);
  const clientId = newClient(handle);
  const { challenge } = pkce();
  const code = authorized(handle, clientId, challenge);

  const result = redeemCode(handle, {
    code,
    clientId,
    redirectUri: REDIRECT,
    codeVerifier: pkce().verifier, // a different verifier entirely
  });
  assert.ok('error' in result, 'PKCE mismatch must not yield a token');
});

test('oauth: an authorization code cannot be redeemed twice', (t) => {
  const handle = db(t);
  const clientId = newClient(handle);
  const { verifier, challenge } = pkce();
  const code = authorized(handle, clientId, challenge);
  const args = { code, clientId, redirectUri: REDIRECT, codeVerifier: verifier };

  assert.ok('resource' in redeemCode(handle, args));
  // Replay: an intercepted code must be worthless once spent.
  assert.ok('error' in redeemCode(handle, args), 'a spent code must be refused');
});

test('oauth: a code redeemed against a different redirect URI is refused', (t) => {
  const handle = db(t);
  const clientId = newClient(handle);
  const { verifier, challenge } = pkce();
  const code = authorized(handle, clientId, challenge);

  const result = redeemCode(handle, {
    code,
    clientId,
    redirectUri: 'https://attacker.example/callback',
    codeVerifier: verifier,
  });
  assert.ok('error' in result, 'redirect_uri must match the one the code was issued for');
});

test('oauth: a token minted for another resource does not verify', (t) => {
  const handle = db(t);
  const clientId = newClient(handle);
  const tokens = issueTokens(handle, { clientId, resource: 'https://elsewhere.example/mcp' });
  // Audience binding: this is what stops a token issued for another service from
  // being replayed against Robin.
  assert.equal(verifyAccessToken(handle, tokens.access_token, RESOURCE), null);
});

test('oauth: an expired access token does not verify', (t) => {
  const handle = db(t);
  const clientId = newClient(handle);
  const tokens = issueTokens(handle, { clientId, resource: RESOURCE, expiresInSeconds: -1 });
  assert.equal(verifyAccessToken(handle, tokens.access_token, RESOURCE), null);
});

test('oauth: a garbage token does not verify', (t) => {
  const handle = db(t);
  assert.equal(verifyAccessToken(handle, 'not-a-real-token', RESOURCE), null);
});

test('oauth: refreshing rotates, and the old refresh token stops working', (t) => {
  const handle = db(t);
  const clientId = newClient(handle);
  const first = issueTokens(handle, { clientId, resource: RESOURCE });
  assert.ok(first.refresh_token);

  const second = redeemRefreshToken(handle, {
    refreshToken: first.refresh_token as string,
    clientId,
  });
  assert.ok(second && 'access_token' in second, 'a valid refresh must issue a new token');
  assert.notEqual(second?.access_token, first.access_token);

  // OAuth 2.1 requires rotation for public clients: replaying the spent refresh
  // token must fail, which is how a stolen one gets detected.
  const replay = redeemRefreshToken(handle, {
    refreshToken: first.refresh_token as string,
    clientId,
  });
  assert.equal(replay, null, 'a rotated refresh token must not be reusable');
});

test('oauth: nothing usable is stored in plaintext', (t) => {
  const handle = db(t);
  const clientId = newClient(handle);
  const { challenge } = pkce();
  const code = authorized(handle, clientId, challenge);
  const tokens = issueTokens(handle, { clientId, resource: RESOURCE });

  const dump = JSON.stringify([
    handle.prepare('SELECT * FROM oauth_codes').all(),
    handle.prepare('SELECT * FROM oauth_tokens').all(),
  ]);
  // A read of the DB must not hand over anything replayable against the endpoint.
  assert.ok(!dump.includes(code), 'the authorization code must be stored hashed');
  assert.ok(!dump.includes(tokens.access_token), 'the access token must be stored hashed');
  assert.ok(
    !dump.includes(tokens.refresh_token as string),
    'the refresh token must be stored hashed',
  );
});

test('oauth: an empty resource is stored as absent, never as an empty audience', (t) => {
  const handle = db(t);
  const clientId = newClient(handle);
  const { challenge } = pkce();
  issueCode(handle, { clientId, redirectUri: REDIRECT, codeChallenge: challenge, resource: '' });
  issueTokens(handle, { clientId, resource: '' });
  const codes = handle.prepare('SELECT resource FROM oauth_codes').all() as Array<{
    resource: string | null;
  }>;
  const tokens = handle.prepare('SELECT resource FROM oauth_tokens').all() as Array<{
    resource: string | null;
  }>;
  assert.deepEqual(
    [...codes, ...tokens].map((r) => r.resource),
    [null, null],
  );
});

test('oauth: a legacy token with an empty audience fails closed', (t) => {
  const handle = db(t);
  const clientId = newClient(handle);
  const tokens = issueTokens(handle, { clientId, resource: RESOURCE });
  // A row written before empty-means-absent: '' used to skip the audience check.
  handle.prepare("UPDATE oauth_tokens SET resource = ''").run();
  assert.equal(verifyAccessToken(handle, tokens.access_token, RESOURCE), null);
  // And it can't be laundered into a fresh, unbound token by refreshing it.
  assert.equal(
    redeemRefreshToken(handle, { refreshToken: tokens.refresh_token as string, clientId }),
    null,
  );
});
