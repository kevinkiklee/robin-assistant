import assert from 'node:assert/strict';
import { test } from 'node:test';
import { hostSleptSince, parseSysctlTimes } from './host-sleep.ts';

test('parseSysctlTimes: takes the later of sleeptime and waketime', () => {
  // Verbatim `sysctl -n kern.sleeptime kern.waketime` shape (macOS 26).
  const out = [
    '{ sec = 1793129696, usec = 1236 } Tue Oct 27 15:34:56 2026',
    '{ sec = 1793129703, usec = 364655 } Tue Oct 27 15:35:03 2026',
  ].join('\n');
  assert.equal(parseSysctlTimes(out), 1793129703_364);
});

test('parseSysctlTimes: never-slept (zero) and garbage read as unknown', () => {
  assert.equal(parseSysctlTimes('{ sec = 0, usec = 0 } Thu Jan  1 00:00:00 1970'), null);
  assert.equal(parseSysctlTimes(''), null);
  assert.equal(parseSysctlTimes('sysctl: unknown oid'), null);
});

test('hostSleptSince: only a sleep/wake after the mark counts', () => {
  assert.equal(
    hostSleptSince(1_000, () => 2_000),
    true,
  );
  assert.equal(
    hostSleptSince(3_000, () => 2_000),
    false,
  );
  assert.equal(
    hostSleptSince(1_000, () => null),
    false,
  );
});
