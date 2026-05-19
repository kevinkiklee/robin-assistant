import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runInvariants } from './runner.ts';
import type { Invariant } from './types.ts';

const okInvariant: Invariant = {
  name: 'test.ok',
  severity: 'critical',
  symptom: 'never',
  cause: 'never',
  fix: 'nothing',
  check: () => ({ ok: true }),
};

const failInvariant: Invariant = {
  name: 'test.fail',
  severity: 'warning',
  symptom: 'always',
  cause: 'always',
  fix: 'restart it',
  check: () => ({ ok: false, message: 'something is wrong', remediation: 'try again' }),
};

const throwInvariant: Invariant = {
  name: 'test.throw',
  severity: 'critical',
  symptom: 'rare',
  cause: 'rare',
  fix: 'investigate',
  check: () => {
    throw new Error('exploded');
  },
};

test('invariants: passes ok invariant', async () => {
  const reports = await runInvariants([okInvariant]);
  assert.equal(reports.length, 1);
  assert.equal(reports[0].ok, true);
  assert.equal(reports[0].severity, 'critical');
});

test('invariants: captures failure with message + remediation', async () => {
  const reports = await runInvariants([failInvariant]);
  assert.equal(reports[0].ok, false);
  assert.equal(reports[0].message, 'something is wrong');
  assert.equal(reports[0].remediation, 'try again');
});

test('invariants: thrown error is caught and reported', async () => {
  const reports = await runInvariants([throwInvariant]);
  assert.equal(reports[0].ok, false);
  assert.match(reports[0].message ?? '', /exploded/);
});

test('invariants: records duration', async () => {
  const reports = await runInvariants([okInvariant]);
  assert.ok(reports[0].duration_ms >= 0);
});
