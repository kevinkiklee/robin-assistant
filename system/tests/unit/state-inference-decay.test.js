import assert from 'node:assert/strict';
import { test } from 'node:test';
import { freshness, HALF_LIFE_BY_KIND_MS } from '../../cognition/memory/decay.js';

test('state_inference has 6h half-life', () => {
  assert.equal(HALF_LIFE_BY_KIND_MS.state_inference, 6 * 60 * 60 * 1000);
});

test('state_inference freshness halves at 6h', () => {
  const now = new Date('2026-05-11T18:00:00Z');
  const anchor = new Date(now.getTime() - 6 * 60 * 60 * 1000);
  const memo = {
    kind: 'state_inference',
    confidence: 1,
    signal_count: 1,
    decay_anchor: anchor,
  };
  const v = freshness(memo, { now });
  // 0.5 (decay) × 1.0 (confidence) × log2(2) = 0.5
  assert.ok(Math.abs(v - 0.5) < 1e-6, `expected ~0.5, got ${v}`);
});

test('supersededCount>0 zeroes state_inference freshness', () => {
  const now = new Date();
  const memo = { kind: 'state_inference', confidence: 1, decay_anchor: now };
  assert.equal(freshness(memo, { supersededCount: 1, now }), 0);
});
