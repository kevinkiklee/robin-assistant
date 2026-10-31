import assert from 'node:assert/strict';
import { test } from 'node:test';
import { injectionOutcome, keptCount, parseKept } from './recall-outcome.ts';

test('keptCount: sums every slice, tolerating legacy/partial shapes', () => {
  assert.equal(
    keptCount({ docs: ['a'], snippets: [1, 2], corrections: [3], habits: 1, loops: 2 }),
    7,
  );
  assert.equal(keptCount({ docs: [], snippets: [], habits: 0, loops: 0 }), 0); // pre-corrections shape
  assert.equal(keptCount({}), 0);
});

test('injectionOutcome: injected / filtered / miss', () => {
  const empty = { docs: [], snippets: [], corrections: [], habits: 0, loops: 0 };
  assert.equal(injectionOutcome({ ...empty, corrections: [9] }, 0), 'injected');
  assert.equal(injectionOutcome(empty, 12), 'filtered');
  assert.equal(injectionOutcome(empty, 0), 'miss');
});

test('parseKept: null for NULL / malformed / non-object JSON', () => {
  assert.equal(parseKept(null), null);
  assert.equal(parseKept('{nope'), null);
  assert.equal(parseKept('42'), null);
  assert.deepEqual(parseKept('{"docs":[]}'), { docs: [] });
});
