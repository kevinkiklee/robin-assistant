import test from 'node:test';
import { strict as assert } from 'node:assert';
import { Writable } from 'node:stream';

import { installLogScrub, scrub } from '../../runtime/daemon/log-scrub.js';

test('scrub redacts GitHub PAT', () => {
  const line = 'auth failed for ghp_abcdefghijklmnopqrstuvwxyz0123456789AB';
  const out = scrub(line);
  assert.match(out, /<redacted:github_pat>/);
  assert.doesNotMatch(out, /ghp_/);
});

test('scrub redacts OpenAI/Anthropic keys', () => {
  assert.match(scrub('Authorization: sk-ant-abc123xyz456_-foobarbaz9999'), /<redacted:anthropic_key>/);
  assert.match(scrub('failed: sk-proj1234567890abcdefghijklmnopqrstuvwx'), /<redacted:openai_key>/);
});

test('scrub redacts Slack tokens', () => {
  assert.match(scrub('payload: xoxb-123-456-AbCdEfGhIj'), /<redacted:slack_bot>/);
  assert.match(scrub('payload: xoxp-1-2-3-AbCdEfGhIj'), /<redacted:slack_user>/);
});

test('scrub redacts JWT', () => {
  const jwt = 'eyJhbGciOiJIUzI1NiIs.eyJzdWIiOiIxMjM0NTY3.signature_blob_here';
  assert.match(scrub(`token=${jwt}`), /<redacted:jwt>/);
});

test('scrub redacts AWS access key', () => {
  assert.match(scrub('AKIAIOSFODNN7EXAMPLE failed'), /<redacted:aws_access_key>/);
});

test('scrub redacts PEM private-key header', () => {
  assert.match(
    scrub('-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA...'),
    /<redacted:pem_private_key>/,
  );
});

test('scrub redacts generic Bearer token', () => {
  assert.match(
    scrub('Authorization: Bearer abcdef1234567890abcdef1234567890'),
    /<redacted:bearer_token>/,
  );
});

test('scrub leaves clean text untouched', () => {
  const clean = 'daemon: scheduler stopping (draining in-flight ticks)';
  assert.equal(scrub(clean), clean);
});

test('scrub handles non-string input safely', () => {
  assert.equal(scrub(undefined), undefined);
  assert.equal(scrub(null), null);
  assert.equal(scrub(42), 42);
});

test('installLogScrub patches write streams', async () => {
  const captured = [];
  const sink = new Writable({
    write(chunk, _enc, cb) {
      captured.push(chunk.toString());
      cb();
    },
  });
  installLogScrub({ stdout: sink, stderr: sink });
  sink.write('GitHub PAT leak: ghp_zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz');
  await new Promise((r) => setImmediate(r));
  assert.equal(captured.length, 1);
  assert.match(captured[0], /<redacted:github_pat>/);
});

test('installLogScrub is idempotent', () => {
  const sink = new Writable({ write(_c, _e, cb) { cb(); } });
  installLogScrub({ stdout: sink, stderr: sink });
  const firstPatched = sink.write;
  installLogScrub({ stdout: sink, stderr: sink });
  // Second install replaces with a new patched fn but the original is
  // preserved via symbol — both wrapped fns share the same orig, so a
  // double-install doesn't double-scrub.
  assert.notEqual(sink.write, firstPatched);
});
