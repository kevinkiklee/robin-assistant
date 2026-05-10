import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
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

test('hooksDisable: disables a known phase', async () => {
  const h = harness();
  await hooksDisable(['bash-policy'], h);
  assert.equal(isHookDisabled('bash-policy'), true);
  assert.deepEqual(h.exitCalls, []);
  assert.match(h.outLines.join('\n'), /disabled hook: bash-policy/);
});

test('hooksEnable: enables a previously disabled phase', async () => {
  const h = harness();
  await hooksEnable(['bash-policy'], h);
  assert.equal(isHookDisabled('bash-policy'), false);
  assert.deepEqual(h.exitCalls, []);
  assert.match(h.outLines.join('\n'), /enabled hook: bash-policy/);
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

test('hooksDisable: idempotent — same phase twice still disabled', async () => {
  const h = harness();
  await hooksDisable(['stop'], h);
  await hooksDisable(['stop'], h);
  assert.equal(isHookDisabled('stop'), true);
  // Cleanup so the file does not leak between tests
  await hooksEnable(['stop'], h);
  assert.equal(isHookDisabled('stop'), false);
});

test('hooksDisable + hooksEnable: round-trip across phases', async () => {
  const h = harness();
  await hooksDisable(['auto-recall'], h);
  await hooksDisable(['session-start'], h);
  assert.equal(isHookDisabled('auto-recall'), true);
  assert.equal(isHookDisabled('session-start'), true);
  await hooksEnable(['auto-recall'], h);
  assert.equal(isHookDisabled('auto-recall'), false);
  assert.equal(isHookDisabled('session-start'), true);
  await hooksEnable(['session-start'], h);
  assert.equal(isHookDisabled('session-start'), false);
});
