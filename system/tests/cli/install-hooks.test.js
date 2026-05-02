import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installHooks } from '../../scripts/cli/install-hooks.js';
import { execSync } from 'node:child_process';
import { mkdtempSync, existsSync, readFileSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('install-hooks writes a pre-commit hook that invokes pre-commit.js', async () => {
  const root = mkdtempSync(join(tmpdir(), 'robin-ih-'));
  execSync('git init -q', { cwd: root });
  mkdirSync(join(root, 'system/scripts/hooks'), { recursive: true });
  writeFileSync(join(root, 'system/scripts/hooks/pre-commit.js'), '#!/usr/bin/env node\nprocess.exit(0);\n');
  await installHooks(root);
  const hookPath = join(root, '.git/hooks/pre-commit');
  assert.ok(existsSync(hookPath));
  const content = readFileSync(hookPath, 'utf-8');
  assert.match(content, /hooks\/pre-commit\.js/);
  rmSync(root, { recursive: true, force: true });
});

test('install-hooks refuses to overwrite existing hook', async () => {
  const root = mkdtempSync(join(tmpdir(), 'robin-ih-'));
  execSync('git init -q', { cwd: root });
  writeFileSync(join(root, '.git/hooks/pre-commit'), '#!/bin/sh\n# existing\n');
  await installHooks(root);
  const content = readFileSync(join(root, '.git/hooks/pre-commit'), 'utf-8');
  assert.match(content, /existing/); // unchanged
  rmSync(root, { recursive: true, force: true });
});

test('rewrites stale pre-commit hook path to new hooks/ location', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'rh-stale-'));
  const hookDir = join(tmp, '.git', 'hooks');
  mkdirSync(hookDir, { recursive: true });
  const hookPath = join(hookDir, 'pre-commit');
  writeFileSync(
    hookPath,
    [
      '#!/usr/bin/env bash',
      'exec node "$(git rev-parse --show-toplevel)/system/scripts/pre-commit-hook.js"',
      '',
    ].join('\n'),
  );

  await installHooks(tmp);

  const updated = readFileSync(hookPath, 'utf8');
  assert.match(updated, /system\/scripts\/hooks\/pre-commit\.js/);
  assert.doesNotMatch(updated, /scripts\/pre-commit-hook\.js/);
  rmSync(tmp, { recursive: true, force: true });
});

test('installHooks is idempotent — running twice produces same content', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'rh-idem-'));
  mkdirSync(join(tmp, '.git', 'hooks'), { recursive: true });

  await installHooks(tmp);
  const after1 = readFileSync(join(tmp, '.git/hooks/pre-commit'), 'utf8');
  await installHooks(tmp);
  const after2 = readFileSync(join(tmp, '.git/hooks/pre-commit'), 'utf8');
  assert.equal(after1, after2);
  rmSync(tmp, { recursive: true, force: true });
});

test('does not modify a hook that points at the new path', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'rh-cur-'));
  const hookDir = join(tmp, '.git', 'hooks');
  mkdirSync(hookDir, { recursive: true });
  const hookPath = join(hookDir, 'pre-commit');
  const correctContent = [
    '#!/usr/bin/env bash',
    'exec node "$(git rev-parse --show-toplevel)/system/scripts/hooks/pre-commit.js"',
    '',
  ].join('\n');
  writeFileSync(hookPath, correctContent);

  await installHooks(tmp);

  const after = readFileSync(hookPath, 'utf8');
  assert.equal(after, correctContent);
  rmSync(tmp, { recursive: true, force: true });
});

test('does not touch a custom user hook (no Robin path references)', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'rh-custom-'));
  const hookDir = join(tmp, '.git', 'hooks');
  mkdirSync(hookDir, { recursive: true });
  const hookPath = join(hookDir, 'pre-commit');
  const customContent = ['#!/usr/bin/env bash', 'echo "custom user hook"', 'exit 0', ''].join('\n');
  writeFileSync(hookPath, customContent);

  await installHooks(tmp);

  const after = readFileSync(hookPath, 'utf8');
  assert.equal(after, customContent);
  rmSync(tmp, { recursive: true, force: true });
});
