import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkVersionMatch, getCliVersion } from '../../src/daemon/version-handshake.js';

test('matching versions pass', () => {
  const r = checkVersionMatch('6.0.0-alpha.2', '6.0.0-alpha.2');
  assert.equal(r.ok, true);
});

test('mismatched versions fail with both versions in error', () => {
  const r = checkVersionMatch('6.0.0-alpha.1', '6.0.0-alpha.2');
  assert.equal(r.ok, false);
  assert.match(r.error, /6\.0\.0-alpha\.1/);
  assert.match(r.error, /6\.0\.0-alpha\.2/);
  assert.match(r.error, /restart/i);
});

test('getCliVersion returns the package.json version', async () => {
  const v = await getCliVersion();
  assert.match(v, /^6\./);
});
