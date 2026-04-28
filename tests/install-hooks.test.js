import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installHooks } from '../core/scripts/install-hooks.js';
import { execSync } from 'node:child_process';
import { mkdtempSync, existsSync, readFileSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('install-hooks writes a pre-commit hook that invokes pre-commit-hook.js', async () => {
  const root = mkdtempSync(join(tmpdir(), 'robin-ih-'));
  execSync('git init -q', { cwd: root });
  mkdirSync(join(root, 'core/scripts'), { recursive: true });
  writeFileSync(join(root, 'core/scripts/pre-commit-hook.js'), '#!/usr/bin/env node\nprocess.exit(0);\n');
  await installHooks(root);
  const hookPath = join(root, '.git/hooks/pre-commit');
  assert.ok(existsSync(hookPath));
  const content = readFileSync(hookPath, 'utf-8');
  assert.match(content, /pre-commit-hook\.js/);
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
