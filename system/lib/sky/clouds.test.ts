import assert from 'node:assert/strict';
import { test } from 'node:test';
import { canvasCover, canvasMean } from './clouds.ts';

test('canvasCover: high cloud counts full, mid weighted', () => {
  assert.equal(canvasCover({ low: 0, mid: 0, high: 50 }), 50);
  assert.equal(canvasCover({ low: 0, mid: 100, high: 0 }), 70); // 100*0.7
  assert.equal(canvasCover({ low: 0, mid: 100, high: 100 }), 100); // clamped
});

test('canvasMean: averages high and mid across samples', () => {
  const m = canvasMean([
    { low: 0, mid: 20, high: 40 },
    { low: 0, mid: 40, high: 60 },
  ]);
  assert.equal(m.high, 50);
  assert.equal(m.mid, 30);
});
