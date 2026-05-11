import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const __robinTestHome = join(
  tmpdir(),
  `robin-test-${process.pid}-${Math.random().toString(36).slice(2)}`,
);
mkdirSync(__robinTestHome, { recursive: true });
process.env.ROBIN_HOME = __robinTestHome;

const { isHookDisabled, addDisabled, removeDisabled } = await import(
  '../../config/hooks-disabled.js'
);

const configFile = join(__robinTestHome, 'config.json');

test('isHookDisabled returns false when config is missing', async () => {
  rmSync(configFile, { force: true });
  assert.equal(await isHookDisabled('discretion'), false);
});

test('isHookDisabled returns false when hooks.disabled is empty array', async () => {
  writeFileSync(configFile, JSON.stringify({ hooks: { disabled: [] } }));
  assert.equal(await isHookDisabled('discretion'), false);
});

test('isHookDisabled is per-phase: only listed phases are disabled', async () => {
  writeFileSync(configFile, JSON.stringify({ hooks: { disabled: ['discretion'] } }));
  assert.equal(await isHookDisabled('discretion'), true);
  assert.equal(await isHookDisabled('intuition'), false);
  assert.equal(await isHookDisabled('session-start'), false);
  assert.equal(await isHookDisabled('stop'), false);
});

test('isHookDisabled treats legacy `true` as all phases disabled (back-compat)', async () => {
  writeFileSync(configFile, JSON.stringify({ hooks: { disabled: true } }));
  assert.equal(await isHookDisabled('discretion'), true);
  assert.equal(await isHookDisabled('stop'), true);
  assert.equal(await isHookDisabled('session-start'), true);
  assert.equal(await isHookDisabled('intuition'), true);
});

test('isHookDisabled treats legacy `false` as no phases disabled (back-compat)', async () => {
  writeFileSync(configFile, JSON.stringify({ hooks: { disabled: false } }));
  assert.equal(await isHookDisabled('discretion'), false);
});

test('addDisabled then removeDisabled round-trips via config.json', async () => {
  rmSync(configFile, { force: true });
  assert.equal(await isHookDisabled('discretion'), false);
  await addDisabled('discretion');
  assert.equal(await isHookDisabled('discretion'), true);
  await removeDisabled('discretion');
  assert.equal(await isHookDisabled('discretion'), false);
});

test('addDisabled is idempotent', async () => {
  rmSync(configFile, { force: true });
  await addDisabled('discretion');
  await addDisabled('discretion');
  assert.equal(await isHookDisabled('discretion'), true);
  // List stays at one element, not duplicated.
  const cfg = JSON.parse(readFileSync(configFile, 'utf8'));
  assert.deepEqual(cfg.hooks.disabled, ['discretion']);
  await removeDisabled('discretion');
});

test('addDisabled creates config.json when missing', async () => {
  rmSync(configFile, { force: true });
  await addDisabled('intuition');
  assert.equal(await isHookDisabled('intuition'), true);
  await removeDisabled('intuition');
});

test('addDisabled does not affect other phases', async () => {
  rmSync(configFile, { force: true });
  await addDisabled('intuition');
  await addDisabled('stop');
  assert.equal(await isHookDisabled('intuition'), true);
  assert.equal(await isHookDisabled('stop'), true);
  assert.equal(await isHookDisabled('discretion'), false);
  assert.equal(await isHookDisabled('session-start'), false);
  await removeDisabled('intuition');
  assert.equal(await isHookDisabled('intuition'), false);
  assert.equal(await isHookDisabled('stop'), true);
  await removeDisabled('stop');
});

test('removeDisabled on legacy `true` expands then removes the named phase', async () => {
  writeFileSync(configFile, JSON.stringify({ hooks: { disabled: true } }));
  await removeDisabled('intuition');
  // After expansion + remove, the others remain disabled.
  assert.equal(await isHookDisabled('intuition'), false);
  assert.equal(await isHookDisabled('discretion'), true);
  assert.equal(await isHookDisabled('session-start'), true);
  assert.equal(await isHookDisabled('stop'), true);
  // Re-enable all for cleanup.
  await removeDisabled('discretion');
  await removeDisabled('session-start');
  await removeDisabled('stop');
});
