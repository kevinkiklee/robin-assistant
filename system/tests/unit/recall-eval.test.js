import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { scoreRows } from '../../cognition/intuition/eval.js';

const fixture = JSON.parse(
  readFileSync(join(import.meta.dirname, '../fixtures/recall-eval-golden.json'), 'utf8'),
);

test('scoreRows matches golden-fixture expected metrics', () => {
  const out = scoreRows({ rows: fixture.rows, corrections: [], ks: [3] });
  const exp = fixture.expected;
  assert.equal(out.rows_pending, exp.rows_pending);
  assert.equal(out.rows_scored, exp.rows_scored);
  assert.ok(Math.abs(out.metrics.no_signal_rate - exp.no_signal_rate) < 0.001);
  assert.ok(Math.abs(out.metrics.precision_at_3 - exp.precision_at_3) < 0.001);
  assert.ok(Math.abs(out.metrics.recall_at_3 - exp.recall_at_3) < 0.001);
  assert.ok(
    Math.abs(out.metrics.mean_rank_of_negatives_at_10 - exp.mean_rank_of_negatives_at_10) < 0.001,
  );
});

test('scoreRows stratifies metrics by focus_block_present (D1 cross-design fix)', () => {
  const out = scoreRows({ rows: fixture.rows, corrections: [], ks: [3] });
  assert.ok(out.metrics_by_focus_block);
  assert.ok('focus_block' in out.metrics_by_focus_block);
  assert.ok('no_focus_block' in out.metrics_by_focus_block);
  // fixture has 2 focus-block evaluated rows (g2, g6) + 3 no-focus evaluated (g1, g3, g4)
  assert.equal(out.metrics_by_focus_block.focus_block.count, 2);
  assert.equal(out.metrics_by_focus_block.no_focus_block.count, 3);
});
