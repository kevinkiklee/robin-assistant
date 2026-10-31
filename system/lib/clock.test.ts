import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { clockDate, clockIso, clockNow, setClock } from './clock.ts';

afterEach(() => setClock(null));

test('clock: defaults to the real clock', () => {
  const before = Date.now();
  const n = clockNow();
  assert.ok(n >= before && n <= Date.now());
});

test('clock: setClock pins all three readers; null restores real time', () => {
  setClock(() => Date.parse('2027-05-01T00:00:00Z'));
  assert.equal(clockNow(), Date.parse('2027-05-01T00:00:00Z'));
  assert.equal(clockDate().toISOString(), '2027-05-01T00:00:00.000Z');
  assert.equal(clockIso(), '2027-05-01T00:00:00.000Z');
  setClock(null);
  assert.ok(Math.abs(clockNow() - Date.now()) < 1000);
});
