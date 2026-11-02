import assert from 'node:assert/strict';
import { test } from 'node:test';
import { autoLandSandboxInvariant } from './auto-land-sandbox.ts';

test('agent.auto_land_sandbox: fails when enabled on linux', async () => {
  const inv = autoLandSandboxInvariant({ autoLandEnabled: () => true, platform: 'linux' });
  assert.equal(inv.name, 'agent.auto_land_sandbox');
  assert.equal(inv.severity, 'warning');
  const r = await inv.check();
  assert.equal(r.ok, false);
  assert.equal(
    r.message,
    'auto-land is enabled but this platform has no OS sandbox for its checks — every verified K branch is held for review',
  );
});

test('agent.auto_land_sandbox: ok when enabled on darwin', async () => {
  const inv = autoLandSandboxInvariant({ autoLandEnabled: () => true, platform: 'darwin' });
  assert.equal((await inv.check()).ok, true);
});

test('agent.auto_land_sandbox: ok when disabled on linux', async () => {
  const inv = autoLandSandboxInvariant({ autoLandEnabled: () => false, platform: 'linux' });
  assert.equal((await inv.check()).ok, true);
});
