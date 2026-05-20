import assert from 'node:assert/strict';
import { test } from 'node:test';
import { detectHardware } from './detect.ts';

test('detect: returns a profile name', () => {
  const hw = detectHardware();
  assert.ok(hw.profile);
  assert.ok(hw.cpu);
  assert.ok(hw.arch);
  assert.ok(typeof hw.ram_gb === 'number');
});
