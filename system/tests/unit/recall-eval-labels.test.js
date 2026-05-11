import assert from 'node:assert/strict';
import { test } from 'node:test';
import { labelHits } from '../../cognition/intuition/eval-labels.js';

test('labelHits marks memos:* hits negative when outcome=corrected', () => {
  const row = {
    id: 'recall_log:r1',
    ts: new Date('2026-05-01T12:00:00Z'),
    session_id: 's1',
    outcome: 'corrected',
    ranked_hits: [
      { record: 'memos:m1', rank: 0 },
      { record: 'events:e1', rank: 1 },
      { record: 'memos:m2', rank: 2 },
    ],
  };
  const labels = labelHits(row, []);
  assert.deepEqual(
    labels.map((l) => l.label),
    ['negative', 'unlabeled', 'negative'],
  );
});

test('labelHits marks memos:* hits soft_positive when outcome=reinforced', () => {
  const row = {
    id: 'recall_log:r2',
    ts: new Date('2026-05-01T12:00:00Z'),
    session_id: 's1',
    outcome: 'reinforced',
    ranked_hits: [
      { record: 'memos:m1', rank: 0 },
      { record: 'memos:m2', rank: 1 },
    ],
  };
  const labels = labelHits(row, []);
  assert.deepEqual(
    labels.map((l) => l.label),
    ['soft_positive', 'soft_positive'],
  );
});

test('labelHits marks all hits unlabeled when outcome=pending or evaluated_no_signal', () => {
  const r1 = {
    id: 'recall_log:r3',
    ts: new Date(),
    outcome: 'pending',
    ranked_hits: [{ record: 'memos:m1', rank: 0 }],
  };
  const r2 = {
    id: 'recall_log:r4',
    ts: new Date(),
    outcome: 'evaluated_no_signal',
    ranked_hits: [{ record: 'memos:m1', rank: 0 }],
  };
  assert.equal(labelHits(r1, [])[0].label, 'unlabeled');
  assert.equal(labelHits(r2, [])[0].label, 'unlabeled');
});

test('labelHits attaches rank_index and record_id for downstream metrics', () => {
  const row = {
    id: 'recall_log:r5',
    ts: new Date(),
    outcome: 'reinforced',
    ranked_hits: [
      { record: 'memos:m1', rank: 0 },
      { record: 'memos:m2', rank: 1 },
    ],
  };
  const labels = labelHits(row, []);
  assert.equal(labels[0].rank_index, 0);
  assert.equal(labels[0].record_id, 'memos:m1');
  assert.equal(labels[1].rank_index, 1);
});
