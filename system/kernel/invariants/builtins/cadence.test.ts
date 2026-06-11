import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cadenceMs } from './cadence.ts';

test('30-minute cron → 30min cadence', () => {
  assert.equal(cadenceMs('*/30 * * * *'), 30 * 60_000);
});
test('daily cron → 24h cadence', () => {
  assert.equal(cadenceMs('30 4 * * *'), 24 * 60 * 60_000);
});
test('invalid cron → null', () => {
  assert.equal(cadenceMs('not a cron'), null);
});
