import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { migrateHooksDisabledFlag } from '../../io/hooks/disabled.js';

test('migrateHooksDisabledFlag: empty array when file absent', () => {
  const home = mkdtempSync(join(tmpdir(), 'robin-mig-'));
  try {
    assert.deepEqual(migrateHooksDisabledFlag(home), []);
  } finally {
    rmSync(home, { recursive: true });
  }
});

test('migrateHooksDisabledFlag: parses newline-separated phase names', () => {
  const home = mkdtempSync(join(tmpdir(), 'robin-mig-'));
  try {
    writeFileSync(join(home, 'hooks-disabled.txt'), 'discretion\nintuition\n');
    assert.deepEqual(migrateHooksDisabledFlag(home), ['discretion', 'intuition']);
  } finally {
    rmSync(home, { recursive: true });
  }
});

test('migrateHooksDisabledFlag: ignores # comments and blank lines', () => {
  const home = mkdtempSync(join(tmpdir(), 'robin-mig-'));
  try {
    writeFileSync(
      join(home, 'hooks-disabled.txt'),
      '# kill-switch list\n\ndiscretion  # trips on safe rm\n\nstop\n',
    );
    assert.deepEqual(migrateHooksDisabledFlag(home), ['discretion', 'stop']);
  } finally {
    rmSync(home, { recursive: true });
  }
});

test('migrateHooksDisabledFlag: empty file → empty array', () => {
  const home = mkdtempSync(join(tmpdir(), 'robin-mig-'));
  try {
    writeFileSync(join(home, 'hooks-disabled.txt'), '');
    assert.deepEqual(migrateHooksDisabledFlag(home), []);
  } finally {
    rmSync(home, { recursive: true });
  }
});

test('migrateHooksDisabledFlag: file with only comments → empty array', () => {
  const home = mkdtempSync(join(tmpdir(), 'robin-mig-'));
  try {
    writeFileSync(join(home, 'hooks-disabled.txt'), '# all enabled\n# nothing here\n');
    assert.deepEqual(migrateHooksDisabledFlag(home), []);
  } finally {
    rmSync(home, { recursive: true });
  }
});
