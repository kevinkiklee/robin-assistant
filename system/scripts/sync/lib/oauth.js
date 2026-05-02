// OAuth2 helpers for sync integrations.
//
// Two responsibilities:
//   1. getAccessToken(workspaceDir, provider, opts) — runtime helper used by
//      sync scripts. Reads the long-lived refresh token from .env, returns a
//      cached access token from state if still valid, otherwise refreshes and
//      caches the new access token (and writes back the rotated refresh token
//      if the provider rotates them).
//   2. runAuthCodeFlow(opts) — one-shot setup helper. Spins up a localhost
//      callback server, opens the user's browser to the consent URL, captures
//      the auth code, exchanges it for tokens. Returns { refreshToken,
//      accessToken, expiresAt }.

import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { platform } from 'node:os';
import { randomBytes } from 'node:crypto';
import { fetchJson, AuthError } from './http.js';
import { loadCursor, saveCursor } from './cursor.js';
import { loadSecrets, requireSecret, saveSecret } from './secrets.js';

const CLOCK_SKEW_SEC = 60; // refresh 60s before actual expiry

// Provider config registry. Add a new provider by registering its endpoints
// and the env var that holds its refresh token. Per-provider scopes are
// passed to runAuthCodeFlow at setup time, not here.
const PROVIDERS = {
  google: {
    tokenUrl: 'https://oauth2.googleapis.com/token',
    authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    refreshTokenEnv: 'GOOGLE_OAUTH_REFRESH_TOKEN',
    clientIdEnv: 'GOOGLE_OAUTH_CLIENT_ID',
    clientSecretEnv: 'GOOGLE_OAUTH_CLIENT_SECRET',
    rotatesRefreshToken: false,
  },
  spotify: {
    tokenUrl: 'https://accounts.spotify.com/api/token',
    authUrl: 'https://accounts.spotify.com/authorize',
    refreshTokenEnv: 'SPOTIFY_REFRESH_TOKEN',
    clientIdEnv: 'SPOTIFY_CLIENT_ID',
    clientSecretEnv: 'SPOTIFY_CLIENT_SECRET',
    rotatesRefreshToken: true,
  },
};

export function getProvider(name) {
  const p = PROVIDERS[name];
  if (!p) throw new Error(`Unknown OAuth provider: ${name}`);
  return p;
}

// getAccessToken — refreshes via stored refresh_token if needed.
// State file shape (per-provider): user-data/state/sync/<provider>.json
//   { access_token, access_token_expires_at, ...other fields }
export async function getAccessToken(workspaceDir, providerName, opts = {}) {
  const provider = getProvider(providerName);
  // Cycle-2a: read each secret on demand from user-data/secrets/.env without
  // polluting process.env. loadSecrets is a no-op shim retained only for
  // unmigrated callers.
  const refreshToken = requireSecret(workspaceDir, provider.refreshTokenEnv);
  const clientId = requireSecret(workspaceDir, provider.clientIdEnv);
  const clientSecret = requireSecret(workspaceDir, provider.clientSecretEnv);

  const state = loadCursor(workspaceDir, providerName);
  const cached = state.access_token;
  const expiresAt = state.access_token_expires_at
    ? Date.parse(state.access_token_expires_at)
    : 0;
  const nowMs = Date.now();
  if (cached && expiresAt > nowMs + CLOCK_SKEW_SEC * 1000) {
    return cached;
  }

  // Refresh.
  const fetchImpl = opts.fetch ?? globalThis.fetch;
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: clientId,
    client_secret: clientSecret,
  });
  const data = await fetchJson(
    provider.tokenUrl,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    },
    { fetch: fetchImpl, retryDelayMs: opts.retryDelayMs ?? 500 }
  );

  if (!data.access_token) {
    throw new AuthError(`No access_token in refresh response from ${providerName}`, {
      status: 0,
      body: JSON.stringify(data),
    });
  }

  const expiresInSec = data.expires_in ?? 3600;
  const newExpiresAt = new Date(nowMs + expiresInSec * 1000).toISOString();

  saveCursor(workspaceDir, providerName, {
    access_token: data.access_token,
    access_token_expires_at: newExpiresAt,
    auth_status: 'ok',
  });

  if (data.refresh_token && data.refresh_token !== refreshToken) {
    // Provider rotated the refresh token (Spotify under some conditions).
    saveSecret(workspaceDir, provider.refreshTokenEnv, data.refresh_token);
  }

  return data.access_token;
}

// runAuthCodeFlow — one-shot OAuth setup. Returns { refreshToken, accessToken, expiresAt }.
//
// opts:
//   provider: 'google' | 'spotify' (or any registered key)
//   clientId, clientSecret: from .env
//   scopes: array of scope strings
//   port: localhost port for callback (default: 0 = random free port)
//   extraAuthParams: object of extra query params (e.g. {access_type:'offline',prompt:'consent'} for Google)
//   openBrowser: function(url) — defaults to platform-native opener; pass false to skip (caller opens manually)
//   timeoutMs: how long to wait for the user to consent (default: 5min)
export async function runAuthCodeFlow(opts) {
  const provider = getProvider(opts.provider);
  const clientId = opts.clientId;
  const clientSecret = opts.clientSecret;
  const scopes = opts.scopes;
  const port = opts.port ?? 0;
  const timeoutMs = opts.timeoutMs ?? 5 * 60 * 1000;
  const extraAuthParams = opts.extraAuthParams ?? {};

  if (!clientId || !clientSecret) {
    throw new Error('runAuthCodeFlow: clientId and clientSecret are required');
  }
  if (!Array.isArray(scopes) || scopes.length === 0) {
    throw new Error('runAuthCodeFlow: scopes must be a non-empty array');
  }

  const state = randomBytes(16).toString('hex');

  const { code, redirectUri } = await captureAuthCode({
    port,
    state,
    timeoutMs,
    onListening: (uri) => {
      const consentUrl = new URL(provider.authUrl);
      consentUrl.searchParams.set('client_id', clientId);
      consentUrl.searchParams.set('response_type', 'code');
      consentUrl.searchParams.set('redirect_uri', uri);
      consentUrl.searchParams.set('scope', scopes.join(' '));
      consentUrl.searchParams.set('state', state);
      for (const [k, v] of Object.entries(extraAuthParams)) {
        consentUrl.searchParams.set(k, String(v));
      }
      const url = consentUrl.toString();
      console.log(`\n[auth] Opening browser to consent URL.`);
      console.log(`[auth] If the browser doesn't open, paste this URL manually:\n  ${url}\n`);
      if (opts.openBrowser !== false) {
        const opener = opts.openBrowser ?? defaultOpenBrowser;
        try { opener(url); } catch { /* user pastes manually */ }
      }
    },
  });

  // Exchange code for tokens.
  const fetchImpl = opts.fetch ?? globalThis.fetch;
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    client_id: clientId,
    client_secret: clientSecret,
  });
  const data = await fetchJson(
    provider.tokenUrl,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    },
    { fetch: fetchImpl, retryDelayMs: 500 }
  );

  if (!data.refresh_token) {
    throw new Error(
      `Token exchange returned no refresh_token. Some providers omit refresh_token if you have already authorized this client. ` +
      `For Google, pass extraAuthParams: {access_type:'offline', prompt:'consent'}.`
    );
  }
  if (!data.access_token) {
    throw new Error(`Token exchange returned no access_token: ${JSON.stringify(data)}`);
  }

  const expiresInSec = data.expires_in ?? 3600;
  return {
    refreshToken: data.refresh_token,
    accessToken: data.access_token,
    expiresAt: new Date(Date.now() + expiresInSec * 1000).toISOString(),
  };
}

// Listen on localhost, return when /oauth-callback is hit.
function captureAuthCode({ port, state, timeoutMs, onListening }) {
  return new Promise((resolve, reject) => {
    let server;
    const timer = setTimeout(() => {
      try { server?.close(); } catch { /* ignore */ }
      reject(new Error(`OAuth flow timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    server = createServer((req, res) => {
      try {
        const u = new URL(req.url, 'http://localhost');
        if (u.pathname !== '/oauth-callback') {
          res.writeHead(404);
          res.end('Not found');
          return;
        }
        const code = u.searchParams.get('code');
        const returnedState = u.searchParams.get('state');
        const error = u.searchParams.get('error');
        if (error) {
          res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(`<h1>Error</h1><pre>${escapeHtml(error)}</pre>`);
          clearTimeout(timer);
          server.close();
          reject(new Error(`OAuth provider returned error: ${error}`));
          return;
        }
        if (returnedState !== state) {
          res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end('<h1>State mismatch</h1>');
          clearTimeout(timer);
          server.close();
          reject(new Error('OAuth state mismatch (possible CSRF)'));
          return;
        }
        if (!code) {
          res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end('<h1>No code in callback</h1>');
          clearTimeout(timer);
          server.close();
          reject(new Error('No authorization code in callback'));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end('<h1>OK</h1><p>Authorization received. You can close this tab.</p>');
        const redirectUri = `http://127.0.0.1:${server.address().port}/oauth-callback`;
        clearTimeout(timer);
        server.close();
        resolve({ code, redirectUri });
      } catch (err) {
        clearTimeout(timer);
        try { server.close(); } catch { /* ignore */ }
        reject(err);
      }
    });
    server.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    server.listen(port, '127.0.0.1', () => {
      const actualPort = server.address().port;
      const redirectUri = `http://127.0.0.1:${actualPort}/oauth-callback`;
      onListening(redirectUri);
    });
  });
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
  );
}

function defaultOpenBrowser(url) {
  const p = platform();
  let cmd, args;
  if (p === 'darwin') { cmd = 'open'; args = [url]; }
  else if (p === 'win32') { cmd = 'cmd'; args = ['/c', 'start', '""', url]; }
  else { cmd = 'xdg-open'; args = [url]; }
  spawn(cmd, args, { stdio: 'ignore', detached: true }).unref();
}
