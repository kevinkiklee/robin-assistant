# Robin v2 Phase 2f Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task.

**Goal:** Generalize OAuth, ship spotify-write + headless OAuth + rate limiter, port 8 v1 read-sync integrations to v2.

**Architecture:** PROVIDERS registry pattern for OAuth (google/spotify/whoop). Per-provider token cache keyed in a Map. Per-tool rate limiter via flexible runtime row. Local-SQLite reads via better-sqlite3 transient client. Manifest preflight detects missing source files. Whoop's quiet-window mechanism extends `runIntegrationSync` to advance `next_run_at` outside an active hours range.

**Tech Stack:** Node ≥ 22, ES modules, surrealdb@^2, @huggingface/transformers, @modelcontextprotocol/sdk, discord.js@^14, **better-sqlite3@^11** (new dep). node --test, Biome.

**Spec:** `/Users/iser/workspace/robin/robin-assistant/docs/superpowers/specs/2026-05-10-robin-v2-phase-2f-design.md`.

---

## File structure

```
robin-assistant-v2/
  src/
    integrations/
      _auth/
        oauth2.js                                  # RENAME from oauth2-google.js, with PROVIDERS registry
        token-cache.js                             # RENAME from google-token-cache.js, per-provider Map
      _local/
        sqlite.js                                  # NEW (better-sqlite3 transient client)
      _framework/
        run-sync.js                                # MODIFY (quiet_window support)
        manifest-loader.js                         # MODIFY (preflight, oauth scopes union)
      gmail/sync.js + tools/                       # MODIFY (new getAccessToken signature)
      google_calendar/sync.js + tools/             # MODIFY
      google_drive/sync.js + tools/                # MODIFY
      youtube/sync.js                              # MODIFY
      weather/manifest.js + sync.js + client.js + tools/   # NEW
      ebird/manifest.js + sync.js + client.js + tools/     # NEW
      nhl/manifest.js + sync.js + client.js + tools/       # NEW
      linear/manifest.js + sync.js + client.js + tools/    # NEW
      whoop/manifest.js + sync.js + client.js + tools/     # NEW
      ga/manifest.js + sync.js + client.js + tools/        # NEW
      chrome/manifest.js + sync.js + client.js + tools/    # NEW (local SQLite)
      lrc/manifest.js + sync.js + client.js + tools/       # NEW (local SQLite)
      spotify_write/manifest.js + client.js + tools/       # NEW (tool-only)
    outbound/
      rate-limit.js                                # NEW
    cli/commands/
      auth-google.js                               # NEW (re-introduced for headless flow)
      auth-spotify.js                              # NEW
      auth-whoop.js                                # NEW
      integrations-list.js                         # MODIFY (preflight unavailable rows)
    cli/index.js                                   # MODIFY (auth dispatcher)
    daemon/
      server.js                                    # MODIFY (load 8 new integrations + spotify-write)
    install/agents-md.js                           # MODIFY (16 integrations + spotify-write outbound)
    mcp/tools/integration-run.js                   # (no change; existing tool_only_no_sync covers spotify_write)
  package.json                                     # MODIFY (better-sqlite3@^11)
  tests/
    unit/
      oauth2.test.js                               # MODIFY (rename + per-provider tests)
      token-cache.test.js                          # MODIFY (rename + per-provider)
      auth-headless.test.js                        # NEW
      auth-cli.test.js                             # NEW
      rate-limit.test.js                           # NEW
      spotify-write-tool.test.js                   # NEW
      run-sync-quiet-window.test.js                # NEW
      manifest-preflight.test.js                   # NEW
      weather-sync.test.js, weather-tool.test.js   # NEW
      ebird-sync.test.js, ebird-tool.test.js       # NEW
      nhl-sync.test.js, nhl-tools.test.js          # NEW
      linear-sync.test.js, linear-tools.test.js    # NEW
      whoop-sync.test.js, whoop-tools.test.js      # NEW
      ga-sync.test.js, ga-tool.test.js             # NEW
      chrome-sync.test.js, chrome-tools.test.js    # NEW
      lrc-sync.test.js, lrc-tool.test.js           # NEW
      gmail-tools.test.js + similar 2e tests       # MODIFY (new getAccessToken signature)
    integration/
      oauth-multi-provider.test.js                 # NEW
      spotify-rotation-roundtrip.test.js           # NEW
      whoop-quiet-window.test.js                   # NEW
      ga-scope-error.test.js                       # NEW
      chrome-snapshot.test.js                      # NEW
      integrations-list-unavailable.test.js        # NEW
      mcp-end-to-end.test.js                       # MODIFY (tool_count 31 → 44)
```

---

## Task 0: Verify v1 env var names

Files: none modified; this is a discovery task that informs §5/§6 manifests.

- [ ] **Step 1:** Grep v1's auth + sync scripts for env var names:

```bash
cd /Users/iser/workspace/robin/robin-assistant
grep -hE "process\.env\.[A-Z_]+|requireSecret\(.*?,\s*['\"][A-Z_]+['\"]\)" \
  user-data/runtime/scripts/sync-{whoop,ebird,linear,nhl,spotify,weather}.js \
  user-data/runtime/scripts/{spotify-write,github-write}.js \
  system/scripts/sync/lib/oauth.js \
  | grep -oE "[A-Z][A-Z_0-9]+" | sort -u
```

- [ ] **Step 2:** Compare output against v2's expected env var names from §6 of the spec. Document any mismatches.

- [ ] **Step 3:** If mismatches exist, choose ONE of:
  - Update v2's manifest `secrets.env_keys` to match v1 verbatim (preferred)
  - Document a rename step in the install post-message

- [ ] **Step 4:** Record findings in a comment at the top of each affected manifest:

```js
// secrets verified against v1 auth-whoop.js: matches.
```

No commit yet — findings are absorbed into Tasks 6-11 manifest definitions.

---

## Task 1: OAuth2 generalization — rename + PROVIDERS registry

**Files:**
- Rename: `src/integrations/_auth/oauth2-google.js` → `src/integrations/_auth/oauth2.js`
- Modify: file content per §2 of spec
- Rename: `tests/unit/auth-oauth2-google.test.js` → `tests/unit/oauth2.test.js`
- Modify: test content for new signature

- [ ] **Step 1: rename + update content**

```js
// src/integrations/_auth/oauth2.js
import { createServer } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';

export const PROVIDERS = {
  google: {
    tokenUrl: 'https://oauth2.googleapis.com/token',
    authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    refreshTokenEnv: 'GOOGLE_OAUTH_REFRESH_TOKEN',
    clientIdEnv: 'GOOGLE_OAUTH_CLIENT_ID',
    clientSecretEnv: 'GOOGLE_OAUTH_CLIENT_SECRET',
    rotatesRefreshToken: false,
    extraAuthParams: { access_type: 'offline', prompt: 'consent' },
  },
  spotify: {
    tokenUrl: 'https://accounts.spotify.com/api/token',
    authUrl: 'https://accounts.spotify.com/authorize',
    refreshTokenEnv: 'SPOTIFY_REFRESH_TOKEN',
    clientIdEnv: 'SPOTIFY_CLIENT_ID',
    clientSecretEnv: 'SPOTIFY_CLIENT_SECRET',
    rotatesRefreshToken: true,
    extraAuthParams: {},
  },
  whoop: {
    tokenUrl: 'https://api.prod.whoop.com/oauth/oauth2/token',
    authUrl: 'https://api.prod.whoop.com/oauth/oauth2/auth',
    refreshTokenEnv: 'WHOOP_REFRESH_TOKEN',
    clientIdEnv: 'WHOOP_CLIENT_ID',
    clientSecretEnv: 'WHOOP_CLIENT_SECRET',
    rotatesRefreshToken: true,
    extraAuthParams: {},
  },
};

function provider(name) {
  const p = PROVIDERS[name];
  if (!p) throw new Error(`unknown OAuth provider: ${name}`);
  return p;
}

const REDIRECT_PORT = 53682;
const REDIRECT_URI = `http://127.0.0.1:${REDIRECT_PORT}/callback`;

function base64url(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function generatePKCE() {
  const verifier = base64url(randomBytes(32));
  const challenge = base64url(createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

export function buildAuthUrl({ provider: providerName, scopes, challenge, state }) {
  const p = provider(providerName);
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: process.env[p.clientIdEnv] ?? '',
    redirect_uri: REDIRECT_URI,
    scope: scopes.join(' '),
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state,
    ...p.extraAuthParams,
  });
  return `${p.authUrl}?${params}`;
}

export async function exchangeCode({ provider: providerName, code, verifier, redirectUri = REDIRECT_URI, fetchFn = globalThis.fetch }) {
  const p = provider(providerName);
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    client_id: process.env[p.clientIdEnv] ?? '',
    client_secret: process.env[p.clientSecretEnv] ?? '',
    redirect_uri: redirectUri,
    code_verifier: verifier,
  });
  const r = await fetchFn(p.tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!r.ok) throw new Error(`exchange failed: ${r.status} ${await r.text()}`);
  const json = await r.json();
  return {
    access_token: json.access_token,
    refresh_token: json.refresh_token,
    expires_at: Date.now() + (json.expires_in * 1000),
    token_type: json.token_type,
    scope: json.scope,
  };
}

export async function refreshAccessToken({ provider: providerName, refresh_token, fetchFn = globalThis.fetch }) {
  const p = provider(providerName);
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token,
    client_id: process.env[p.clientIdEnv] ?? '',
    client_secret: process.env[p.clientSecretEnv] ?? '',
  });
  const r = await fetchFn(p.tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!r.ok) throw new Error(`refresh failed: ${r.status} ${await r.text()}`);
  const json = await r.json();
  return {
    access_token: json.access_token,
    expires_at: Date.now() + (json.expires_in * 1000),
    refresh_token: json.refresh_token,  // present iff provider rotates
  };
}

export async function ensureFreshToken(providerName, secrets, deps = {}) {
  const p = provider(providerName);
  const refresh_token = secrets[p.refreshTokenEnv];
  return await refreshAccessToken({ provider: providerName, refresh_token, fetchFn: deps.fetchFn });
}

// runLoopbackAuth: existing 2e implementation, parameterized by provider
export async function runLoopbackAuth({ provider: providerName, scopes, openFn, fetchFn }) {
  const p = provider(providerName);
  const { verifier, challenge } = generatePKCE();
  const state = base64url(randomBytes(16));
  const url = buildAuthUrl({ provider: providerName, scopes, challenge, state });

  return await new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const u = new URL(req.url, REDIRECT_URI);
      if (!u.pathname.startsWith('/callback')) { res.writeHead(404).end(); return; }
      const code = u.searchParams.get('code');
      const returnedState = u.searchParams.get('state');
      const err = u.searchParams.get('error');
      if (err) { res.writeHead(400).end(`Error: ${err}`); server.close(); reject(new Error(err)); return; }
      if (returnedState !== state) { res.writeHead(400).end('State mismatch'); server.close(); reject(new Error('state mismatch')); return; }
      res.writeHead(200, { 'Content-Type': 'text/html' }).end('<h1>Auth complete. You can close this tab.</h1>');
      exchangeCode({ provider: providerName, code, verifier, fetchFn })
        .then((tokens) => { server.close(); resolve(tokens); })
        .catch((e) => { server.close(); reject(e); });
    });
    server.listen(REDIRECT_PORT, '127.0.0.1', () => {
      console.log(`Open this URL in your browser:\n  ${url}`);
      if (openFn) openFn(url).catch(() => {});
    });
    server.on('error', reject);
  });
}

// runHeadlessAuth: NEW for 2f
export async function runHeadlessAuth({ provider: providerName, scopes, prompt = console.log, readCode }) {
  const p = provider(providerName);
  const { verifier, challenge } = generatePKCE();
  const state = base64url(randomBytes(16));
  const url = buildAuthUrl({ provider: providerName, scopes, challenge, state });

  prompt(`\nOpen this URL in any browser (on any machine):\n  ${url}\n`);
  prompt(`After authorizing, the browser will redirect to:`);
  prompt(`  ${REDIRECT_URI}?code=<CODE>&state=<STATE>`);
  prompt(`The page will fail to load. Copy the code= parameter.`);
  const code = await readCode();

  return await exchangeCode({ provider: providerName, code, verifier, redirectUri: REDIRECT_URI });
}
```

- [ ] **Step 2: rename + update test file**

`tests/unit/oauth2.test.js`:

```js
import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import { buildAuthUrl, ensureFreshToken, exchangeCode, generatePKCE, PROVIDERS, refreshAccessToken } from '../../src/integrations/_auth/oauth2.js';

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

test('buildAuthUrl includes provider extraAuthParams', () => {
  const url = buildAuthUrl({ provider: 'google', scopes: ['s1'], challenge: 'c', state: 'st' });
  assert.match(url, /access_type=offline/);
  assert.match(url, /prompt=consent/);
});

test('exchangeCode posts to provider tokenUrl', async () => {
  const calls = [];
  const fakeFetch = mock.fn(async (url) => {
    calls.push(url);
    return { ok: true, json: async () => ({ access_token: 'a', refresh_token: 'r', expires_in: 3600 }) };
  });
  await exchangeCode({ provider: 'spotify', code: 'cd', verifier: 'v', fetchFn: fakeFetch });
  assert.equal(calls[0], 'https://accounts.spotify.com/api/token');
});

test('refreshAccessToken returns refresh_token when provider rotates', async () => {
  const fakeFetch = mock.fn(async () => ({
    ok: true,
    json: async () => ({ access_token: 'a2', refresh_token: 'r2', expires_in: 3600 }),
  }));
  const r = await refreshAccessToken({ provider: 'spotify', refresh_token: 'r', fetchFn: fakeFetch });
  assert.equal(r.refresh_token, 'r2');
});

test('ensureFreshToken reads refresh_token from secrets via provider env key', async () => {
  const fakeFetch = mock.fn(async () => ({
    ok: true,
    json: async () => ({ access_token: 'a', expires_in: 3600 }),
  }));
  const r = await ensureFreshToken('google', { GOOGLE_OAUTH_REFRESH_TOKEN: 'r-token', GOOGLE_OAUTH_CLIENT_ID: 'c', GOOGLE_OAUTH_CLIENT_SECRET: 's' }, { fetchFn: fakeFetch });
  assert.ok(r.access_token);
});

test('PKCE verifier+challenge are base64url', () => {
  const { verifier, challenge } = generatePKCE();
  assert.match(verifier, /^[A-Za-z0-9_-]+$/);
  assert.match(challenge, /^[A-Za-z0-9_-]+$/);
});
```

- [ ] **Step 3: run + lint + commit**

```bash
cd /Users/iser/workspace/robin/robin-assistant-v2
git mv src/integrations/_auth/oauth2-google.js src/integrations/_auth/oauth2.js
# (apply edits via Edit tool)
git mv tests/unit/auth-oauth2-google.test.js tests/unit/oauth2.test.js
# (apply edits via Edit tool)
npm test -- tests/unit/oauth2.test.js
npm run lint
git add -A
git commit -m "feat(oauth): generalize oauth2-google → oauth2.js with PROVIDERS registry"
```

---

## Task 2: Token cache rename + per-provider keying

**Files:**
- Rename: `src/integrations/_auth/google-token-cache.js` → `src/integrations/_auth/token-cache.js`
- Modify: per §2 of spec
- Rename: `tests/unit/google-token-cache.test.js` → `tests/unit/token-cache.test.js`
- Modify: tests for per-provider keying + saveSecret rotation

- [ ] **Step 1: rename + replace content**

```js
// src/integrations/_auth/token-cache.js
import { saveSecret as saveSecretFn } from '../../secrets/dotenv-io.js';
import { ensureFreshToken, PROVIDERS } from './oauth2.js';

const caches = new Map();
const refreshPromises = new Map();

export async function getAccessToken({ provider, secrets, fetchFn, saveSecret = saveSecretFn }) {
  if (!PROVIDERS[provider]) throw new Error(`unknown OAuth provider: ${provider}`);
  const now = Date.now();
  const cached = caches.get(provider);
  if (cached && cached.expires_at - now > 60_000) return cached.access_token;
  if (refreshPromises.has(provider)) return refreshPromises.get(provider).then((c) => c.access_token);

  const promise = ensureFreshToken(provider, secrets, { fetchFn })
    .then((result) => {
      caches.set(provider, { access_token: result.access_token, expires_at: result.expires_at });
      if (PROVIDERS[provider].rotatesRefreshToken && result.refresh_token) {
        try {
          saveSecret(PROVIDERS[provider].refreshTokenEnv, result.refresh_token);
        } catch (e) {
          console.warn(`[token-cache] saveSecret(${PROVIDERS[provider].refreshTokenEnv}) failed: ${e.message}`);
        }
      }
      return caches.get(provider);
    })
    .finally(() => { refreshPromises.delete(provider); });
  refreshPromises.set(provider, promise);
  return (await promise).access_token;
}

export function _resetCache(provider) {
  if (provider) {
    caches.delete(provider);
    refreshPromises.delete(provider);
  } else {
    caches.clear();
    refreshPromises.clear();
  }
}
```

- [ ] **Step 2: rewrite tests**

```js
// tests/unit/token-cache.test.js
import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import { _resetCache, getAccessToken } from '../../src/integrations/_auth/token-cache.js';

function googleSecrets() {
  return { GOOGLE_OAUTH_REFRESH_TOKEN: 'r', GOOGLE_OAUTH_CLIENT_ID: 'c', GOOGLE_OAUTH_CLIENT_SECRET: 's' };
}
function spotifySecrets() {
  return { SPOTIFY_REFRESH_TOKEN: 'r-sp', SPOTIFY_CLIENT_ID: 'c-sp', SPOTIFY_CLIENT_SECRET: 's-sp' };
}

test('per-provider cache: google + spotify cached independently', async () => {
  _resetCache();
  let calls = 0;
  const fakeFetch = mock.fn(async () => {
    calls += 1;
    return { ok: true, json: async () => ({ access_token: `tok-${calls}`, expires_in: 3600 }) };
  });
  const t1 = await getAccessToken({ provider: 'google', secrets: googleSecrets(), fetchFn: fakeFetch });
  const t2 = await getAccessToken({ provider: 'spotify', secrets: spotifySecrets(), fetchFn: fakeFetch });
  assert.notEqual(t1, t2);
  assert.equal(calls, 2);
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
  // Two distinct token endpoints (one per provider), but each provider deduped
  assert.equal(calls, 2);
});

test('saveSecret called when provider rotates and refresh_token returned', async () => {
  _resetCache();
  const saved = [];
  const fakeFetch = mock.fn(async () => ({
    ok: true,
    json: async () => ({ access_token: 'a', refresh_token: 'new-r', expires_in: 3600 }),
  }));
  const fakeSaveSecret = (key, value) => { saved.push([key, value]); };
  await getAccessToken({ provider: 'spotify', secrets: spotifySecrets(), fetchFn: fakeFetch, saveSecret: fakeSaveSecret });
  assert.deepEqual(saved, [['SPOTIFY_REFRESH_TOKEN', 'new-r']]);
});

test('saveSecret NOT called when provider does not rotate', async () => {
  _resetCache();
  const saved = [];
  const fakeFetch = mock.fn(async () => ({
    ok: true,
    json: async () => ({ access_token: 'a', refresh_token: 'ignored', expires_in: 3600 }),
  }));
  const fakeSaveSecret = (key, value) => { saved.push([key, value]); };
  await getAccessToken({ provider: 'google', secrets: googleSecrets(), fetchFn: fakeFetch, saveSecret: fakeSaveSecret });
  // Google PROVIDERS.rotatesRefreshToken === false; no save
  assert.equal(saved.length, 0);
});

test('saveSecret failure logged but cache still populated', async () => {
  _resetCache();
  const fakeFetch = mock.fn(async () => ({
    ok: true,
    json: async () => ({ access_token: 'a-ok', refresh_token: 'new-r', expires_in: 3600 }),
  }));
  const failingSaveSecret = () => { throw new Error('disk full'); };
  const t = await getAccessToken({ provider: 'spotify', secrets: spotifySecrets(), fetchFn: fakeFetch, saveSecret: failingSaveSecret });
  assert.equal(t, 'a-ok');
});

test('_resetCache(provider) clears one cache only', async () => {
  _resetCache();
  let calls = 0;
  const fakeFetch = mock.fn(async () => { calls += 1; return { ok: true, json: async () => ({ access_token: `tok-${calls}`, expires_in: 3600 }) }; });
  await getAccessToken({ provider: 'google', secrets: googleSecrets(), fetchFn: fakeFetch });
  await getAccessToken({ provider: 'spotify', secrets: spotifySecrets(), fetchFn: fakeFetch });
  _resetCache('google');
  await getAccessToken({ provider: 'spotify', secrets: spotifySecrets(), fetchFn: fakeFetch }); // hits cache
  await getAccessToken({ provider: 'google', secrets: googleSecrets(), fetchFn: fakeFetch });   // re-fetches
  assert.equal(calls, 3); // google×2, spotify×1
});

test('unknown provider throws', async () => {
  _resetCache();
  await assert.rejects(() => getAccessToken({ provider: 'nope', secrets: {}, fetchFn: async () => ({}) }));
});
```

- [ ] **Step 3: run + lint + commit**

```bash
git mv src/integrations/_auth/google-token-cache.js src/integrations/_auth/token-cache.js
git mv tests/unit/google-token-cache.test.js tests/unit/token-cache.test.js
# Edit content per Step 1, Step 2
npm test -- tests/unit/token-cache.test.js
npm run lint
git add -A
git commit -m "feat(oauth): rename google-token-cache → token-cache.js with per-provider keying"
```

---

## Task 3: Migrate Phase 2e Google integrations to new signature

**Files modified (~14):**
- `src/integrations/gmail/sync.js`, `src/integrations/gmail/tools/gmail-search.js`, `src/integrations/gmail/tools/gmail-get-thread.js`
- `src/integrations/google_calendar/sync.js`, `src/integrations/google_calendar/tools/calendar-get-event.js`
- `src/integrations/google_drive/sync.js`, `src/integrations/google_drive/tools/drive-search.js`, `src/integrations/google_drive/tools/drive-get-file.js`
- `src/integrations/youtube/sync.js`
- All their corresponding test files

- [ ] **Step 1: sync files**

For each `sync.js`, replace:
```js
import { getGoogleAccessToken } from '../_auth/google-token-cache.js';
const accessToken = await getGoogleAccessToken({ secrets: ctx.secrets, fetchFn: ctx.fetchFn });
```
with:
```js
import { getAccessToken } from '../_auth/token-cache.js';
const accessToken = await getAccessToken({ provider: 'google', secrets: ctx.secrets, fetchFn: ctx.fetchFn, saveSecret: ctx.saveSecret });
```

- [ ] **Step 2: tool files (no ctx; import saveSecret directly)**

For each tool that calls getGoogleAccessToken, replace:
```js
import { getGoogleAccessToken } from '../../_auth/google-token-cache.js';
const accessToken = await getGoogleAccessToken({ secrets: buildSecrets() });
```
with:
```js
import { getAccessToken } from '../../_auth/token-cache.js';
import { saveSecret } from '../../../secrets/dotenv-io.js';
const accessToken = await getAccessToken({ provider: 'google', secrets: buildSecrets(), saveSecret });
```

- [ ] **Step 3: test files**

For each test that calls `_resetCache()` (no arg), change to `_resetCache('google')`. For tests that import `getGoogleAccessToken`, switch to `getAccessToken`. Token-endpoint URL in mocks: ensure they match `https://oauth2.googleapis.com/token`.

- [ ] **Step 4: run + lint + commit**

```bash
npm test
npm run lint
git add -A
git commit -m "refactor(integrations): migrate gmail/calendar/drive/youtube to new getAccessToken signature"
```

Expected: existing tests pass without behavior regression.

---

## Task 4: Headless OAuth + auth CLI commands

**Files:**
- Modify: `src/integrations/_auth/oauth2.js` — `runHeadlessAuth` already added in Task 1
- Create: `src/cli/commands/auth-google.js`
- Create: `src/cli/commands/auth-spotify.js`
- Create: `src/cli/commands/auth-whoop.js`
- Modify: `src/cli/index.js` — `auth` dispatcher branch (re-introduced after 2e removal)
- Create: `tests/unit/auth-headless.test.js`
- Create: `tests/unit/auth-cli.test.js`

- [ ] **Step 1: write `src/cli/commands/auth-google.js`** (similar pattern for spotify/whoop)

```js
import { spawn } from 'node:child_process';
import readline from 'node:readline/promises';
import { confirm } from '../prompts.js';
import { runHeadlessAuth, runLoopbackAuth } from '../../integrations/_auth/oauth2.js';
import { saveSecret } from '../../secrets/dotenv-io.js';
import { loadManifests } from '../../integrations/_framework/manifest-loader.js';

function openUrl(url) {
  return new Promise((resolve, reject) => {
    const cmd = process.platform === 'darwin' ? 'open' : 'xdg-open';
    const p = spawn(cmd, [url], { stdio: 'ignore', detached: true });
    p.on('error', reject);
    p.on('exit', (code) => code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}`)));
  });
}

function parseCodeArg(argv) {
  // "--code" alone → interactive
  // "--code=<VALUE>" → inline
  // "--code <VALUE>" → ambiguous, reject
  const i = argv.indexOf('--code');
  if (i === -1) return { mode: 'loopback' };
  const arg = argv[i];
  if (arg === '--code') {
    if (argv[i + 1] && !argv[i + 1].startsWith('--')) {
      console.error('error: use `--code=<VALUE>` or `--code` alone for interactive prompt; space-separated form is ambiguous');
      process.exit(1);
    }
    return { mode: 'headless-interactive' };
  }
  if (arg.startsWith('--code=')) {
    return { mode: 'headless-inline', code: arg.slice('--code='.length) };
  }
  return { mode: 'loopback' };
}

async function unionScopes(provider) {
  const dir = new URL('../../integrations/', import.meta.url).pathname;
  const manifests = await loadManifests(dir);
  const all = new Set();
  for (const m of manifests) {
    if (m.secrets?.oauth?.provider === provider) {
      for (const s of m.secrets.oauth.scopes ?? []) all.add(s);
    }
  }
  return [...all];
}

export async function authGoogle(argv) {
  const provider = 'google';
  const scopes = await unionScopes(provider);
  if (scopes.length === 0) {
    console.error(`no integrations declare oauth scopes for provider ${provider}`);
    process.exit(1);
  }
  const parse = parseCodeArg(argv);
  let tokens;
  if (parse.mode === 'loopback') {
    tokens = await runLoopbackAuth({ provider, scopes, openFn: openUrl });
  } else if (parse.mode === 'headless-interactive') {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    try {
      tokens = await runHeadlessAuth({
        provider,
        scopes,
        readCode: async () => (await rl.question('Paste the code= parameter: ')).trim(),
      });
    } finally { rl.close(); }
  } else {
    tokens = await runHeadlessAuth({
      provider,
      scopes,
      readCode: async () => parse.code,
    });
  }
  saveSecret('GOOGLE_OAUTH_REFRESH_TOKEN', tokens.refresh_token);
  console.log(`google authenticated; refresh token saved.`);
}
```

`auth-spotify.js` and `auth-whoop.js` follow the same pattern with provider name + saveSecret env key change.

- [ ] **Step 2: wire dispatcher in `src/cli/index.js`**

```js
if (cmd === 'auth') {
  const sub = argv[1];
  const map = { google: 'auth-google.js', spotify: 'auth-spotify.js', whoop: 'auth-whoop.js' };
  if (!map[sub]) { console.error('usage: robin auth <google|spotify|whoop> [--code [<VALUE>]]'); process.exit(1); }
  const mod = await import(`./commands/${map[sub]}`);
  return Object.values(mod)[0](argv.slice(2));
}
```

- [ ] **Step 3: tests**

`tests/unit/auth-headless.test.js`:

```js
import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import { runHeadlessAuth } from '../../src/integrations/_auth/oauth2.js';

test('runHeadlessAuth prints URL with scopes and exchanges code', async () => {
  const prompts = [];
  const fakeFetch = mock.fn(async () => ({
    ok: true,
    json: async () => ({ access_token: 'a', refresh_token: 'r', expires_in: 3600 }),
  }));
  // We need to inject fetchFn into exchangeCode. The current signature passes fetchFn through.
  // Our test: stub readCode to return 'fake-code'.
  process.env.GOOGLE_OAUTH_CLIENT_ID = 'cid';
  process.env.GOOGLE_OAUTH_CLIENT_SECRET = 'csec';
  // runHeadlessAuth's exchangeCode call uses globalThis.fetch by default; mock that.
  const restore = mock.method(globalThis, 'fetch', fakeFetch);
  try {
    const r = await runHeadlessAuth({
      provider: 'google',
      scopes: ['scope1', 'scope2'],
      prompt: (s) => prompts.push(s),
      readCode: async () => 'fake-code',
    });
    assert.equal(r.access_token, 'a');
    const allPrompts = prompts.join(' ');
    assert.match(allPrompts, /scope1/);
    assert.match(allPrompts, /scope2/);
  } finally { restore.mock.restore(); }
});
```

`tests/unit/auth-cli.test.js`:

```js
import assert from 'node:assert/strict';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mock, test } from 'node:test';

let tmpHome;
test.beforeEach(() => {
  tmpHome = join(tmpdir(), `robin-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(tmpHome, { recursive: true });
  process.env.ROBIN_HOME = tmpHome;
  process.env.GOOGLE_OAUTH_CLIENT_ID = 'cid';
  process.env.GOOGLE_OAUTH_CLIENT_SECRET = 'csec';
});
test.afterEach(() => { rmSync(tmpHome, { recursive: true, force: true }); });

test('auth google --code=<VALUE> exchanges and saves refresh_token', async () => {
  const restore = mock.method(globalThis, 'fetch', async () => ({
    ok: true,
    json: async () => ({ access_token: 'a', refresh_token: 'r-test', expires_in: 3600 }),
  }));
  try {
    const { authGoogle } = await import(`../../src/cli/commands/auth-google.js?cb=${Date.now()}`);
    await authGoogle(['--code=test-code']);
    const { requireSecret } = await import(`../../src/secrets/dotenv-io.js?cb=${Date.now()}`);
    assert.equal(requireSecret('GOOGLE_OAUTH_REFRESH_TOKEN'), 'r-test');
  } finally { restore.mock.restore(); }
});

test('auth google --code <VALUE> (space) is rejected', async () => {
  const { authGoogle } = await import(`../../src/cli/commands/auth-google.js?cb=${Date.now()}`);
  // process.exit replacement
  const origExit = process.exit;
  let exitCode = 0;
  process.exit = (c) => { exitCode = c; throw new Error('exit'); };
  try {
    await assert.rejects(() => authGoogle(['--code', 'something']));
    assert.equal(exitCode, 1);
  } finally { process.exit = origExit; }
});
```

- [ ] **Step 4: run + lint + commit**

```bash
npm test -- tests/unit/auth-headless.test.js tests/unit/auth-cli.test.js
npm run lint
git add src/cli/commands/auth-*.js src/cli/index.js src/integrations/_auth/oauth2.js tests/unit/auth-*.test.js
git commit -m "feat(cli): re-introduce robin auth google/spotify/whoop with headless --code flow"
```

---

## Task 5: Per-tool rate limiter

**Files:**
- Create: `src/outbound/rate-limit.js`
- Modify: `src/integrations/github_write/tools/github-write.js` — add rate-limit pre-check
- Create: `tests/unit/rate-limit.test.js`
- Modify: `tests/unit/github-write-tool.test.js` — add rate-limit test

- [ ] **Step 1: write `src/outbound/rate-limit.js`**

```js
import { surql } from 'surrealdb';

const DEFAULT_CAP = 10;
const WINDOW_MS = 3_600_000;

function envCap(toolName) {
  const envKey = `${toolName.toUpperCase()}_RATE_LIMIT`;
  const raw = process.env[envKey];
  if (!raw) return DEFAULT_CAP;
  const n = Number.parseInt(raw, 10);
  if (!Number.isInteger(n) || n < 1) return DEFAULT_CAP;
  return n;
}

export async function checkRateLimit(db, toolName) {
  const cap = envCap(toolName);
  const now = Date.now();
  const cutoff = new Date(now - WINDOW_MS);

  const [rows] = await db
    .query(surql`SELECT * FROM type::record('runtime', 'outbound_rate')`)
    .collect();
  const value = rows[0]?.value ?? {};
  const toolRow = value[toolName] ?? {};
  const rawRecent = Array.isArray(toolRow.recent_writes) ? toolRow.recent_writes : [];
  const recent = rawRecent.filter((ts) => new Date(ts) >= cutoff);

  if (recent.length >= cap) {
    const oldest = new Date(recent[0]).getTime();
    const wait = Math.ceil((oldest + WINDOW_MS - now) / 1000);
    return { ok: false, reason: 'rate_limited', wait_seconds: wait, used: recent.length, cap };
  }

  recent.push(new Date(now).toISOString());
  const updatedTools = { ...value, [toolName]: { recent_writes: recent } };
  await db
    .query(surql`UPSERT type::record('runtime', 'outbound_rate') SET value = ${updatedTools}`)
    .collect();

  return { ok: true, used: recent.length, cap };
}
```

- [ ] **Step 2: integrate with github_write**

In `src/integrations/github_write/tools/github-write.js`, add at the top of the handler:

```js
import { checkRateLimit } from '../../../outbound/rate-limit.js';

handler: async (input) => {
  const rate = await checkRateLimit(db, 'github_write');
  if (!rate.ok) return rate;
  // ...existing logic
},
```

- [ ] **Step 3: tests**

`tests/unit/rate-limit.test.js`:

```js
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { test, mock } from 'node:test';
import { close, connect } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { checkRateLimit } from '../../src/outbound/rate-limit.js';

async function fresh() {
  const db = await connect({ engine: 'mem://' });
  await runMigrations(db, resolve(import.meta.dirname, '../../src/schema/migrations'));
  return db;
}

test('first write proceeds', async () => {
  const db = await fresh();
  const r = await checkRateLimit(db, 'github_write');
  assert.equal(r.ok, true);
  assert.equal(r.used, 1);
  await close(db);
});

test('11th write refused with rate_limited (cap=10)', async () => {
  const db = await fresh();
  for (let i = 0; i < 10; i++) await checkRateLimit(db, 'github_write');
  const r = await checkRateLimit(db, 'github_write');
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'rate_limited');
  assert.ok(r.wait_seconds > 0);
  await close(db);
});

test('env override GITHUB_WRITE_RATE_LIMIT=2', async () => {
  process.env.GITHUB_WRITE_RATE_LIMIT = '2';
  try {
    const db = await fresh();
    await checkRateLimit(db, 'github_write');
    await checkRateLimit(db, 'github_write');
    const r = await checkRateLimit(db, 'github_write');
    assert.equal(r.ok, false);
    await close(db);
  } finally { delete process.env.GITHUB_WRITE_RATE_LIMIT; }
});

test('malformed recent_writes (non-array) recovers', async () => {
  const db = await fresh();
  // Manually plant garbage
  await db.query(`UPSERT type::record('runtime', 'outbound_rate') SET value = { github_write: { recent_writes: 'not-an-array' } }`).collect();
  const r = await checkRateLimit(db, 'github_write');
  assert.equal(r.ok, true);
  await close(db);
});

test('per-tool isolation: github_write cap doesn\'t affect spotify_write', async () => {
  const db = await fresh();
  for (let i = 0; i < 10; i++) await checkRateLimit(db, 'github_write');
  const r = await checkRateLimit(db, 'spotify_write');
  assert.equal(r.ok, true);
  await close(db);
});
```

- [ ] **Step 4: run + lint + commit**

```bash
npm test -- tests/unit/rate-limit.test.js tests/unit/github-write-tool.test.js
npm run lint
git add src/outbound/rate-limit.js src/integrations/github_write/tools/github-write.js tests/unit/rate-limit.test.js tests/unit/github-write-tool.test.js
git commit -m "feat(outbound): per-tool rate limiter integrated with github_write"
```

---

## Task 6: spotify_write integration

**Files:**
- Create: `src/integrations/spotify_write/manifest.js`
- Create: `src/integrations/spotify_write/client.js`
- Create: `src/integrations/spotify_write/tools/spotify-write.js`
- Create: `tests/unit/spotify-write-tool.test.js`

(Implementation per §4 of the spec; refer to spec verbatim. ~200 LOC across 3 src files; ~150 LOC test.)

- [ ] **Step 1: write the four files** — see spec §4 for exact code
- [ ] **Step 2: write 7 tests** — happy path × 3 actions, missing-arg, 404, 403 premium, 100/101 boundary, rate-limit short-circuit
- [ ] **Step 3: bump tool count** — `tests/integration/mcp-end-to-end.test.js` 31 → 32
- [ ] **Step 4: run + lint + commit**

```bash
npm test
npm run lint
git add src/integrations/spotify_write/ tests/unit/spotify-write-tool.test.js tests/integration/mcp-end-to-end.test.js
git commit -m "feat(integrations): spotify_write tool-only integration with 3 actions"
```

---

## Task 7: weather + ebird + nhl + linear (4 simple read syncs)

Each integration follows the Phase 2e pattern: manifest + client + sync + tools + tests. Spec §5a has details. Bundle as one task to avoid per-integration commit churn for these straightforward ports.

For each integration directory `src/integrations/<name>/`:
- `manifest.js` — declares cadence, secrets.env_keys, tools
- `client.js` — HTTP fetch wrapper
- `sync.js` — uses ctx.capture(), advances cursor
- `tools/<name>-*.js` — DB-backed query tools (live tools where applicable, e.g. `linear_get_issue`)
- Unit tests — sync + tool

- [ ] **Step 1-4:** Write each integration following spec §5a
- [ ] **Step 5:** Bump `tool_count` to **38** (32 + weather:1 + ebird:1 + nhl:2 + linear:2 = 38)
- [ ] **Step 6:** Run + lint + commit

```bash
npm test
npm run lint
git add src/integrations/{weather,ebird,nhl,linear} tests/unit/{weather,ebird,nhl,linear}-*.test.js tests/integration/mcp-end-to-end.test.js
git commit -m "feat(integrations): weather + ebird + nhl + linear read-sync integrations"
```

---

## Task 8: whoop integration + quiet_window scheduler

**Files:**
- Modify: `src/integrations/_framework/run-sync.js` — quiet_window support
- Modify: `src/integrations/_framework/manifest-loader.js` — accept quiet_window field
- Create: `src/integrations/whoop/manifest.js + sync.js + client.js + tools/`
- Create: `tests/unit/run-sync-quiet-window.test.js`
- Create: `tests/unit/whoop-sync.test.js`, `tests/unit/whoop-tools.test.js`

- [ ] **Step 1: extend run-sync.js with quiet_window logic**

After successful sync, when computing next_run_at, if manifest has `quiet_window`:
```js
function adjustForQuietWindow(nextRunAt, quietWindow) {
  if (!quietWindow) return nextRunAt;
  const { tz, active_hours } = quietWindow;
  const formatter = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', hour12: false });
  let candidate = new Date(nextRunAt);
  for (let i = 0; i < 24; i++) {
    const hour = Number.parseInt(formatter.format(candidate), 10);
    if (active_hours.includes(hour)) return candidate;
    candidate = new Date(candidate.getTime() + 60 * 60_000);
  }
  return candidate;
}
```

- [ ] **Step 2-5:** Write whoop integration files per spec §5b
- [ ] **Step 6:** Bump tool_count to **40** (38 + whoop:2)
- [ ] **Step 7:** Run + lint + commit

```bash
git commit -m "feat(integrations): whoop integration + quiet_window scheduler mechanism"
```

---

## Task 9: ga (Google Analytics 4) integration

**Files:**
- Create: `src/integrations/ga/manifest.js + sync.js + client.js + tools/`
- Create: `tests/unit/ga-sync.test.js`, `tests/unit/ga-tool.test.js`

- [ ] **Step 1-3:** Write per spec §5c. Sync detects 403 PERMISSION_DENIED via body content; logs re-auth instruction; doesn't crash.
- [ ] **Step 4:** Bump tool_count to **41** (40 + ga:1)
- [ ] **Step 5:** Run + lint + commit

```bash
git commit -m "feat(integrations): ga (Google Analytics 4) read-sync integration"
```

---

## Task 10: Local SQLite shared utility + preflight + chrome

**Files:**
- Modify: `package.json` — add `better-sqlite3@^11`
- Create: `src/integrations/_local/sqlite.js`
- Modify: `src/integrations/_framework/manifest-loader.js` — preflight handling
- Create: `src/integrations/chrome/manifest.js + sync.js + client.js + tools/`
- Create: `tests/unit/manifest-preflight.test.js`
- Create: `tests/unit/chrome-sync.test.js`, `tests/unit/chrome-tools.test.js`

- [ ] **Step 1: install better-sqlite3**
```bash
npm install better-sqlite3@^11
```

- [ ] **Step 2-4:** Write per spec §5d. Manifest-loader extended to call `await m.preflight?.()` after `validateManifest`; on throw, manifest moves to `unavailable` list.
- [ ] **Step 5:** Bump tool_count to **43** (41 + chrome:2)
- [ ] **Step 6:** Run + lint + commit

```bash
git commit -m "feat(integrations): local-SQLite utility + preflight + chrome read-sync"
```

---

## Task 11: lrc (Lightroom Classic) integration

**Files:**
- Create: `src/integrations/lrc/manifest.js + sync.js + client.js + tools/`
- Create: `tests/unit/lrc-sync.test.js`, `tests/unit/lrc-tool.test.js`

- [ ] **Step 1-3:** Write per spec §5d. Reuses `_local/sqlite.js` from Task 10. Reference v1's `sync-lrc.js` for query specifics.
- [ ] **Step 4:** Bump tool_count to **44** (43 + lrc:1) — final count
- [ ] **Step 5:** Run + lint + commit

```bash
git commit -m "feat(integrations): lrc (Lightroom Classic) read-sync integration"
```

---

## Task 12: Daemon wiring + integrations-list update + AGENTS.md

**Files:**
- Modify: `src/daemon/server.js` — auto-loads via manifest-loader (no per-integration wiring needed; already iterative from Phase 2e)
- Modify: `src/cli/commands/integrations-list.js` — display unavailable rows
- Modify: `src/install/agents-md.js` — 16 integrations + outbound-writes section spotify_write addition

- [ ] **Step 1:** Update integrations-list to show unavailable preflight failures
- [ ] **Step 2:** Update agents-md.js for 16 integrations + spotify_write outbound caveat
- [ ] **Step 3:** Smoke test daemon boot — confirm 16 integrations loaded (or unavailable), tool count = 44
- [ ] **Step 4:** Run + lint + commit

```bash
git commit -m "feat(daemon,cli,install): integrations-list unavailable rows + AGENTS.md 16 integrations"
```

---

## Task 13: Integration tests

**Files:**
- Create: `tests/integration/oauth-multi-provider.test.js`
- Create: `tests/integration/spotify-rotation-roundtrip.test.js`
- Create: `tests/integration/whoop-quiet-window.test.js`
- Create: `tests/integration/ga-scope-error.test.js`
- Create: `tests/integration/chrome-snapshot.test.js`
- Create: `tests/integration/integrations-list-unavailable.test.js`

- [ ] **Step 1-6:** Write each test per spec §7 testing strategy
- [ ] **Step 7:** Run + lint + commit

```bash
git commit -m "test(2f): integration coverage for oauth, rotation, quiet_window, scope-error, sqlite, preflight"
```

---

## Task 14: CHANGELOG + tag v6.0.0-alpha.7

**Files:**
- Modify: `CHANGELOG.md`

- [ ] **Step 1: prepend entry**

```markdown
## [6.0.0-alpha.7] — 2026-05-10

Phase 2f: OAuth generalization + spotify-write + headless OAuth + rate limiter + 8 read-sync integrations.

- **OAuth2 generalization**: `_auth/oauth2-google.js` → `_auth/oauth2.js` with PROVIDERS registry (google/spotify/whoop). `google-token-cache.js` → `token-cache.js` keyed per-provider. Refresh-token rotation handled when provider declares `rotatesRefreshToken: true`.
- **Headless OAuth `--code` flag**: `robin auth google --code [<VALUE>]` for VM/SSH cases. Re-introduces `auth google/spotify/whoop` CLIs (removed in 2e).
- **Per-tool rate limiter**: `runtime:outbound_rate.<tool>` sliding 1-hour window. Default 10/hr. Per-tool env override.
- **spotify-write**: tool-only with 3 actions (queue, skip, playlist-add). First integration to exercise refresh-token rotation.
- **8 new read-sync integrations**: weather (6h), ebird (12h), nhl (12h), linear (1h), whoop (30m, 4-9am EDT only via quiet_window), ga (1d, requires `analytics.readonly` re-auth), chrome (1d, local SQLite), lrc (1w, local SQLite). Apple Photos NOT included.
- **Manifest preflight**: optional `manifest.preflight()` async export. Failed preflight → `unavailable` list; daemon stays up; `integrations list` shows the row.
- **better-sqlite3** added as dep (transient client lib for chrome/lrc; never used as storage).
- **13 new MCP tools** (44 total daemon surface).
- **AGENTS.md** updated with 16 integrations + spotify_write outbound caveat.

Phase 2g candidates: per-integration filtering in `integrations list`, more v1 integrations as ported.
```

- [ ] **Step 2: commit + tag**

```bash
git add CHANGELOG.md
git commit -m "chore(2f): CHANGELOG for v6.0.0-alpha.7"
git tag v6.0.0-alpha.7
git tag -l 'v6.0.0-alpha*'
```

Expected: tag landed.
