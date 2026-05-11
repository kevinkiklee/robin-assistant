import assert from 'node:assert/strict';
import { test } from 'node:test';
import { expectedIntervalMs, nextFire, parseCron, prevFire } from '../../cognition/jobs/cron.js';

test('parseCron — 5-field hourly', () => {
  const p = parseCron('0 * * * *');
  assert.deepEqual(p.minute, [0]);
  assert.equal(p.hour, '*');
});

test('parseCron — @-aliases', () => {
  assert.equal(parseCron('@daily').encoded, '0 0 * * *');
  assert.equal(parseCron('@hourly').encoded, '0 * * * *');
  assert.equal(parseCron('@weekly').encoded, '0 0 * * 0');
  assert.equal(parseCron('@monthly').encoded, '0 0 1 * *');
  assert.equal(parseCron('@yearly').encoded, '0 0 1 1 *');
});

test('parseCron — list, range, step operators', () => {
  parseCron('0 9,17 * * 1-5'); // 9am + 5pm Mon-Fri — must not throw
  parseCron('*/15 * * * *'); // every 15 min — must not throw
  assert.throws(() => parseCron('99 * * * *'), /minute out of range/);
  assert.throws(() => parseCron('bad cron'), /invalid/);
});

test('nextFire — daily 7am from 6:59am same day fires at 7:00 today', () => {
  process.env.TZ = 'America/Los_Angeles';
  const p = parseCron('0 7 * * *');
  const after = new Date('2026-05-10T13:59:00.000Z'); // 06:59 PT
  const n = nextFire(p, after);
  assert.equal(n.toISOString(), '2026-05-10T14:00:00.000Z'); // 07:00 PT
});

test('nextFire — daily 7am from 8am same day fires tomorrow', () => {
  process.env.TZ = 'America/Los_Angeles';
  const p = parseCron('0 7 * * *');
  const after = new Date('2026-05-10T15:00:00.000Z'); // 08:00 PT
  const n = nextFire(p, after);
  assert.equal(n.toISOString(), '2026-05-11T14:00:00.000Z');
});

test('prevFire — daily 7am from 8am same day → 7am same day', () => {
  process.env.TZ = 'America/Los_Angeles';
  const p = parseCron('0 7 * * *');
  const before = new Date('2026-05-10T15:00:00.000Z');
  const prev = prevFire(p, before);
  assert.equal(prev.toISOString(), '2026-05-10T14:00:00.000Z');
});

test('expectedIntervalMs — daily ≈ 86_400_000', () => {
  const p = parseCron('@daily');
  const around = new Date('2026-05-10T00:00:00.000Z');
  const ms = expectedIntervalMs(p, around);
  assert.ok(Math.abs(ms - 86_400_000) < 60_000, `got ${ms}`);
});

test('expectedIntervalMs — hourly ≈ 3_600_000', () => {
  const p = parseCron('@hourly');
  const around = new Date('2026-05-10T00:00:00.000Z');
  const ms = expectedIntervalMs(p, around);
  assert.ok(Math.abs(ms - 3_600_000) < 60_000, `got ${ms}`);
});

test('nextFire — @yearly does not blow the iteration cap', () => {
  process.env.TZ = 'UTC';
  const p = parseCron('@yearly');
  const after = new Date('2026-01-02T00:00:00.000Z');
  const n = nextFire(p, after);
  assert.equal(n.toISOString(), '2027-01-01T00:00:00.000Z');
});
