import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';

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

/**
 * Build the provider's authorization URL. Reads client_id from `secrets`
 * (keyed by `PROVIDERS[provider].clientIdEnv`) — v2 doesn't pollute process.env,
 * so callers pass an explicit secrets object (typically the manifest-driven
 * getter from `runIntegrationSync`).
 */
export function buildAuthUrl({ provider: providerName, scopes, challenge, state, secrets = {} }) {
  const p = provider(providerName);
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: secrets[p.clientIdEnv] ?? '',
    redirect_uri: REDIRECT_URI,
    scope: scopes.join(' '),
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state,
    ...p.extraAuthParams,
  });
  return `${p.authUrl}?${params}`;
}

export async function exchangeCode({
  provider: providerName,
  code,
  verifier,
  secrets = {},
  redirectUri = REDIRECT_URI,
  fetchFn = globalThis.fetch,
}) {
  const p = provider(providerName);
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    client_id: secrets[p.clientIdEnv] ?? '',
    client_secret: secrets[p.clientSecretEnv] ?? '',
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
    expires_at: Date.now() + json.expires_in * 1000,
    token_type: json.token_type,
    scope: json.scope,
  };
}

export async function refreshAccessToken({
  provider: providerName,
  refresh_token,
  secrets = {},
  fetchFn = globalThis.fetch,
}) {
  const p = provider(providerName);
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token,
    client_id: secrets[p.clientIdEnv] ?? '',
    client_secret: secrets[p.clientSecretEnv] ?? '',
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
    expires_at: Date.now() + json.expires_in * 1000,
    refresh_token: json.refresh_token,
  };
}

/**
 * Refresh an access token for `providerName` using the secrets bag. The
 * refresh_token, client_id, and client_secret are read from `secrets` keyed
 * by the provider's env-key names (`PROVIDERS[providerName].refreshTokenEnv`
 * etc.). Caching is the caller's responsibility (see `token-cache.js`).
 *
 * Providers with `rotatesRefreshToken: true` (spotify, whoop) may return a
 * new refresh_token in the response; the caller persists it via
 * `ctx.saveSecret(p.refreshTokenEnv, new)`.
 */
export async function ensureFreshToken(providerName, secrets, deps = {}) {
  const p = provider(providerName);
  const refresh_token = secrets[p.refreshTokenEnv];
  return await refreshAccessToken({
    provider: providerName,
    refresh_token,
    secrets,
    fetchFn: deps.fetchFn,
  });
}

export async function runLoopbackAuth({
  provider: providerName,
  scopes,
  secrets = {},
  openFn,
  fetchFn,
}) {
  const { verifier, challenge } = generatePKCE();
  const state = base64url(randomBytes(16));
  const url = buildAuthUrl({ provider: providerName, scopes, challenge, state, secrets });

  return await new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const u = new URL(req.url, REDIRECT_URI);
      if (!u.pathname.startsWith('/callback')) {
        res.writeHead(404).end();
        return;
      }
      const code = u.searchParams.get('code');
      const returnedState = u.searchParams.get('state');
      const err = u.searchParams.get('error');
      if (err) {
        res.writeHead(400).end(`Error: ${err}`);
        server.close();
        reject(new Error(err));
        return;
      }
      if (returnedState !== state) {
        res.writeHead(400).end('State mismatch');
        server.close();
        reject(new Error('state mismatch'));
        return;
      }
      res
        .writeHead(200, { 'Content-Type': 'text/html' })
        .end('<h1>Auth complete. You can close this tab.</h1>');
      exchangeCode({ provider: providerName, code, verifier, secrets, fetchFn })
        .then((tokens) => {
          server.close();
          resolve(tokens);
        })
        .catch((e) => {
          server.close();
          reject(e);
        });
    });
    server.listen(REDIRECT_PORT, '127.0.0.1', () => {
      console.log(`Open this URL in your browser:\n  ${url}`);
      if (openFn) openFn(url).catch(() => {});
    });
    server.on('error', reject);
  });
}

/**
 * Headless OAuth flow for VM/SSH cases where no local browser is available.
 * The user opens the auth URL on any machine, authorizes, then copies the
 * `code=` query param from the (failing) redirect URL back to the prompt.
 * In Phase 2f only Google is wired through the CLI, but the flow is
 * provider-agnostic.
 */
export async function runHeadlessAuth({
  provider: providerName,
  scopes,
  secrets = {},
  prompt = console.log,
  readCode,
  fetchFn,
}) {
  const { verifier, challenge } = generatePKCE();
  const state = base64url(randomBytes(16));
  const url = buildAuthUrl({ provider: providerName, scopes, challenge, state, secrets });

  prompt(`\nOpen this URL in any browser (on any machine):\n  ${url}\n`);
  prompt('After authorizing, the browser will redirect to:');
  prompt(`  ${REDIRECT_URI}?code=<CODE>&state=<STATE>`);
  prompt('The page will fail to load. Copy the code= parameter.');
  const code = await readCode();

  return await exchangeCode({
    provider: providerName,
    code,
    verifier,
    secrets,
    redirectUri: REDIRECT_URI,
    fetchFn,
  });
}
