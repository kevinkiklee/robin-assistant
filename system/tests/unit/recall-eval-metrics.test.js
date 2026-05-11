import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  meanRankOfNegatives,
  ndcgAtK,
  noSignalRate,
  precisionAtK,
  recallAtK,
} from '../../cognition/intuition/eval-metrics.js';

// Synthetic labelled rows. Each row is an array of label entries per
// labelHits()'s shape.
const ROW_ALL_POS = [
  { rank_index: 0, label: 'soft_positive' },
  { rank_index: 1, label: 'soft_positive' },
  { rank_index: 2, label: 'soft_positive' },
];
const ROW_MIXED = [
  { rank_index: 0, label: 'soft_positive' },
  { rank_index: 1, label: 'negative' },
  { rank_index: 2, label: 'unlabeled' },
];
const ROW_ALL_NEG = [
  { rank_index: 0, label: 'negative' },
  { rank_index: 1, label: 'negative' },
];

test('precisionAtK counts soft_positives / k, averaged over rows', () => {
  // ROW_ALL_POS@3 = 3/3=1.0; ROW_MIXED@3 = 1/3; avg = (1.0 + 1/3)/2 ≈ 0.6667
  const p = precisionAtK([ROW_ALL_POS, ROW_MIXED], 3);
  assert.ok(Math.abs(p - 0.6667) < 0.001, `got ${p}`);
});

test('recallAtK = soft_positives in top-k / soft_positives in full row', () => {
  // ROW_ALL_POS: top-1 has 1 sp, total sp=3 → recall@1 = 1/3
  const r = recallAtK([ROW_ALL_POS], 1);
  assert.ok(Math.abs(r - 0.3333) < 0.001, `got ${r}`);
});

test('recallAtK returns 0 for rows with zero soft_positives (avoids NaN)', () => {
  const r = recallAtK([ROW_ALL_NEG], 1);
  assert.equal(r, 0);
});

test('ndcgAtK uses non-negative gain max(0, 2^label - 1) projection', () => {
  // soft_positive=0.5 → gain = 2^0.5 - 1 ≈ 0.4142
  // negative=-1 → gain = max(0, 2^-1 - 1) = 0
  // ROW_MIXED@3 numerator: 0.4142/log2(2) + 0/log2(3) + 0/log2(4) = 0.4142
  // ideal: best gain ordering = [0.4142, 0, 0] → 0.4142
  // → nDCG@3 = 1.0
  const n = ndcgAtK([ROW_MIXED], 3);
  assert.ok(Math.abs(n - 1.0) < 0.001, `got ${n}`);
});

test('meanRankOfNegatives averages 1-indexed rank of negatives across rows', () => {
  // ROW_MIXED: negative at rank_index 1 → 1-indexed rank 2
  // ROW_ALL_NEG: negatives at 0,1 → 1-indexed ranks 1,2; row mean = 1.5
  // overall mean of row means = (2 + 1.5)/2 = 1.75
  const m = meanRankOfNegatives([ROW_MIXED, ROW_ALL_NEG]);
  assert.ok(Math.abs(m - 1.75) < 0.001, `got ${m}`);
});

test('meanRankOfNegatives returns null when no row has any negatives', () => {
  assert.equal(meanRankOfNegatives([ROW_ALL_POS]), null);
});

test('noSignalRate = count(outcome=evaluated_no_signal) / count(evaluated)', () => {
  const rows = [
    { outcome: 'reinforced' },
    { outcome: 'evaluated_no_signal' },
    { outcome: 'evaluated_no_signal' },
    { outcome: 'corrected' },
    { outcome: 'pending' }, // excluded
  ];
  const r = noSignalRate(rows);
  // evaluated = 4 (excludes pending); no_signal = 2 → 0.5
  assert.equal(r, 0.5);
});
