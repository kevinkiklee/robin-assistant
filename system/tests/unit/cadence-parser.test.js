import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseCadence } from '../../io/integrations/_framework/cadence.js';

test('parseCadence "15m" → 900_000', () => assert.equal(parseCadence('15m'), 900_000));
test('parseCadence "1h" → 3_600_000', () => assert.equal(parseCadence('1h'), 3_600_000));
test('parseCadence "1d" → 86_400_000', () => assert.equal(parseCadence('1d'), 86_400_000));
test('parseCadence raw integer ms', () => assert.equal(parseCadence(60_000), 60_000));
test('parseCadence rejects compound forms', () => assert.throws(() => parseCadence('15m30s')));
test('parseCadence rejects negative', () => assert.throws(() => parseCadence('-5m')));
test('parseCadence rejects zero', () => assert.throws(() => parseCadence(0)));
test('parseCadence rejects null/undefined', () => {
  assert.throws(() => parseCadence(null));
  assert.throws(() => parseCadence(undefined));
});
test('parseCadence rejects non-numeric strings', () => assert.throws(() => parseCadence('abc')));
