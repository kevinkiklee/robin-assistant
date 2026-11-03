import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  assertCanRunIntegrations,
  clearRole,
  cliAllowedWhenLocked,
  lockedCliRefusal,
  readRole,
  roleHoldsWork,
  rolePath,
  writeRole,
} from './role.ts';

function ud(): string {
  return mkdtempSync(join(tmpdir(), 'robin-role-'));
}

test('rolePath is under state/runtime', () => {
  assert.equal(rolePath('/x'), '/x/state/runtime/cloud-role.json');
});

test('write/read round trip, clear removes', () => {
  const d = ud();
  assert.equal(readRole(d), null);
  const rec = { role: 'mac-locked' as const, host: 'example-vm', at: '2026-11-02T00:00:00.000Z' };
  writeRole(d, rec);
  assert.deepEqual(readRole(d), rec);
  clearRole(d);
  assert.equal(readRole(d), null);
  clearRole(d); // idempotent
});

test('corrupt or invalid marker reads as null', () => {
  const d = ud();
  mkdirSync(join(d, 'state', 'runtime'), { recursive: true });
  for (const body of ['{nope', '[]', '{"role":"bogus","at":"x"}', '{"role":"vm-primary"}']) {
    writeFileSync(rolePath(d), body);
    assert.equal(readRole(d), null, body);
  }
});

test('cliAllowedWhenLocked table', () => {
  for (const c of ['cloud', 'help', '--help', '-h', 'version', '--version', '-v', undefined]) {
    assert.equal(cliAllowedWhenLocked(c), true, String(c));
  }
  for (const c of ['daemon', 'mcp', 'run', 'recall', 'resume']) {
    assert.equal(cliAllowedWhenLocked(c), false, c);
  }
});

test('assertCanRunIntegrations throws under dry-run and mac-locked only', () => {
  const d = ud();
  assert.doesNotThrow(() => assertCanRunIntegrations(d));
  writeRole(d, { role: 'vm-primary', at: 'x' });
  assert.doesNotThrow(() => assertCanRunIntegrations(d));
  writeRole(d, { role: 'vm-dry-run', at: 'x' });
  assert.throws(() => assertCanRunIntegrations(d), /cloud role vm-dry-run: integrations are held/);
  writeRole(d, { role: 'mac-locked', at: 'x' });
  assert.throws(() => assertCanRunIntegrations(d), /cloud role mac-locked: integrations are held/);
});

test('lockedCliRefusal: message under mac-locked, null otherwise', () => {
  const d = ud();
  assert.equal(lockedCliRefusal(d, 'recall'), null);
  writeRole(d, { role: 'vm-dry-run', host: 'example-vm', at: 'x' });
  assert.equal(lockedCliRefusal(d, 'recall'), null);
  writeRole(d, { role: 'mac-locked', host: 'example-vm', at: 'x' });
  assert.equal(
    lockedCliRefusal(d, 'recall'),
    "This Mac's Robin is locked — Robin runs on example-vm. Use: ssh example-vm, or robin cloud rollback.",
  );
  assert.equal(lockedCliRefusal(d, 'daemon'), lockedCliRefusal(d, 'recall'));
  assert.equal(lockedCliRefusal(d, 'cloud'), null);
  assert.equal(lockedCliRefusal(d, undefined), null);
});

test('roleHoldsWork follows live flips and clears', () => {
  const d = ud();
  assert.equal(roleHoldsWork(d), false);
  writeRole(d, { role: 'vm-primary', at: 'x' });
  assert.equal(roleHoldsWork(d), false);
  writeRole(d, { role: 'vm-dry-run', host: 'example-vm', at: 'x' });
  assert.equal(roleHoldsWork(d), true);
  writeRole(d, { role: 'mac-locked', host: 'example-vm', at: 'x' });
  assert.equal(roleHoldsWork(d), true);
  clearRole(d);
  assert.equal(roleHoldsWork(d), false);
});
