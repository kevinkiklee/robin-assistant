import assert from 'node:assert/strict';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

// __robin_test_home_setup__
const __robinTestHome = join(
  tmpdir(),
  `robin-test-${process.pid}-${Math.random().toString(36).slice(2)}`,
);
mkdirSync(__robinTestHome, { recursive: true });
process.env.ROBIN_HOME = __robinTestHome;

const { hooksDisable } = await import('../../src/cli/commands/hooks-disable.js');
const { hooksEnable } = await import('../../src/cli/commands/hooks-enable.js');
const { isHookDisabled } = await import('../../src/hooks/disabled.js');

const configFile = join(__robinTestHome, 'config.json');

function harness() {
  const out = [];
  const err = [];
  const exits = [];
  return {
    out: (s) => out.push(s),
    err: (s) => err.push(s),
    exit: (c) => exits.push(c),
    outLines: out,
    errLines: err,
    exitCalls: exits,
  };
}

test('hooksDisable: disables a known phase (per-phase, leaves others alone)', async () => {
  rmSync(configFile, { force: true });
  const h = harness();
  await hooksDisable(['discretion'], h);
  assert.equal(await isHookDisabled('discretion'), true);
  assert.equal(await isHookDisabled('intuition'), false);
  assert.deepEqual(h.exitCalls, []);
  assert.match(h.outLines.join('\n'), /disabled hook: discretion/);
});

test('hooksEnable: re-enables a previously disabled phase', async () => {
  const h = harness();
  await hooksEnable(['discretion'], h);
  assert.equal(await isHookDisabled('discretion'), false);
  assert.deepEqual(h.exitCalls, []);
  assert.match(h.outLines.join('\n'), /enabled hook: discretion/);
});

test('hooksDisable: unknown phase exits 1 with stderr', async () => {
  const h = harness();
  await hooksDisable(['nope-not-real'], h);
  assert.deepEqual(h.exitCalls, [1]);
  assert.ok(h.errLines.some((l) => /unknown hook phase/.test(l)));
});

test('hooksEnable: unknown phase exits 1 with stderr', async () => {
  const h = harness();
  await hooksEnable(['nope-not-real'], h);
  assert.deepEqual(h.exitCalls, [1]);
  assert.ok(h.errLines.some((l) => /unknown hook phase/.test(l)));
});

test('hooksDisable: missing arg prints usage and exits 1', async () => {
  const h = harness();
  await hooksDisable([], h);
  assert.deepEqual(h.exitCalls, [1]);
  assert.ok(h.errLines.some((l) => /usage:/.test(l)));
});

test('hooksEnable: missing arg prints usage and exits 1', async () => {
  const h = harness();
  await hooksEnable([], h);
  assert.deepEqual(h.exitCalls, [1]);
  assert.ok(h.errLines.some((l) => /usage:/.test(l)));
});

test('hooksDisable: idempotent — disabling twice stays disabled', async () => {
  rmSync(configFile, { force: true });
  const h = harness();
  await hooksDisable(['stop'], h);
  await hooksDisable(['stop'], h);
  assert.equal(await isHookDisabled('stop'), true);
  // Cleanup
  await hooksEnable(['stop'], h);
  assert.equal(await isHookDisabled('stop'), false);
});

test('hooksDisable + hooksEnable: round-trip is per-phase, never affects other phases', async () => {
  rmSync(configFile, { force: true });
  const h = harness();
  await hooksDisable(['intuition'], h);
  assert.equal(await isHookDisabled('intuition'), true);
  // Other phases stay enabled.
  assert.equal(await isHookDisabled('session-start'), false);
  await hooksEnable(['intuition'], h);
  assert.equal(await isHookDisabled('intuition'), false);
  assert.equal(await isHookDisabled('session-start'), false);
});
