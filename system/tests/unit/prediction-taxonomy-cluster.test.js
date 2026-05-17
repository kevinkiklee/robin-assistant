// prediction-taxonomy-cluster.test.js — pure unit tests for greedyCluster.
//
// Tests:
//  1. 5 vectors with known pairwise similarity → expected cluster grouping.
//  2. Threshold tuning: lowering from 0.75 to 0.65 merges borderline cluster.
//  3. Single-element clusters remain until a close enough item arrives.
//  4. Items with missing embedding are skipped.
//  5. Empty input returns empty output.
//  6. All identical vectors collapse into one cluster.
//  7. cosineSim edge cases: mismatched lengths, zero vectors.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cosineSim, greedyCluster } from '../../cognition/dream/prediction-taxonomy-cluster.js';

// ── cosineSim unit tests ──────────────────────────────────────────────────────

test('cosineSim: identical unit vectors → 1.0', () => {
  const v = [1, 0, 0];
  assert.ok(Math.abs(cosineSim(v, v) - 1.0) < 1e-9);
});

test('cosineSim: orthogonal vectors → 0', () => {
  assert.ok(Math.abs(cosineSim([1, 0], [0, 1])) < 1e-9);
});

test('cosineSim: anti-parallel vectors → -1', () => {
  assert.ok(Math.abs(cosineSim([1, 0], [-1, 0]) + 1.0) < 1e-9);
});

test('cosineSim: zero vector → 0 (no divide by zero)', () => {
  assert.equal(cosineSim([0, 0, 0], [1, 2, 3]), 0);
});

test('cosineSim: mismatched lengths → 0', () => {
  assert.equal(cosineSim([1, 2], [1, 2, 3]), 0);
});

test('cosineSim: null inputs → 0', () => {
  assert.equal(cosineSim(null, [1, 2]), 0);
  assert.equal(cosineSim([1, 2], null), 0);
  assert.equal(cosineSim(null, null), 0);
});

test('cosineSim: Float32Array inputs', () => {
  const a = Float32Array.from([1, 0]);
  const b = Float32Array.from([0, 1]);
  assert.ok(Math.abs(cosineSim(a, b)) < 1e-6);
  const c = Float32Array.from([1, 0]);
  assert.ok(Math.abs(cosineSim(a, c) - 1.0) < 1e-6);
});

// ── Helpers for clustering tests ──────────────────────────────────────────────

/**
 * Build a unit-normalised 2D vector at a given angle (degrees).
 * angle=0 → [1,0]; angle=90 → [0,1].
 */
function unitVec2(angleDeg) {
  const r = (angleDeg * Math.PI) / 180;
  return [Math.cos(r), Math.sin(r)];
}

/**
 * Make a fake prediction item with a 2D unit vector.
 */
function item(id, angleDeg) {
  return { id, embedding: unitVec2(angleDeg) };
}

// ── greedyCluster unit tests ──────────────────────────────────────────────────

test('empty input → empty output', () => {
  assert.deepEqual(greedyCluster([]), []);
});

test('single item → one singleton cluster', () => {
  const result = greedyCluster([item('a', 0)]);
  assert.equal(result.length, 1);
  assert.deepEqual(result[0].ids, ['a']);
});

test('5 vectors: two tight groups + 1 singleton', () => {
  // Group A: 0°, 5°, 8°   → cos between members ≥ 0.99 → merge at 0.75
  // Group B: 90°, 92°     → cos between members ≥ 0.99 → merge at 0.75
  // cos(0°, 90°) = 0 → different clusters
  const items = [item('a1', 0), item('a2', 5), item('a3', 8), item('b1', 90), item('b2', 92)];
  const clusters = greedyCluster(items, 0.75);
  assert.equal(clusters.length, 2);

  const clusterSizes = clusters.map((c) => c.ids.length).sort((a, b) => a - b);
  assert.deepEqual(clusterSizes, [2, 3]);

  // a1, a2, a3 should share a cluster.
  const clusterA = clusters.find((c) => c.ids.includes('a1'));
  assert.ok(clusterA, 'cluster containing a1 should exist');
  assert.ok(clusterA.ids.includes('a2'), 'a2 should be with a1');
  assert.ok(clusterA.ids.includes('a3'), 'a3 should be with a1');

  // b1, b2 should share a cluster.
  const clusterB = clusters.find((c) => c.ids.includes('b1'));
  assert.ok(clusterB, 'cluster containing b1 should exist');
  assert.ok(clusterB.ids.includes('b2'), 'b2 should be with b1');
});

test('threshold tuning: 0.75 keeps singletons that 0.65 merges', () => {
  // cos(0°, 45°) = √2/2 ≈ 0.7071 — below 0.75 but above 0.65
  const items = [item('x', 0), item('y', 45)];

  const strict = greedyCluster(items, 0.75);
  assert.equal(strict.length, 2, 'at 0.75 threshold, distinct clusters');

  const relaxed = greedyCluster(items, 0.65);
  assert.equal(relaxed.length, 1, 'at 0.65 threshold, merged into one cluster');
  assert.equal(relaxed[0].ids.length, 2);
});

test('singleton stays singleton until a close item arrives', () => {
  // Two far vectors: each starts as a singleton.
  const afterTwo = greedyCluster([item('p', 0), item('q', 80)], 0.75);
  assert.equal(afterTwo.length, 2);
  assert.ok(
    afterTwo.every((c) => c.ids.length === 1),
    'both should be singletons',
  );

  // Adding a near neighbor to p merges into its cluster.
  const afterThree = greedyCluster([item('p', 0), item('q', 80), item('r', 10)], 0.75);
  // r at 10° is close to p at 0° (cos ≈ 0.985) → merges into p's cluster.
  assert.equal(afterThree.length, 2);
  const clusterP = afterThree.find((c) => c.ids.includes('p'));
  assert.ok(clusterP?.ids.includes('r'), 'r should merge into p cluster');
  assert.ok(!clusterP?.ids.includes('q'), 'q should not be in p cluster');
});

test('items with missing embedding are skipped', () => {
  const items = [
    item('a', 0),
    { id: 'no-vec', embedding: null },
    { id: 'empty-vec', embedding: [] },
    item('b', 5),
  ];
  const clusters = greedyCluster(items, 0.75);
  // 'a' and 'b' should cluster together (cos ≈ 0.996 ≥ 0.75).
  assert.equal(clusters.length, 1);
  assert.ok(clusters[0].ids.includes('a'));
  assert.ok(clusters[0].ids.includes('b'));
  // Null/empty-embedding items should be absent.
  assert.ok(!clusters[0].ids.includes('no-vec'));
  assert.ok(!clusters[0].ids.includes('empty-vec'));
});

test('all identical vectors collapse into one cluster', () => {
  const v = [1, 0, 0];
  const items = ['a', 'b', 'c', 'd'].map((id) => ({ id, embedding: v }));
  const clusters = greedyCluster(items, 0.75);
  assert.equal(clusters.length, 1);
  assert.equal(clusters[0].ids.length, 4);
});

test('centroid is exported per cluster', () => {
  const result = greedyCluster([item('a', 0), item('b', 0)], 0.75);
  assert.equal(result.length, 1);
  assert.ok(Array.isArray(result[0].centroid), 'centroid should be an array');
  assert.equal(result[0].centroid.length, 2);
});

test('order of items affects which cluster each item joins (greedy)', () => {
  // Three vectors: a at 0°, b at 180° (opposite), c at 10° (close to a).
  // Greedy order: a → own cluster; b → its own cluster (cos(b,a)=-1 < 0.75);
  // c → joins a's cluster (cos(c,a)≈0.985 ≥ 0.75).
  const items = [item('a', 0), item('b', 180), item('c', 10)];
  const clusters = greedyCluster(items, 0.75);
  assert.equal(clusters.length, 2);
  const clusterA = clusters.find((c) => c.ids.includes('a'));
  assert.ok(clusterA?.ids.includes('c'), 'c joins a cluster');
  assert.ok(!clusterA?.ids.includes('b'), 'b stays separate');
});
