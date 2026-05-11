import assert from 'node:assert/strict';
import { test } from 'node:test';
import { recommendBelief } from '../../cognition/belief/recommend.js';

const CFG = { default_threshold: 0.6, soften_floor: 0.4, domain_thresholds: {} };

test('recommendBelief: >=default_threshold -> assert', () => {
  assert.equal(recommendBelief(0.7, null, 3, CFG), 'assert');
  assert.equal(recommendBelief(0.6, null, 3, CFG), 'assert');
});

test('recommendBelief: (soften_floor, default_threshold) -> soften', () => {
  assert.equal(recommendBelief(0.41, null, 3, CFG), 'soften');
  assert.equal(recommendBelief(0.59, null, 3, CFG), 'soften');
});

test('recommendBelief: <=soften_floor -> unknown', () => {
  assert.equal(recommendBelief(0.4, null, 3, CFG), 'unknown');
  assert.equal(recommendBelief(0.3, null, 3, CFG), 'unknown');
});

test('recommendBelief: zero hits -> unknown regardless of confidence', () => {
  assert.equal(recommendBelief(0.95, null, 0, CFG), 'unknown');
});

test('recommendBelief: per-domain threshold override', () => {
  const cfg = { ...CFG, domain_thresholds: { photography: 0.55 } };
  assert.equal(recommendBelief(0.56, 'photography', 3, cfg), 'assert');
  assert.equal(recommendBelief(0.56, null, 3, cfg), 'soften');
});

test('recommendBelief: full threshold table per spec §8.1 #10', () => {
  const table = [
    [0.3, 'unknown'],
    [0.39, 'unknown'],
    [0.4, 'unknown'],
    [0.41, 'soften'],
    [0.59, 'soften'],
    [0.6, 'assert'],
    [0.61, 'assert'],
  ];
  for (const [conf, expect] of table) {
    assert.equal(recommendBelief(conf, null, 3, CFG), expect, `conf=${conf}`);
  }
});
