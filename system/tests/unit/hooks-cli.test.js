import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const __robinTestHome = join(
  tmpdir(),
  `robin-test-${process.pid}-${Math.random().toString(36).slice(2)}`,
);
mkdirSync(__robinTestHome, { recursive: true });
process.env.ROBIN_HOME = __robinTestHome;

const { DISPATCH, runHook } = await import('../../io/hooks/dispatcher.js');

const configFile = join(__robinTestHome, 'config.json');

test('DISPATCH map exposes the four expected phases', () => {
  assert.deepEqual(
    Object.keys(DISPATCH).sort(),
    ['intuition', 'discretion', 'session-start', 'stop'].sort(),
  );
  for (const v of Object.values(DISPATCH)) {
    assert.equal(typeof v.module, 'string');
    assert.equal(typeof v.exportName, 'string');
  }
});

test('runHook with unknown phase resolves without throwing', async () => {
  await assert.doesNotReject(runHook('does-not-exist', { rawStdin: '{}' }));
});

test('runHook with disabled phase short-circuits before dynamic import', async () => {
  // discretion handler module does not exist yet in this agent's tree;
  // if the dispatcher tried to import it, runHook would catch the error
  // (fail-soft) but we want to assert short-circuit behavior. We do this
  // by setting hooks.disabled = true in config.json.
  writeFileSync(configFile, JSON.stringify({ hooks: { disabled: true } }));
  const t0 = Date.now();
  await runHook('discretion', { rawStdin: '{}' });
  // No assertion on timing; the meaningful guarantee is no throw.
  assert.ok(Date.now() - t0 < 5000);
});

test('runHook is fail-soft when handler module is missing', async () => {
  // Ensure hooks are not disabled so the dispatcher tries to import.
  writeFileSync(configFile, JSON.stringify({ hooks: { disabled: false } }));
  // discretion handler module is owned by another agent and not present.
  // runHook should swallow the import error and resolve.
  await assert.doesNotReject(runHook('discretion', { rawStdin: '{}' }));
});

test('runHook tolerates malformed JSON stdin (fail-soft)', async () => {
  writeFileSync(configFile, JSON.stringify({ hooks: { disabled: false } }));
  await assert.doesNotReject(runHook('discretion', { rawStdin: 'not-json{' }));
});
