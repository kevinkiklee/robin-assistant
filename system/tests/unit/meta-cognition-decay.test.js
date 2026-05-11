import assert from 'node:assert/strict';
import { test } from 'node:test';
import { freshness, HALF_LIFE_BY_KIND_MS } from '../../cognition/memory/decay.js';

test('reasoning has 30d half-life', () => {
  assert.equal(HALF_LIFE_BY_KIND_MS.reasoning, 30 * 24 * 60 * 60 * 1000);
});

test('reasoning freshness halves at 30d', () => {
  const now = new Date('2026-05-11T18:00:00Z');
  const anchor = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  const memo = { kind: 'reasoning', confidence: 1, signal_count: 1, decay_anchor: anchor };
  const v = freshness(memo, { now });
  // 0.5 (decay) × 1.0 (confidence) × log2(2) = 0.5
  assert.ok(Math.abs(v - 0.5) < 1e-6, `expected ~0.5, got ${v}`);
});

test('supersededCount>0 zeroes reasoning freshness', () => {
  const now = new Date();
  const memo = { kind: 'reasoning', confidence: 1, decay_anchor: now };
  assert.equal(freshness(memo, { supersededCount: 1, now }), 0);
});
