import assert from 'node:assert/strict';
import { test } from 'node:test';
import { score } from '../../cognition/intuition/rank.js';

test('meta_cognition derived_by yields trustFactor=0.9 (explicit table entry)', () => {
  const r = score({
    record: {
      kind: 'reasoning',
      confidence: 1.0,
      signal_count: 1,
      decay_anchor: new Date(),
      derived_by: 'meta_cognition',
      scope: 'global',
    },
    distance: 0,
  });
  assert.equal(r.components.trustFactor, 0.9);
});
