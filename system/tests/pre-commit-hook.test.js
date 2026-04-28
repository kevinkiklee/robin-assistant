import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HOOK = fileURLToPath(new URL('../scripts/pre-commit-hook.js', import.meta.url));

function gitInit() {
  const root = mkdtempSync(join(tmpdir(), 'robin-hk-'));
  execSync('git init -q', { cwd: root });
  execSync('git config user.email t@t', { cwd: root });
  execSync('git config user.name T', { cwd: root });
  return root;
}

test('pre-commit-hook fails when user-data/ is staged', () => {
  const root = gitInit();
  writeFileSync(join(root, '.gitignore'), '/user-data/\n');
  mkdirSync(join(root, 'user-data'));
  writeFileSync(join(root, 'user-data/profile.md'), 'x');
  execSync('git add -f user-data/profile.md', { cwd: root });
  const res = spawnSync('node', [HOOK], { cwd: root });
  assert.notEqual(res.status, 0);
  assert.match(res.stderr.toString(), /personal data/i);
  rmSync(root, { recursive: true, force: true });
});

test('pre-commit-hook passes when only system/ is staged', () => {
  const root = gitInit();
  writeFileSync(join(root, '.gitignore'), '/user-data/\n');
  mkdirSync(join(root, 'system'));
  writeFileSync(join(root, 'system/foo.md'), 'x');
  execSync('git add system/foo.md', { cwd: root });
  const res = spawnSync('node', [HOOK], { cwd: root });
  assert.equal(res.status, 0);
  rmSync(root, { recursive: true, force: true });
});

test('pre-commit-hook fails when user-data/ is not gitignored', () => {
  const root = gitInit();
  // no .gitignore
  mkdirSync(join(root, 'user-data'));
  writeFileSync(join(root, 'user-data/x.md'), 'x');
  const res = spawnSync('node', [HOOK], { cwd: root });
  assert.notEqual(res.status, 0);
  assert.match(res.stderr.toString(), /not gitignored/i);
  rmSync(root, { recursive: true, force: true });
});
