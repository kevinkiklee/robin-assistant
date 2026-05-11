// tests/integration/install-first.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pickHome } from '../../src/cli/commands/install.js';

test('pickHome: numeric selection of option 3 returns ~/Documents/Robin', async () => {
  const fakeHomedir = mkdtempSync(join(tmpdir(), 'robin-fake-home-'));
  try {
    const replies = ['3'];
    let i = 0;
    const result = await pickHome({
      packageRoot: '/fake/pkg',
      homedir: fakeHomedir,
      inputFn: async () => replies[i++],
    });
    assert.strictEqual(result, join(fakeHomedir, 'Documents', 'Robin'));
  } finally {
    rmSync(fakeHomedir, { recursive: true, force: true });
  }
});

test('pickHome: default (empty input) returns option 1 (package_root/user-data)', async () => {
  const fakeHomedir = mkdtempSync(join(tmpdir(), 'robin-fake-home-'));
  try {
    const result = await pickHome({
      packageRoot: '/fake/pkg',
      homedir: fakeHomedir,
      inputFn: async () => '',
    });
    assert.strictEqual(result, '/fake/pkg/user-data');
  } finally {
    rmSync(fakeHomedir, { recursive: true, force: true });
  }
});

test('pickHome: custom path option asks for a path', async () => {
  const fakeHomedir = mkdtempSync(join(tmpdir(), 'robin-fake-home-'));
  const targetParent = mkdtempSync(join(tmpdir(), 'robin-custom-parent-'));
  const target = join(targetParent, 'my-robin');
  try {
    let i = 0;
    const replies = ['4', target];
    const result = await pickHome({
      packageRoot: '/fake/pkg',
      homedir: fakeHomedir,
      inputFn: async () => replies[i++],
    });
    assert.strictEqual(result, target);
  } finally {
    rmSync(fakeHomedir, { recursive: true, force: true });
    rmSync(targetParent, { recursive: true, force: true });
  }
});
