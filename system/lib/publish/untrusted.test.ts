import assert from 'node:assert/strict';
import { test } from 'node:test';
import { shouldRefuseUntrusted, stripUntrustedBlocks } from './untrusted.ts';

test('shouldRefuseUntrusted: refuses when frontmatter.trust is in marker set', () => {
  assert.equal(shouldRefuseUntrusted({ trust: 'untrusted' }, false), true);
  assert.equal(shouldRefuseUntrusted({ trust: 'untrusted-mixed' }, false), true);
});

test('shouldRefuseUntrusted: --force-untrusted overrides', () => {
  assert.equal(shouldRefuseUntrusted({ trust: 'untrusted' }, true), false);
});

test('shouldRefuseUntrusted: trusted/missing frontmatter passes through', () => {
  assert.equal(shouldRefuseUntrusted({ trust: 'trusted' }, false), false);
  assert.equal(shouldRefuseUntrusted({}, false), false);
  assert.equal(shouldRefuseUntrusted(undefined, false), false);
});

test('stripUntrustedBlocks: removes paired START/END blocks', () => {
  const body = 'before\n<!-- UNTRUSTED-START -->\ndanger\n<!-- UNTRUSTED-END -->\nafter';
  const r = stripUntrustedBlocks(body);
  assert.equal(r.removed, 1);
  assert.ok(!r.body.includes('danger'));
  assert.match(r.body, /before/);
  assert.match(r.body, /after/);
});

test('stripUntrustedBlocks: unterminated UNTRUSTED-START strips to end of doc', () => {
  const body = 'before\n<!-- UNTRUSTED-START -->\ndanger to the end';
  const r = stripUntrustedBlocks(body);
  assert.equal(r.removed, 1);
  assert.ok(!r.body.includes('danger'));
});

test('stripUntrustedBlocks: no markers is a no-op', () => {
  const body = 'plain content\n\nno markers here';
  const r = stripUntrustedBlocks(body);
  assert.equal(r.removed, 0);
  assert.equal(r.body, body);
});
