import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { RobinDb } from '../../../../brain/memory/db.ts';

/** Authorization codes live seconds, not minutes — they are redeemed immediately. */
const CODE_TTL_SECONDS = 60;
const ACCESS_TTL_SECONDS = 60 * 60;
const REFRESH_TTL_SECONDS = 60 * 60 * 24 * 30;

export interface RegisteredClient {
  client_id: string;
  client_name?: string;
  redirect_uris: string[];
  token_endpoint_auth_method: 'none';
  client_id_issued_at: number;
}

export interface IssuedTokens {
  access_token: string;
  token_type: 'Bearer';
  expires_in: number;
  refresh_token?: string;
  scope?: string;
}

export interface AccessTokenInfo {
  clientId: string;
  scope?: string;
  resource?: string;
}

/** Secrets are compared and stored by hash; the plaintext exists only in transit. */
function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function secret(): string {
  return randomBytes(32).toString('base64url');
}

function nowPlus(seconds: number): string {
  return new Date(Date.now() + seconds * 1000).toISOString();
}

/**
 * RFC 8707 audience as stored. An empty `resource` means the same as an absent
 * one: storing `''` would make the audience check read a falsy value and skip
 * itself, while still looking like a bound token in the table.
 */
function audience(resource: string | undefined): string | null {
  return resource ? resource : null;
}

function isExpired(iso: string): boolean {
  return new Date(iso).getTime() <= Date.now();
}

/** Constant-time string compare for values an attacker can probe repeatedly. */
function sameSecret(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/**
 * RFC 7591 dynamic client registration. Claude registers itself on first
 * connection, so there is no pre-shared client — which is exactly why the
 * consent screen, not the client identity, is what actually gates access.
 */
export function registerClient(
  db: RobinDb,
  input: { clientName?: string; redirectUris: string[] },
): RegisteredClient {
  const clientId = randomBytes(16).toString('hex');
  db.prepare(
    'INSERT INTO oauth_clients (client_id, client_name, redirect_uris) VALUES (?, ?, ?)',
  ).run(clientId, input.clientName ?? null, JSON.stringify(input.redirectUris));
  return {
    client_id: clientId,
    client_name: input.clientName,
    redirect_uris: input.redirectUris,
    token_endpoint_auth_method: 'none',
    client_id_issued_at: Math.floor(Date.now() / 1000),
  };
}

export function getClient(db: RobinDb, clientId: string): RegisteredClient | null {
  const row = db
    .prepare('SELECT client_id, client_name, redirect_uris FROM oauth_clients WHERE client_id = ?')
    .get(clientId) as
    | { client_id: string; client_name: string | null; redirect_uris: string }
    | undefined;
  if (!row) return null;
  return {
    client_id: row.client_id,
    client_name: row.client_name ?? undefined,
    redirect_uris: JSON.parse(row.redirect_uris) as string[],
    token_endpoint_auth_method: 'none',
    client_id_issued_at: 0,
  };
}

/** Mints an authorization code bound to the PKCE challenge, redirect URI and audience. */
export function issueCode(
  db: RobinDb,
  input: {
    clientId: string;
    redirectUri: string;
    codeChallenge: string;
    resource?: string;
    scope?: string;
  },
): string {
  const code = secret();
  db.prepare(
    `INSERT INTO oauth_codes (code_hash, client_id, redirect_uri, code_challenge, resource, scope, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    hash(code),
    input.clientId,
    input.redirectUri,
    input.codeChallenge,
    audience(input.resource),
    input.scope ?? null,
    nowPlus(CODE_TTL_SECONDS),
  );
  return code;
}

/**
 * Exchanges a code, enforcing every binding made at issue time: same client, same
 * redirect URI, matching PKCE verifier, unexpired, and never redeemed before.
 * Returns a discriminated result so callers can't mistake failure for success.
 */
export function redeemCode(
  db: RobinDb,
  input: { code: string; clientId: string; redirectUri: string; codeVerifier?: string },
): { resource?: string; scope?: string } | { error: string } {
  const row = db
    .prepare(
      `SELECT client_id, redirect_uri, code_challenge, resource, scope, expires_at, redeemed_at
         FROM oauth_codes WHERE code_hash = ?`,
    )
    .get(hash(input.code)) as
    | {
        client_id: string;
        redirect_uri: string;
        code_challenge: string;
        resource: string | null;
        scope: string | null;
        expires_at: string;
        redeemed_at: string | null;
      }
    | undefined;

  if (!row) return { error: 'invalid_grant' };
  if (row.redeemed_at) return { error: 'invalid_grant' };
  if (isExpired(row.expires_at)) return { error: 'invalid_grant' };
  if (row.client_id !== input.clientId) return { error: 'invalid_grant' };
  if (row.redirect_uri !== input.redirectUri) return { error: 'invalid_grant' };

  // PKCE S256 is mandatory: the verifier must hash to the challenge recorded at
  // authorization time, which is what makes an intercepted code unusable.
  if (!input.codeVerifier) return { error: 'invalid_request' };
  const computed = createHash('sha256').update(input.codeVerifier).digest('base64url');
  if (!sameSecret(computed, row.code_challenge)) return { error: 'invalid_grant' };

  db.prepare("UPDATE oauth_codes SET redeemed_at = datetime('now') WHERE code_hash = ?").run(
    hash(input.code),
  );
  return { resource: row.resource ?? undefined, scope: row.scope ?? undefined };
}

export function issueTokens(
  db: RobinDb,
  input: {
    clientId: string;
    resource?: string;
    scope?: string;
    expiresInSeconds?: number;
  },
): IssuedTokens {
  const accessToken = secret();
  const refreshToken = secret();
  const expiresIn = input.expiresInSeconds ?? ACCESS_TTL_SECONDS;
  db.prepare(
    `INSERT INTO oauth_tokens (token_hash, client_id, resource, scope, expires_at, refresh_hash, refresh_expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    hash(accessToken),
    input.clientId,
    audience(input.resource),
    input.scope ?? null,
    nowPlus(expiresIn),
    hash(refreshToken),
    nowPlus(REFRESH_TTL_SECONDS),
  );
  return {
    access_token: accessToken,
    token_type: 'Bearer',
    expires_in: expiresIn,
    refresh_token: refreshToken,
    scope: input.scope,
  };
}

/**
 * Validates a bearer token for a specific audience. `expectedResource` is the
 * canonical MCP URL; a token minted for anything else is rejected rather than
 * accepted-and-trusted, which is the token-passthrough failure the MCP security
 * guidance singles out.
 */
export function verifyAccessToken(
  db: RobinDb,
  token: string,
  expectedResource: string,
): AccessTokenInfo | null {
  const row = db
    .prepare(
      `SELECT client_id, resource, scope, expires_at, revoked_at FROM oauth_tokens WHERE token_hash = ?`,
    )
    .get(hash(token)) as
    | {
        client_id: string;
        resource: string | null;
        scope: string | null;
        expires_at: string;
        revoked_at: string | null;
      }
    | undefined;
  if (!row) return null;
  if (row.revoked_at) return null;
  if (isExpired(row.expires_at)) return null;
  // NULL is an unbound token; anything else, including a legacy '' written
  // before empty-means-absent, must match exactly.
  if (row.resource !== null && row.resource !== expectedResource) return null;
  return {
    clientId: row.client_id,
    scope: row.scope ?? undefined,
    resource: row.resource ?? undefined,
  };
}

/**
 * Rotates a refresh token: the presented one is revoked and chained to its
 * successor. Rotation is required for public clients, and the chain makes a
 * replayed token distinguishable from a merely unknown one.
 */
export function redeemRefreshToken(
  db: RobinDb,
  input: { refreshToken: string; clientId: string },
): IssuedTokens | null {
  const row = db
    .prepare(
      `SELECT token_hash, client_id, resource, scope, refresh_expires_at, revoked_at, replaced_by
         FROM oauth_tokens WHERE refresh_hash = ?`,
    )
    .get(hash(input.refreshToken)) as
    | {
        token_hash: string;
        client_id: string;
        resource: string | null;
        scope: string | null;
        refresh_expires_at: string | null;
        revoked_at: string | null;
        replaced_by: string | null;
      }
    | undefined;
  if (!row) return null;
  if (row.revoked_at || row.replaced_by) return null;
  if (row.client_id !== input.clientId) return null;
  if (row.refresh_expires_at && isExpired(row.refresh_expires_at)) return null;
  // A legacy empty audience can't verify, and rotating it would mint an
  // unbound successor; refuse so the client re-runs the flow.
  if (row.resource === '') return null;

  const next = issueTokens(db, {
    clientId: row.client_id,
    resource: row.resource ?? undefined,
    scope: row.scope ?? undefined,
  });
  db.prepare(
    "UPDATE oauth_tokens SET revoked_at = datetime('now'), replaced_by = ? WHERE token_hash = ?",
  ).run(hash(next.access_token), row.token_hash);
  return next;
}

/** Housekeeping: spent codes and dead tokens have no reason to accumulate. */
export function pruneExpired(db: RobinDb): void {
  db.prepare("DELETE FROM oauth_codes WHERE expires_at < datetime('now', '-1 day')").run();
  db.prepare(
    "DELETE FROM oauth_tokens WHERE expires_at < datetime('now', '-30 day') AND (refresh_expires_at IS NULL OR refresh_expires_at < datetime('now'))",
  ).run();
}
