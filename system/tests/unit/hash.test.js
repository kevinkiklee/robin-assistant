import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sha256 } from '../../data/embed/hash.js';

test('sha256 returns a 64-char hex string', () => {
  const h = sha256('hello');
  assert.equal(h.length, 64);
  assert.match(h, /^[0-9a-f]{64}$/);
});

test('sha256 is deterministic', () => {
  assert.equal(sha256('robin'), sha256('robin'));
});

test('sha256 differs by input', () => {
  assert.notEqual(sha256('a'), sha256('b'));
});
