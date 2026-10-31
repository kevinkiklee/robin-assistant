import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { loadPolicies } from './load.ts';

function makeTempUserData(): string {
  const dir = mkdtempSync(join(tmpdir(), 'robin-test-'));
  mkdirSync(join(dir, 'config'), { recursive: true });
  return dir;
}

test('config: loads policies.yaml with defaults when file missing', () => {
  const userData = makeTempUserData();
  const policies = loadPolicies(userData);
  assert.equal(policies.power.state, 'active');
  assert.equal(policies.capture.enabled, true);
  assert.equal(policies.network.mode, 'online');
});

test('config: loads policies.yaml when present and merges with defaults', () => {
  const userData = makeTempUserData();
  writeFileSync(
    join(userData, 'config', 'policies.yaml'),
    `
power:
  state: paused
capture:
  enabled: false
`,
  );
  const policies = loadPolicies(userData);
  assert.equal(policies.power.state, 'paused');
  assert.equal(policies.capture.enabled, false);
  assert.equal(policies.network.mode, 'online'); // default preserved
});

test('config: rejects invalid policies.yaml with clear error', () => {
  const userData = makeTempUserData();
  writeFileSync(
    join(userData, 'config', 'policies.yaml'),
    `
power:
  state: nonsense
`,
  );
  assert.throws(() => loadPolicies(userData), /power.state/);
});
