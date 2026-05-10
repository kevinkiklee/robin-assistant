import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { writeSecrets } from './secrets-io.js';

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

export function buildAuthUrl({ client_id, scopes, challenge, state }) {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id,
    redirect_uri: REDIRECT_URI,
    scope: scopes.join(' '),
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state,
    access_type: 'offline',
    prompt: 'consent',
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
}

export async function exchangeCode({
  client_id,
  client_secret,
  code,
  verifier,
  fetchFn = globalThis.fetch,
}) {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    client_id,
    client_secret,
    redirect_uri: REDIRECT_URI,
    code_verifier: verifier,
  });
  const r = await fetchFn('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!r.ok) throw new Error(`token exchange failed: ${r.status} ${await r.text()}`);
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
  client_id,
  client_secret,
  refresh_token,
  fetchFn = globalThis.fetch,
}) {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token,
    client_id,
    client_secret,
  });
  const r = await fetchFn('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!r.ok) throw new Error(`token refresh failed: ${r.status} ${await r.text()}`);
  const json = await r.json();
  return {
    access_token: json.access_token,
    expires_at: Date.now() + json.expires_in * 1000,
  };
}

export async function ensureFreshToken(name, secrets, deps = {}) {
  if (!secrets.expires_at || secrets.expires_at - Date.now() < 60_000) {
    const fresh = await refreshAccessToken({
      client_id: secrets.client_id,
      client_secret: secrets.client_secret,
      refresh_token: secrets.refresh_token,
      fetchFn: deps.fetchFn,
    });
    const next = { ...secrets, ...fresh };
    await writeSecrets(name, next);
    return next;
  }
  return secrets;
}

export async function runLoopbackAuth({ client_id, client_secret, scopes, openFn, fetchFn }) {
  const { verifier, challenge } = generatePKCE();
  const state = base64url(randomBytes(16));
  const url = buildAuthUrl({ client_id, scopes, challenge, state });

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
      exchangeCode({ client_id, client_secret, code, verifier, fetchFn })
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
