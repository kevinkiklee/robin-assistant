// calibration-bucket-math.test.js — pure unit tests for the math module.
// No DB, no embedder, no network. Always fast.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  BOOTSTRAP_THRESHOLD,
  bootstrapBucket,
  bucketingMode,
  computeBuckets,
  laplaceAccuracy,
  matureBucket,
  rawAccuracy,
} from '../../cognition/dream/calibration-bucket-math.js';

// ---------------------------------------------------------------------------
// Bootstrap bucketing
// ---------------------------------------------------------------------------

test('bootstrapBucket: 0.0 → low', () => {
  assert.equal(bootstrapBucket(0.0), 'low');
});

test('bootstrapBucket: 0.1 → low', () => {
  assert.equal(bootstrapBucket(0.1), 'low');
});

test('bootstrapBucket: 0.39 → low (boundary - 1)', () => {
  assert.equal(bootstrapBucket(0.39), 'low');
});

test('bootstrapBucket: 0.4 → mid (boundary)', () => {
  assert.equal(bootstrapBucket(0.4), 'mid');
});

test('bootstrapBucket: 0.6 → mid', () => {
  assert.equal(bootstrapBucket(0.6), 'mid');
});

test('bootstrapBucket: 0.69 → mid (boundary - 1)', () => {
  assert.equal(bootstrapBucket(0.69), 'mid');
});

test('bootstrapBucket: 0.7 → high (boundary)', () => {
  assert.equal(bootstrapBucket(0.7), 'high');
});

test('bootstrapBucket: 0.9 → high', () => {
  assert.equal(bootstrapBucket(0.9), 'high');
});

test('bootstrapBucket: 1.0 → high', () => {
  assert.equal(bootstrapBucket(1.0), 'high');
});

test('bootstrapBucket: 0.3 → low', () => {
  assert.equal(bootstrapBucket(0.3), 'low');
});

// ---------------------------------------------------------------------------
// Mature bucketing
// ---------------------------------------------------------------------------

test('matureBucket: 0.0 → 0.0', () => {
  assert.equal(matureBucket(0.0), 0.0);
});

test('matureBucket: 0.1 → 0.1', () => {
  assert.equal(matureBucket(0.1), 0.1);
});

test('matureBucket: 0.3 → 0.3', () => {
  assert.equal(matureBucket(0.3), 0.3);
});

test('matureBucket: 0.4 → 0.4', () => {
  assert.equal(matureBucket(0.4), 0.4);
});

test('matureBucket: 0.6 → 0.6', () => {
  assert.equal(matureBucket(0.6), 0.6);
});

test('matureBucket: 0.7 → 0.7', () => {
  assert.equal(matureBucket(0.7), 0.7);
});

test('matureBucket: 0.9 → 0.9', () => {
  assert.equal(matureBucket(0.9), 0.9);
});

test('matureBucket: 1.0 → 0.9 (collapses into 0.9 bucket)', () => {
  assert.equal(matureBucket(1.0), 0.9);
});

test('matureBucket: 0.95 → 0.9', () => {
  assert.equal(matureBucket(0.95), 0.9);
});

test('matureBucket: 0.15 → 0.1', () => {
  assert.equal(matureBucket(0.15), 0.1);
});

// ---------------------------------------------------------------------------
// Laplace accuracy
// ---------------------------------------------------------------------------

test('laplaceAccuracy: correct=0, n=0 → 1/2 = 0.5', () => {
  assert.equal(laplaceAccuracy(0, 0), 0.5);
});

test('laplaceAccuracy: correct=10, n=10 → 11/12 ≈ 0.9167', () => {
  const v = laplaceAccuracy(10, 10);
  assert.ok(Math.abs(v - 11 / 12) < 1e-9, `expected 11/12, got ${v}`);
});

test('laplaceAccuracy: correct=0, n=10 → 1/12 ≈ 0.0833', () => {
  const v = laplaceAccuracy(0, 10);
  assert.ok(Math.abs(v - 1 / 12) < 1e-9, `expected 1/12, got ${v}`);
});

test('laplaceAccuracy: correct=1, n=1 → 2/3 ≈ 0.6667', () => {
  const v = laplaceAccuracy(1, 1);
  assert.ok(Math.abs(v - 2 / 3) < 1e-9, `expected 2/3, got ${v}`);
});

// ---------------------------------------------------------------------------
// Raw accuracy
// ---------------------------------------------------------------------------

test('rawAccuracy: n=0 → null', () => {
  assert.equal(rawAccuracy(0, 0), null);
});

test('rawAccuracy: correct=2, n=3 → 2/3', () => {
  const v = rawAccuracy(2, 3);
  assert.ok(Math.abs(v - 2 / 3) < 1e-9);
});

// ---------------------------------------------------------------------------
// Bucketing mode
// ---------------------------------------------------------------------------

test('bucketingMode: n=0 → bootstrap', () => {
  assert.equal(bucketingMode(0), 'bootstrap');
});

test('bucketingMode: n=29 → bootstrap (below threshold)', () => {
  assert.equal(bucketingMode(BOOTSTRAP_THRESHOLD - 1), 'bootstrap');
});

test('bucketingMode: n=30 → mature (at threshold)', () => {
  assert.equal(bucketingMode(BOOTSTRAP_THRESHOLD), 'mature');
});

test('bucketingMode: n=100 → mature', () => {
  assert.equal(bucketingMode(100), 'mature');
});

// ---------------------------------------------------------------------------
// Transition detection: crossing n=30 → mature bucketing
// ---------------------------------------------------------------------------

test('computeBuckets: n=10 → bootstrap mode', () => {
  const preds = Array.from({ length: 10 }, (_, i) => ({
    confidence: (i + 1) / 10,
    correct: i % 2 === 0,
  }));
  const buckets = computeBuckets(preds);
  assert.ok(buckets.length > 0);
  assert.ok(
    buckets.every((b) => b.bucketing_mode === 'bootstrap'),
    'all buckets should be bootstrap',
  );
  assert.ok(
    buckets.every((b) => ['low', 'mid', 'high'].includes(b.bucket)),
    'all bucket keys should be low/mid/high',
  );
});

test('computeBuckets: n=30 → mature mode', () => {
  const preds = Array.from({ length: 30 }, (_, i) => ({
    confidence: (i % 10) / 10,
    correct: i % 3 === 0,
  }));
  const buckets = computeBuckets(preds);
  assert.ok(buckets.length > 0);
  assert.ok(
    buckets.every((b) => b.bucketing_mode === 'mature'),
    'all buckets should be mature',
  );
  assert.ok(
    buckets.every((b) => typeof b.bucket === 'number'),
    'all bucket keys should be numbers',
  );
});

// ---------------------------------------------------------------------------
// computeBuckets: correctness of Laplace + raw_accuracy
// ---------------------------------------------------------------------------

test('computeBuckets: 2 preds both correct → laplace + raw correct', () => {
  const preds = [
    { confidence: 0.5, correct: true },
    { confidence: 0.5, correct: true },
  ];
  const [b] = computeBuckets(preds);
  assert.equal(b.n, 2);
  assert.equal(b.correct, 2);
  assert.ok(Math.abs(b.accuracy - laplaceAccuracy(2, 2)) < 1e-9);
  assert.ok(Math.abs(b.raw_accuracy - 1.0) < 1e-9);
});

test('computeBuckets: empty → returns empty array', () => {
  assert.deepEqual(computeBuckets([]), []);
});

// ---------------------------------------------------------------------------
// Specific confidence values from spec
// Bootstrap: 0.0,0.1,0.3 → low; 0.4,0.6 → mid; 0.7,0.9,1.0 → high
// ---------------------------------------------------------------------------

test('bootstrap bucket placement: [0.0, 0.1, 0.3, 0.4, 0.6, 0.7, 0.9, 1.0]', () => {
  // 8 predictions → bootstrap (n < 30)
  const confidences = [0.0, 0.1, 0.3, 0.4, 0.6, 0.7, 0.9, 1.0];
  const preds = confidences.map((c) => ({ confidence: c, correct: true }));
  const buckets = computeBuckets(preds);
  const map = new Map(buckets.map((b) => [b.bucket, b]));

  assert.ok(map.has('low'), 'low bucket should exist');
  assert.ok(map.has('mid'), 'mid bucket should exist');
  assert.ok(map.has('high'), 'high bucket should exist');

  // low: 0.0, 0.1, 0.3 → n=3
  assert.equal(map.get('low').n, 3, 'low: n=3');
  // mid: 0.4, 0.6 → n=2
  assert.equal(map.get('mid').n, 2, 'mid: n=2');
  // high: 0.7, 0.9, 1.0 → n=3
  assert.equal(map.get('high').n, 3, 'high: n=3');
});

// ---------------------------------------------------------------------------
// Mature bucket placement: 0.0→0.0, 0.1→0.1, 0.3→0.3, 0.4→0.4,
//   0.6→0.6, 0.7→0.7, 0.9→0.9, 1.0→0.9
// Needs n=30 to reach mature mode. Pad with duplicates.
// ---------------------------------------------------------------------------

test('mature bucket placement: padded to n=30, confidences include 0.0..1.0 spread', () => {
  const specConfs = [0.0, 0.1, 0.3, 0.4, 0.6, 0.7, 0.9, 1.0]; // 8 distinct
  // Pad to 30 by repeating the set.
  const preds = [];
  while (preds.length < 30) {
    for (const c of specConfs) {
      if (preds.length >= 30) break;
      preds.push({ confidence: c, correct: true });
    }
  }
  assert.equal(preds.length, 30);

  const buckets = computeBuckets(preds);
  const map = new Map(buckets.map((b) => [b.bucket, b]));

  // 1.0 collapses into 0.9
  assert.ok(!map.has(1.0), '1.0 should not be its own bucket key');
  assert.ok(map.has(0.9), '0.9 bucket should absorb confidence=1.0');

  for (const c of [0.0, 0.1, 0.3, 0.4, 0.6, 0.7, 0.9]) {
    assert.ok(map.has(c), `bucket ${c} should exist`);
  }
});
