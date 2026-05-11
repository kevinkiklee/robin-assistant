import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cosineSim } from '../../cognition/intuition/vectors.js';

test('cosineSim: identical vectors → 1', () => {
  const a = new Float32Array([1, 2, 3, 4]);
  const b = new Float32Array([1, 2, 3, 4]);
  assert.ok(Math.abs(cosineSim(a, b) - 1.0) < 1e-6);
});

test('cosineSim: orthogonal vectors → 0', () => {
  const a = new Float32Array([1, 0, 0, 0]);
  const b = new Float32Array([0, 1, 0, 0]);
  assert.equal(cosineSim(a, b), 0);
});

test('cosineSim: opposite vectors → -1', () => {
  const a = new Float32Array([1, 0, 0, 0]);
  const b = new Float32Array([-1, 0, 0, 0]);
  assert.ok(Math.abs(cosineSim(a, b) + 1.0) < 1e-6);
});

test('cosineSim: mismatched length → 0 (fail-soft)', () => {
  const a = new Float32Array([1, 2, 3]);
  const b = new Float32Array([1, 2, 3, 4]);
  assert.equal(cosineSim(a, b), 0);
});

test('cosineSim: null/undefined → 0', () => {
  assert.equal(cosineSim(null, new Float32Array([1])), 0);
  assert.equal(cosineSim(new Float32Array([1]), undefined), 0);
});
