import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compare, specAtEndMs, validateSpec } from './spec.ts';

const ok = { source: 'whoop', metric: 'recovery_score', op: '>=', threshold: 65, at: '2027-04-14' };

function err(input: unknown, deadline?: string | null): string {
  const v = validateSpec(input, deadline);
  assert.equal(v.ok, false, 'expected rejection');
  return v.ok ? '' : v.error;
}

test('validateSpec: accepts a minimal spec and the documented example', () => {
  assert.equal(validateSpec(ok).ok, true);
  const v = validateSpec({
    source: 'whoop',
    metric: 'recovery_score',
    op: '<=',
    threshold: 61,
    at: '2027-04-14',
    agg: 'mean',
    window_days: 5,
  });
  assert.equal(v.ok, true);
});

test('validateSpec: `at` may be omitted when the prediction has a deadline', () => {
  const { at: _at, ...noAt } = ok;
  assert.equal(validateSpec(noAt, '2027-04-14').ok, true);
  assert.match(err(noAt, null), /needs `at`/);
  assert.match(err({ ...ok, at: 'next tuesday' }), /not an ISO/);
});

test('validateSpec: rejects unknown source/metric, bad op, non-numeric threshold, extra junk shape', () => {
  assert.match(err({ ...ok, source: 'spotify' }), /unknown metric/);
  assert.match(err({ ...ok, metric: 'vibes' }), /unknown metric/);
  assert.match(err({ ...ok, op: '=>' }), /op/);
  assert.match(err({ ...ok, threshold: '65' }), /threshold/);
  assert.match(err(null), /spec/);
});

test('validateSpec: key required/forbidden per metric', () => {
  assert.match(err({ ...ok, source: 'finance', metric: 'balance' }), /requires key/);
  assert.equal(validateSpec({ ...ok, source: 'finance', metric: 'balance', key: 'Acme' }).ok, true);
  assert.match(err({ ...ok, key: 'x' }), /takes no key/);
  // optional key accepted
  assert.equal(
    validateSpec({ ...ok, metric: 'workouts', key: 'weightlifting', window_days: 7 }).ok,
    true,
  );
});

test('validateSpec: agg/window_days consistency per metric kind', () => {
  assert.match(err({ ...ok, agg: 'mean' }), /needs window_days/);
  assert.match(err({ ...ok, window_days: 7 }), /only applies/);
  assert.match(err({ ...ok, metric: 'workouts' }), /needs window_days/);
  assert.match(err({ ...ok, metric: 'workouts', window_days: 7, agg: 'max' }), /not a series/);
  assert.match(
    err({ ...ok, source: 'linear', metric: 'issue_open', key: 'ENG-1', window_days: 3 }),
    /point-in-time/,
  );
  assert.match(err({ ...ok, agg: 'mean', window_days: 0 }), /window_days/);
});

test('specAtEndMs: date-only = end of that UTC day; datetime verbatim', () => {
  assert.equal(
    new Date(specAtEndMs('2027-04-14') as number).toISOString(),
    '2027-04-14T23:59:59.999Z',
  );
  assert.equal(
    new Date(specAtEndMs('2027-04-14T18:00:00Z') as number).toISOString(),
    '2027-04-14T18:00:00.000Z',
  );
  assert.equal(specAtEndMs('garbage'), null);
  assert.equal(specAtEndMs(null), null);
});

test('compare: all ops, float-tolerant equality', () => {
  assert.equal(compare(50, '>=', 50), true);
  assert.equal(compare(50, '>', 50), false);
  assert.equal(compare(49.99, '<', 50), true);
  assert.equal(compare(50, '<=', 50), true);
  assert.equal(compare(0.1 + 0.2, '==', 0.3), true);
  assert.equal(compare(1, '!=', 0), true);
});
