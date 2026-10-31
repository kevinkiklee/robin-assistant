import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

// End to end: the committed githooks/ block personal data on `git commit` and on
// `git push`, including a commit that skipped pre-commit with --no-verify.

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'robin-hooks-'));
  const repo = join(root, 'repo');
  const remote = join(root, 'remote.git');
  const ud = join(root, 'ud');
  mkdirSync(join(repo, 'system', 'scripts'), { recursive: true });
  mkdirSync(join(ud, 'config'), { recursive: true });
  writeFileSync(join(ud, 'config', 'operator.yaml'), 'private_terms: [Zephyrton]\n');
  cpSync('githooks', join(repo, 'githooks'), { recursive: true });
  cpSync('system/scripts/private-scan.mjs', join(repo, 'system/scripts/private-scan.mjs'));
  const env = { ...process.env, ROBIN_USER_DATA_DIR: ud };
  const git = (...args: string[]) => spawnSync('git', args, { cwd: repo, env, encoding: 'utf8' });
  execFileSync('git', ['init', '-q', '--bare', remote]);
  for (const args of [
    ['init', '-q'],
    ['config', 'user.email', 'test@example.com'],
    ['config', 'user.name', 'test'],
    ['config', 'core.hooksPath', 'githooks'],
    ['remote', 'add', 'origin', remote],
  ])
    git(...args);
  writeFileSync(join(repo, 'a.ts'), 'clean\n');
  git('add', '-A');
  assert.equal(git('commit', '-qm', 'base').status, 0);
  return { repo, git };
}

test('git hooks: pre-commit refuses staged personal data; a clean commit goes through', () => {
  const { repo, git } = setup();
  writeFileSync(join(repo, 'a.ts'), 'a trip to Zephyrton\n');
  git('add', 'a.ts');
  const refused = git('commit', '-qm', 'leak');
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /refused — personal data/);
  writeFileSync(join(repo, 'a.ts'), 'a trip to Lakeport\n');
  git('add', 'a.ts');
  assert.equal(git('commit', '-qm', 'fictional').status, 0);
});

test('git hooks: pre-push refuses a --no-verify leak, even one reverted before the push', () => {
  const { repo, git } = setup();
  assert.equal(git('push', '-q', 'origin', 'HEAD:main').status, 0, 'clean push allowed');
  writeFileSync(join(repo, 'a.ts'), 'a trip to Zephyrton\n');
  git('add', 'a.ts');
  assert.equal(git('commit', '-qm', 'leak', '--no-verify').status, 0);
  writeFileSync(join(repo, 'a.ts'), 'clean\n');
  git('add', 'a.ts');
  assert.equal(git('commit', '-qm', 'revert', '--no-verify').status, 0);
  const refused = git('push', '-q', 'origin', 'HEAD:main');
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /pre-push: refused/);
});

test('git hooks: pre-commit refuses a personal-mailbox identity, even passed with -c', () => {
  const { repo, git } = setup();
  writeFileSync(join(repo, 'a.ts'), 'still clean\n');
  git('add', 'a.ts');
  const refused = git('-c', 'user.email=jo.fake@gmail.com', 'commit', '-qm', 'x'); // privacy-scan:allow
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /commit identity.*personal-email/);
  assert.equal(git('commit', '-qm', 'x').status, 0, 'the repo identity commits fine');
});
