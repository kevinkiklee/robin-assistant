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

const { isHookDisabled, addDisabled, removeDisabled } = await import('../../src/hooks/disabled.js');

const disabledFile = join(__robinTestHome, 'hooks-disabled.txt');

test('isHookDisabled returns false when file is missing', () => {
  // ensure absent
  try {
    writeFileSync(disabledFile, '', { flag: 'wx' });
  } catch {
    // ignore
  }
  // ensure clean state by removing
  writeFileSync(disabledFile, '');
  assert.equal(isHookDisabled('bash-policy'), false);
});

test('isHookDisabled true when phase listed; respects comments and blanks', () => {
  writeFileSync(disabledFile, '# kill switch\n\nbash-policy\n# auto-recall\nstop\n');
  assert.equal(isHookDisabled('bash-policy'), true);
  assert.equal(isHookDisabled('stop'), true);
  assert.equal(isHookDisabled('auto-recall'), false);
  assert.equal(isHookDisabled('session-start'), false);
});

test('inline comment after phase is stripped', () => {
  writeFileSync(disabledFile, 'bash-policy # noisy false positives\n');
  assert.equal(isHookDisabled('bash-policy'), true);
});

test('addDisabled then removeDisabled round-trips', () => {
  writeFileSync(disabledFile, '');
  assert.equal(isHookDisabled('bash-policy'), false);
  addDisabled('bash-policy');
  assert.equal(isHookDisabled('bash-policy'), true);
  // idempotent
  addDisabled('bash-policy');
  const after = readFileSync(disabledFile, 'utf8');
  const occurrences = after.split('\n').filter((l) => l.trim() === 'bash-policy').length;
  assert.equal(occurrences, 1);
  removeDisabled('bash-policy');
  assert.equal(isHookDisabled('bash-policy'), false);
});

test('addDisabled creates file when missing', () => {
  rmSync(disabledFile, { force: true });
  addDisabled('auto-recall');
  assert.equal(isHookDisabled('auto-recall'), true);
});
