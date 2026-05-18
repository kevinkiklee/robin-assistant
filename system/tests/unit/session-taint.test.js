// system/tests/unit/session-taint.test.js

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  __resetForTests,
  clearSession,
  getSessionTaint,
  markTainted,
} from '../../runtime/mcp/session-taint.js';

test('fresh session is clean', () => {
  __resetForTests();
  const t = getSessionTaint('s1');
  assert.equal(t.tainted, false);
  assert.equal(t.sources.size, 0);
});

test('markTainted records source and flips tainted=true', () => {
  __resetForTests();
  markTainted('s1', 'events:e1');
  markTainted('s1', 'events:e2');
  const t = getSessionTaint('s1');
  assert.equal(t.tainted, true);
  assert.deepEqual([...t.sources].sort(), ['events:e1', 'events:e2']);
});

test('sessions are isolated', () => {
  __resetForTests();
  markTainted('s1', 'events:e1');
  const t2 = getSessionTaint('s2');
  assert.equal(t2.tainted, false);
});

test('clearSession removes state', () => {
  __resetForTests();
  markTainted('s1', 'events:e1');
  clearSession('s1');
  const t = getSessionTaint('s1');
  assert.equal(t.tainted, false);
});

test('null sessionId is a no-op (safe default)', () => {
  __resetForTests();
  markTainted(null, 'events:e1');
  const t = getSessionTaint(null);
  assert.equal(t.tainted, false);
});
