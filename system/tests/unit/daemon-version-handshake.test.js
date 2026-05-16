import assert from 'node:assert/strict';
import { test } from 'node:test';
import { getCliVersion } from '../../runtime/daemon/version-handshake.js';

test('getCliVersion returns the package.json version', async () => {
  const v = await getCliVersion();
  assert.match(v, /^6\./);
});
