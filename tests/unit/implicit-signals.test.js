import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRepeatQueryDetector } from '../../src/mcp/implicit-signals.js';

function vec(seed) {
  const v = new Float32Array(384);
  for (let i = 0; i < 384; i++) v[i] = Math.sin(seed + i * 0.01);
  let mag = 0;
  for (let i = 0; i < 384; i++) mag += v[i] * v[i];
  mag = Math.sqrt(mag);
  for (let i = 0; i < 384; i++) v[i] /= mag;
  return Array.from(v);
}

test('exact same vector within window flags repeat', () => {
  const det = createRepeatQueryDetector({ windowMinutes: 5, similarityThreshold: 0.95 });
  const v = vec(1);
  det.observe('s1', v);
  const r = det.check('s1', v);
  assert.equal(r.repeat, true);
});

test('different vector does not flag', () => {
  const det = createRepeatQueryDetector({ windowMinutes: 5, similarityThreshold: 0.95 });
  det.observe('s1', vec(1));
  const r = det.check('s1', vec(50));
  assert.equal(r.repeat, false);
});

test('different session does not flag', () => {
  const det = createRepeatQueryDetector({ windowMinutes: 5, similarityThreshold: 0.95 });
  const v = vec(1);
  det.observe('s1', v);
  const r = det.check('s2', v);
  assert.equal(r.repeat, false);
});
