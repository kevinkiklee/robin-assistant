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
  assert.equal(await isHookDisabled('bash-policy'), false);
});

test('isHookDisabled returns false when hooks.disabled is false', async () => {
  writeFileSync(configFile, JSON.stringify({ hooks: { disabled: false } }));
  assert.equal(await isHookDisabled('bash-policy'), false);
});

test('isHookDisabled returns true when hooks.disabled is true (global kill-switch)', async () => {
  writeFileSync(configFile, JSON.stringify({ hooks: { disabled: true } }));
  assert.equal(await isHookDisabled('bash-policy'), true);
  assert.equal(await isHookDisabled('stop'), true);
  assert.equal(await isHookDisabled('session-start'), true);
});

test('addDisabled then removeDisabled round-trips via config.json', async () => {
  rmSync(configFile, { force: true });
  assert.equal(await isHookDisabled('bash-policy'), false);
  await addDisabled('bash-policy');
  assert.equal(await isHookDisabled('bash-policy'), true);
  await removeDisabled('bash-policy');
  assert.equal(await isHookDisabled('bash-policy'), false);
});

test('addDisabled is idempotent', async () => {
  rmSync(configFile, { force: true });
  await addDisabled('bash-policy');
  await addDisabled('bash-policy');
  assert.equal(await isHookDisabled('bash-policy'), true);
  await removeDisabled('bash-policy');
});

test('addDisabled creates config.json when missing', async () => {
  rmSync(configFile, { force: true });
  await addDisabled('auto-recall');
  assert.equal(await isHookDisabled('auto-recall'), true);
  await removeDisabled('auto-recall');
});
