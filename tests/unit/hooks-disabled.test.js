import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const __robinTestHome = join(
  tmpdir(),
  `robin-test-${process.pid}-${Math.random().toString(36).slice(2)}`,
);
mkdirSync(__robinTestHome, { recursive: true });
process.env.ROBIN_HOME = __robinTestHome;

const { isHookDisabled, addDisabled, removeDisabled } = await import('../../src/hooks/disabled.js');

const configFile = join(__robinTestHome, 'config.json');

test('isHookDisabled returns false when config is missing', async () => {
  rmSync(configFile, { force: true });
  assert.equal(await isHookDisabled('discretion'), false);
});

test('isHookDisabled returns false when hooks.disabled is false', async () => {
  writeFileSync(configFile, JSON.stringify({ hooks: { disabled: false } }));
  assert.equal(await isHookDisabled('discretion'), false);
});

test('isHookDisabled returns true when hooks.disabled is true (global kill-switch)', async () => {
  writeFileSync(configFile, JSON.stringify({ hooks: { disabled: true } }));
  assert.equal(await isHookDisabled('discretion'), true);
  assert.equal(await isHookDisabled('stop'), true);
  assert.equal(await isHookDisabled('session-start'), true);
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
  await removeDisabled('discretion');
});

test('addDisabled creates config.json when missing', async () => {
  rmSync(configFile, { force: true });
  await addDisabled('intuition');
  assert.equal(await isHookDisabled('intuition'), true);
  await removeDisabled('intuition');
});
