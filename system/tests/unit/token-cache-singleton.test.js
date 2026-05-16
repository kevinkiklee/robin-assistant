import { strict as assert } from 'node:assert';
import test from 'node:test';

test('token-cache module identity is preserved across distinct relative paths', async () => {
  // First: import via the system-style relative path (what gmail/calendar use).
  const a = await import('../../io/integrations/_auth/token-cache.js');
  // Second: import via a longer relative path equivalent to what a
  // user-data integration would write. Resolves to the same absolute
  // file under ESM module-identity rules; if Node's resolver ever
  // normalizes differently, this canary fires.
  const b = await import('../.././io/integrations/_auth/token-cache.js');
  // Both imports must reference the SAME instances of every export,
  // or the OAuth token cache splits between system and user-data
  // integrations.
  const keys = Object.keys(a);
  assert.ok(keys.length > 0, 'token-cache must export at least one symbol');
  for (const key of keys) {
    assert.strictEqual(a[key], b[key], `export ${key} diverged across imports`);
  }
});
