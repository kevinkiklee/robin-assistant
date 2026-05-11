import assert from 'node:assert/strict';
import { test } from 'node:test';
import { aggregateBelief } from '../../cognition/belief/aggregate.js';

const DEFAULT_CFG = {
  relevance_threshold: 0.3,
  confidence_floor: 0.05,
};

test('aggregateBelief: weighted-average math (deterministic)', () => {
  // Three hits, structural-weight = signal_count × decay × relevance pre-normalised
  // to [0.5, 0.3, 0.2] (sum=1), derived = [0.9, 0.6, 0.3]. Expected: 0.69.
  const hits = [
    { id: 'memos:a', dist: 0.0, structural: 0.5, derived: 0.9 },
    { id: 'memos:b', dist: 0.0, structural: 0.3, derived: 0.6 },
    { id: 'memos:c', dist: 0.0, structural: 0.2, derived: 0.3 },
  ];
  const r = aggregateBelief(hits, DEFAULT_CFG);
  assert.ok(Math.abs(r.aggregate - 0.69) < 1e-6, `got ${r.aggregate}`);
  assert.equal(r.k_returned, 3);
  assert.equal(r.fallback_path, null);
  // Weights sum to 1.
  assert.ok(Math.abs(r.weights.reduce((a, b) => a + b, 0) - 1) < 1e-9);
  // Weights returned in descending order.
  assert.deepEqual(
    [...r.weights].sort((a, b) => b - a),
    [...r.weights],
    'weights returned in descending order',
  );
});

test('aggregateBelief: all-zero weights → divide-by-zero guard (no NaN)', () => {
  const hits = [
    { id: 'memos:a', dist: 0.1, structural: 0, derived: 0.9 },
    { id: 'memos:b', dist: 0.2, structural: 0, derived: 0.4 },
  ];
  const r = aggregateBelief(hits, DEFAULT_CFG);
  assert.equal(r.aggregate, 0);
  assert.equal(r.fallback_path, 'no_hits');
  assert.equal(r.k_returned, 0);
  assert.ok(!Number.isNaN(r.aggregate));
});

test('aggregateBelief: empty hits → fallback_path=no_hits, aggregate=0', () => {
  const r = aggregateBelief([], DEFAULT_CFG);
  assert.equal(r.aggregate, 0);
  assert.equal(r.k_returned, 0);
  assert.equal(r.fallback_path, 'no_hits');
});

test('aggregateBelief: drops hits below relevance_threshold (cosine = 1 - dist)', () => {
  const hits = [
    { id: 'memos:a', dist: 0.1, structural: 0.5, derived: 0.9 }, // cos=0.90 keep
    { id: 'memos:b', dist: 0.6, structural: 0.5, derived: 0.4 }, // cos=0.40 keep
    { id: 'memos:c', dist: 0.85, structural: 0.5, derived: 0.5 }, // cos=0.15 drop
  ];
  const r = aggregateBelief(hits, DEFAULT_CFG);
  assert.equal(r.k_returned, 2);
  assert.equal(r.hits_dropped_relevance, 1);
});

test('aggregateBelief: every hit below relevance → fallback_path=all_below_relevance', () => {
  const hits = [
    { id: 'memos:a', dist: 0.9, structural: 0.5, derived: 0.9 },
    { id: 'memos:b', dist: 0.95, structural: 0.5, derived: 0.7 },
  ];
  const r = aggregateBelief(hits, DEFAULT_CFG);
  assert.equal(r.aggregate, 0);
  assert.equal(r.k_returned, 0);
  assert.equal(r.fallback_path, 'all_below_relevance');
  assert.equal(r.hits_dropped_relevance, 2);
});

test('aggregateBelief: drops hits below confidence_floor; folded into hits_dropped_relevance counter', () => {
  const hits = [
    { id: 'memos:a', dist: 0.1, structural: 0.5, derived: 0.9 }, // keep
    { id: 'memos:b', dist: 0.1, structural: 0.5, derived: 0.02 }, // drop (below 0.05)
  ];
  const r = aggregateBelief(hits, DEFAULT_CFG);
  assert.equal(r.k_returned, 1);
  assert.equal(r.hits_dropped_relevance, 1);
});

test('aggregateBelief: deterministic ordering of evidence (descending weight)', () => {
  const hits = [
    { id: 'memos:c', dist: 0.0, structural: 0.1, derived: 0.5 },
    { id: 'memos:a', dist: 0.0, structural: 0.6, derived: 0.5 },
    { id: 'memos:b', dist: 0.0, structural: 0.3, derived: 0.5 },
  ];
  const r = aggregateBelief(hits, DEFAULT_CFG);
  assert.deepEqual(r.kept_ids, ['memos:a', 'memos:b', 'memos:c']);
});
