import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  REMOTE_PUBLIC_URL_ENV,
  REMOTE_REDIRECT_HOSTS_ENV,
  REMOTE_TOKEN_ENV,
  resolvePublicUrl,
  resolveRedirectHosts,
  resolveRemoteToken,
} from './run.ts';

test('remote mcp: an unset token stops the server rather than opening it up', () => {
  assert.throws(
    () => resolveRemoteToken({}),
    (err: Error) => {
      // The message has to carry the fix — this fires on a machine where the
      // operator is mid-tunnel-setup and needs the env var name and a way to
      // mint a value, not just "missing token".
      assert.match(err.message, new RegExp(REMOTE_TOKEN_ENV));
      assert.match(err.message, /openssl|randomBytes|base64/i);
      return true;
    },
  );
});

test('remote mcp: a configured token is returned verbatim, whitespace trimmed', () => {
  const token = `  ${'z'.repeat(43)}\n`;
  assert.equal(resolveRemoteToken({ [REMOTE_TOKEN_ENV]: token }), 'z'.repeat(43));
});

test('remote mcp: a whitespace-only token counts as unset', () => {
  assert.throws(
    () => resolveRemoteToken({ [REMOTE_TOKEN_ENV]: '   ' }),
    new RegExp(REMOTE_TOKEN_ENV),
  );
});

test('remote mcp: an unset public URL stops the server rather than guessing one', () => {
  assert.throws(
    () => resolvePublicUrl({}),
    (err: Error) => {
      assert.match(err.message, new RegExp(REMOTE_PUBLIC_URL_ENV));
      return true;
    },
  );
});

test('remote mcp: the public URL is normalised to a bare https origin', () => {
  // OAuth metadata must advertise absolute URLs; a trailing path or slash would
  // produce metadata that doesn't match what the client reached.
  assert.equal(
    resolvePublicUrl({ [REMOTE_PUBLIC_URL_ENV]: 'https://mcp.example.com/' }),
    'https://mcp.example.com',
  );
  assert.equal(
    resolvePublicUrl({ [REMOTE_PUBLIC_URL_ENV]: 'https://mcp.example.com/mcp' }),
    'https://mcp.example.com',
  );
});

test('remote mcp: a non-https public URL is refused', () => {
  // OAuth 2.1 requires HTTPS for authorization server endpoints.
  assert.throws(
    () => resolvePublicUrl({ [REMOTE_PUBLIC_URL_ENV]: 'http://mcp.example.com' }),
    /https/,
  );
});

test('remote mcp: extra redirect hosts are optional and read from the env', () => {
  assert.equal(REMOTE_REDIRECT_HOSTS_ENV, 'ROBIN_MCP_REDIRECT_HOSTS');
  assert.deepEqual(resolveRedirectHosts({}), []);
  assert.deepEqual(
    resolveRedirectHosts({ [REMOTE_REDIRECT_HOSTS_ENV]: 'a.example.com, b.example.org' }),
    ['a.example.com', 'b.example.org'],
  );
  // A wildcard would undo the allowlist; it must stop the server instead.
  assert.throws(
    () => resolveRedirectHosts({ [REMOTE_REDIRECT_HOSTS_ENV]: '*' }),
    new RegExp(REMOTE_REDIRECT_HOSTS_ENV),
  );
});
