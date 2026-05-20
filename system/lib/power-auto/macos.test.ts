import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readBatteryStateMacOS } from './macos.ts';

test('battery: readBatteryStateMacOS returns a defined shape', async () => {
  const r = await readBatteryStateMacOS();
  assert.ok(typeof r.available === 'boolean');
  assert.ok(typeof r.charging === 'boolean');
});
