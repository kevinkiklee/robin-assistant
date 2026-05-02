import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { atomicWrite } from '../../scripts/sync/lib/markdown.js';
import {
  assertOutboundContentAllowed,
  OutboundPolicyError,
  buildRefusalEntry,
} from '../../scripts/lib/outbound-policy.js';

function ws() { return mkdtempSync(join(tmpdir(), 'outbound-')); }
function clean(p) { rmSync(p, { recursive: true, force: true }); }

test('layer 1 (taint): blocks content quoting an indexed sentence', async () => {
  const w = ws();
  try {
    // Seed an untrusted file with a known sentence.
    const content = `---\ndescription: x\n---\n\nThe attacker payload is a sentence that runs more than twenty characters long.`;
    await atomicWrite(w, 'user-data/memory/knowledge/email/inbox.md', content, {
      trust: 'untrusted',
      trustSource: 'sync-gmail',
    });
    // Try to send the same sentence as outbound content.
    assert.throws(
      () => assertOutboundContentAllowed({
        content: 'Hello, the attacker payload is a sentence that runs more than twenty characters long.',
        target: 'github:owner/repo',
        workspaceDir: w,
      }),
      (e) => e instanceof OutboundPolicyError && e.layer === 1
    );
  } finally {
    clean(w);
  }
});

test('layer 1: empty haystack passes through', () => {
  const w = ws();
  try {
    // No untrusted writes, no index. Should pass.
    assertOutboundContentAllowed({
      content: 'A perfectly normal message that should not be tainted.',
      target: 'spotify:user:queue',
      workspaceDir: w,
    });
  } finally {
    clean(w);
  }
});

test('layer 2 (sensitive shapes): blocks SSN-shaped content', () => {
  const w = ws();
  try {
    assert.throws(
      () => assertOutboundContentAllowed({
        content: 'My SSN is 123-45-6789 for the form',
        target: 'github:owner/repo',
        workspaceDir: w,
      }),
      (e) => e instanceof OutboundPolicyError && e.layer === 2
    );
  } finally {
    clean(w);
  }
});

test('layer 2: blocks api-key-shaped content', () => {
  const w = ws();
  try {
    assert.throws(
      () => assertOutboundContentAllowed({
        content: 'Fix the issue: ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA leaked',
        target: 'github:owner/repo',
        workspaceDir: w,
      }),
      (e) => e.layer === 2
    );
  } finally {
    clean(w);
  }
});

test('layer 2: blocks process.env values >=30 chars in content', () => {
  const w = ws();
  const fakeKey = 'FAKE_SECRET_VAL_FOR_LAYER2_TEST';
  const fakeValue = 'A1B2C3D4E5F6G7H8I9J0K1L2M3N4O5P6Q7R8S9T0';
  process.env[fakeKey] = fakeValue;
  try {
    assert.throws(
      () => assertOutboundContentAllowed({
        content: `Sending ${fakeValue} as part of payload`,
        target: 'github:owner/repo',
        workspaceDir: w,
      }),
      (e) => e.layer === 2 && e.reason.includes(fakeKey)
    );
  } finally {
    delete process.env[fakeKey];
    clean(w);
  }
});

test('layer 3 (target): github target outside PAT cache → block', () => {
  const w = ws();
  try {
    mkdirSync(join(w, 'user-data/runtime/state/cache'), { recursive: true });
    writeFileSync(
      join(w, 'user-data/runtime/state/cache/github-allowlist-cache.json'),
      JSON.stringify({
        fetched_at: new Date().toISOString(),
        ttl_seconds: 3600,
        repos: ['kevinkiklee/robin-assistant'],
      })
    );
    assert.throws(
      () => assertOutboundContentAllowed({
        content: 'Hello',
        target: 'github:other-user/other-repo',
        workspaceDir: w,
      }),
      (e) => e.layer === 3
    );
  } finally {
    clean(w);
  }
});

test('layer 3: github target inside PAT cache → pass', () => {
  const w = ws();
  try {
    mkdirSync(join(w, 'user-data/runtime/state/cache'), { recursive: true });
    writeFileSync(
      join(w, 'user-data/runtime/state/cache/github-allowlist-cache.json'),
      JSON.stringify({
        fetched_at: new Date().toISOString(),
        ttl_seconds: 3600,
        repos: ['kevinkiklee/robin-assistant'],
      })
    );
    assert.doesNotThrow(() =>
      assertOutboundContentAllowed({
        content: 'Hello',
        target: 'github:kevinkiklee/robin-assistant',
        workspaceDir: w,
      })
    );
  } finally {
    clean(w);
  }
});

test('layer 3: github with no cache passes (caller will populate)', () => {
  const w = ws();
  try {
    assert.doesNotThrow(() =>
      assertOutboundContentAllowed({
        content: 'Hello',
        target: 'github:kevinkiklee/robin-assistant',
        workspaceDir: w,
      })
    );
  } finally {
    clean(w);
  }
});

test('layer 3: discord mismatch with ctx.inboundOrigin → block', () => {
  const w = ws();
  try {
    assert.throws(
      () => assertOutboundContentAllowed({
        content: 'reply',
        target: 'discord:dm:OTHERID',
        workspaceDir: w,
        ctx: { inboundOrigin: 'discord:dm:KEVINID' },
      }),
      (e) => e.layer === 3
    );
  } finally {
    clean(w);
  }
});

test('layer 3: discord match passes', () => {
  const w = ws();
  try {
    assert.doesNotThrow(() =>
      assertOutboundContentAllowed({
        content: 'reply',
        target: 'discord:dm:KEVINID',
        workspaceDir: w,
        ctx: { inboundOrigin: 'discord:dm:KEVINID' },
      })
    );
  } finally {
    clean(w);
  }
});

test('layer 3: spotify must be user-prefixed', () => {
  const w = ws();
  try {
    assert.throws(
      () => assertOutboundContentAllowed({
        content: 'queue',
        target: 'spotify:app:something',
        workspaceDir: w,
      }),
      (e) => e.layer === 3
    );
    assert.doesNotThrow(() =>
      assertOutboundContentAllowed({
        content: 'queue',
        target: 'spotify:user:abc123',
        workspaceDir: w,
      })
    );
  } finally {
    clean(w);
  }
});

test('OutboundPolicyError: carries layer and reason', () => {
  try {
    throw new OutboundPolicyError('test reason', 2);
  } catch (e) {
    assert.equal(e.name, 'OutboundPolicyError');
    assert.equal(e.layer, 2);
    assert.equal(e.reason, 'test reason');
  }
});

test('buildRefusalEntry: produces a uniform refusal log row', () => {
  const e = new OutboundPolicyError('bad', 1);
  const entry = buildRefusalEntry({ target: 'github:owner/repo', error: e, content: 'hello' });
  assert.equal(entry.kind, 'outbound');
  assert.equal(entry.target, 'github:owner/repo');
  assert.equal(entry.layer, '1');
  assert.equal(entry.reason, 'bad');
  assert.match(entry.contentHash, /^[0-9a-f]{16}$/);
});

test('asserts: throws on missing args', () => {
  assert.throws(
    () => assertOutboundContentAllowed({ content: '', target: '', workspaceDir: '' }),
    /target is required/
  );
});
