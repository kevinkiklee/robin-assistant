import assert from 'node:assert/strict';
import { test } from 'node:test';
import { judgeLag, LOOP_BLOCKED_MS } from './loop-lag.ts';

test('judgeLag: a long synchronous stall is blocked', () => {
  assert.equal(judgeLag(67_000, 0), 'blocked');
  assert.equal(judgeLag(LOOP_BLOCKED_MS, 0), 'blocked');
});

test('judgeLag: a quiet window clears; the grey zone holds', () => {
  assert.equal(judgeLag(40, 0), 'clear');
  assert.equal(judgeLag(5_000, 0), 'hold');
});

test('judgeLag: a host sleep is not a stall', () => {
  assert.equal(judgeLag(45 * 60_000, 45 * 60_000), 'hold');
});

test('judgeLag: a kernel-reported sleep holds even when monotonic time ran through it', () => {
  // macOS / Node 24: uv_hrtime counts through sleep, so drift reads ~0 and only
  // the kernel's sleep/wake record tells a 957 s nap from a 957 s stall.
  assert.equal(judgeLag(957_778, 0, true), 'hold');
  assert.equal(judgeLag(957_778, 0, false), 'blocked');
});
