import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseLowPowerMode, parseNetPath, readBatteryStateMacOS } from './macos.ts';

test('battery: readBatteryStateMacOS returns a defined shape', async () => {
  const r = await readBatteryStateMacOS();
  assert.ok(typeof r.available === 'boolean');
  assert.ok(typeof r.charging === 'boolean');
});

test('parseLowPowerMode: macOS 26 powermode and the older lowpowermode key', () => {
  assert.equal(parseLowPowerMode(' sleep 0\n powermode            1\n womp 1'), true);
  assert.equal(parseLowPowerMode(' powermode            0'), false);
  assert.equal(parseLowPowerMode(' powermode            2'), false, '2 = high power');
  assert.equal(parseLowPowerMode(' lowpowermode         1'), true);
  assert.equal(parseLowPowerMode(' sleep 0\n womp 1'), null);
});

test('parseNetPath: expensive or constrained is metered; junk is unavailable', () => {
  const j = (e: boolean, c: boolean) => `{"satisfied":true,"expensive":${e},"constrained":${c}}`;
  assert.deepEqual(parseNetPath(j(false, false)), { available: true, metered: false });
  assert.deepEqual(parseNetPath(j(true, false)), { available: true, metered: true });
  assert.deepEqual(parseNetPath(j(false, true)), { available: true, metered: true });
  assert.deepEqual(parseNetPath('oops'), { available: false, metered: false });
});
