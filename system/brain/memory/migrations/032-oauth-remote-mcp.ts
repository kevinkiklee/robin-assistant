import type { Migration } from './types.ts';

/**
 * OAuth 2.1 state for the remote MCP surface (`robin mcp remote`).
 *
 * Why this exists: claude.ai's connector validator rejects a capability URL —
 * an endpoint whose path carries a long high-entropy secret. Verified by
 * experiment on 2026-08-08: the same ping server connected at `/mcp` and failed
 * at `/t/<43-char-token>/mcp`, with everything else held constant. Anthropic's
 * docs independently call credentials-in-URLs a vulnerability. So the secret has
 * to move out of the path and into a bearer token, which requires being a real
 * OAuth authorization server: RFC 7591 registration, RFC 8414 metadata, RFC 9728
 * protected-resource metadata, and PKCE.
 *
 * Notable columns:
 *  - Codes and tokens are stored as SHA-256 HASHES, never plaintext. A read of
 *    this table must not yield anything usable against the endpoint.
 *  - `resource` is the RFC 8707 audience the token was minted for. It is checked
 *    on every request; a token issued for another resource is rejected, which is
 *    what stops token-passthrough confusion.
 *  - `code_challenge` is the PKCE S256 challenge, verified at redemption.
 *  - Authorization codes are single-use: `redeemed_at` is stamped on exchange and
 *    a second attempt is refused (replay defence, required by OAuth 2.1).
 *  - Refresh tokens rotate. `replaced_by` chains a rotated token to its successor
 *    so a replayed old refresh token is detectable rather than merely invalid.
 */
export const migration032: Migration = {
  version: 32,
  name: 'oauth-remote-mcp',
  up: (db) => {
    db.exec(`
      CREATE TABLE oauth_clients (
        client_id       TEXT PRIMARY KEY,              -- issued at registration
        client_name     TEXT,                          -- self-reported, display only
        redirect_uris   TEXT NOT NULL,                 -- JSON array; exact-match on use
        created_at      TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE oauth_codes (
        code_hash       TEXT PRIMARY KEY,              -- sha256 of the authorization code
        client_id       TEXT NOT NULL,
        redirect_uri    TEXT NOT NULL,                 -- must match again at redemption
        code_challenge  TEXT NOT NULL,                 -- PKCE S256 challenge
        resource        TEXT,                          -- RFC 8707 audience requested
        scope           TEXT,
        expires_at      TEXT NOT NULL,                 -- short: seconds, not minutes
        redeemed_at     TEXT                           -- non-null once used; blocks replay
      );

      CREATE TABLE oauth_tokens (
        token_hash      TEXT PRIMARY KEY,              -- sha256 of the access token
        client_id       TEXT NOT NULL,
        resource        TEXT,                          -- audience; checked on every request
        scope           TEXT,
        expires_at      TEXT NOT NULL,
        refresh_hash    TEXT,                          -- sha256 of the paired refresh token
        refresh_expires_at TEXT,
        revoked_at      TEXT,
        replaced_by     TEXT,                          -- token_hash of the rotation successor
        created_at      TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE INDEX idx_oauth_tokens_refresh ON oauth_tokens(refresh_hash);
      CREATE INDEX idx_oauth_codes_expires ON oauth_codes(expires_at);
    `);
  },
};
