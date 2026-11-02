import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isAllowedRedirectUri, parseRedirectHosts } from './redirect.ts';

test('redirect: claude.ai and claude.com callbacks are allowed, subdomains included', () => {
  for (const uri of [
    'https://claude.ai/api/mcp/auth_callback',
    'https://claude.com/api/mcp/auth_callback',
    'https://www.claude.ai/cb',
    'https://a.b.claude.com/cb',
    'https://CLAUDE.AI/cb',
  ]) {
    assert.equal(isAllowedRedirectUri(uri), true, uri);
  }
});

test('redirect: loopback over http is allowed for local testing', () => {
  for (const uri of [
    'http://localhost:3000/callback',
    'http://127.0.0.1:41274/cb',
    'http://localhost/cb',
  ]) {
    assert.equal(isAllowedRedirectUri(uri), true, uri);
  }
});

test('redirect: anything else is refused', () => {
  for (const uri of [
    'https://evil.example/cb',
    // Lookalikes: suffix without a dot boundary, and claude.ai as a subdomain.
    'https://evilclaude.ai/cb',
    'https://claude.ai.evil.example/cb',
    // Userinfo that reads like the right host to a human.
    'https://claude.ai@evil.example/cb',
    'https://user@claude.ai/cb',
    // Plain http to a real host, and https to loopback isn't the local-test path.
    'http://claude.ai/cb',
    'http://localhost.evil.example/cb',
    'http://127.0.0.2/cb',
    // Fragments are forbidden in redirect URIs (RFC 6749 §3.1.2).
    'https://claude.ai/cb#frag',
    // Not URLs at all, or the wrong scheme.
    'javascript:alert(1)',
    'claude.ai/cb',
    '',
    'custom-scheme://claude.ai/cb',
  ]) {
    assert.equal(isAllowedRedirectUri(uri), false, uri);
  }
});

test('redirect: extra hosts extend the allowlist, https only', () => {
  const extra = ['connector.example.com'];
  assert.equal(isAllowedRedirectUri('https://connector.example.com/cb', extra), true);
  assert.equal(isAllowedRedirectUri('https://eu.connector.example.com/cb', extra), true);
  assert.equal(isAllowedRedirectUri('http://connector.example.com/cb', extra), false);
  assert.equal(isAllowedRedirectUri('https://example.com/cb', extra), false);
});

test('redirect: the extra-host list is parsed from a comma-separated value', () => {
  assert.deepEqual(parseRedirectHosts(undefined), []);
  assert.deepEqual(parseRedirectHosts('  '), []);
  assert.deepEqual(parseRedirectHosts(' A.example.com , b.example.org,, '), [
    'a.example.com',
    'b.example.org',
  ]);
});

test('redirect: an extra host that would open the allowlist wide is refused', () => {
  for (const bad of ['*', '*.example.com', 'com', 'https://a.example.com', 'a.example.com/cb']) {
    assert.throws(() => parseRedirectHosts(bad), /ROBIN_MCP_REDIRECT_HOSTS/, bad);
  }
});
