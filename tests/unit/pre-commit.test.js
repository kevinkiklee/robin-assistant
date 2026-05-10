import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
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

const {
  installPreCommit,
  uninstallPreCommit,
  checkStagedDiffForSecrets,
  runPreCommit,
  _internals,
} = await import('../../src/install/pre-commit.js');

function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'robin-precommit-'));
  const r = spawnSync('git', ['init', '-q'], { cwd: dir });
  assert.equal(r.status, 0, 'git init must succeed');
  return dir;
}

test('checkStagedDiffForSecrets: clean diff returns ok', async () => {
  const diff = `diff --git a/foo.txt b/foo.txt
new file mode 100644
index 0000000..1234567
--- /dev/null
+++ b/foo.txt
@@ -0,0 +1 @@
+hello world
`;
  const r = await checkStagedDiffForSecrets({ runGitDiff: () => diff });
  assert.equal(r.ok, true);
  assert.deepEqual(r.findings, []);
});

test('checkStagedDiffForSecrets: empty diff returns ok', async () => {
  const r = await checkStagedDiffForSecrets({ runGitDiff: () => '' });
  assert.equal(r.ok, true);
});

test('checkStagedDiffForSecrets: detects sk- API key shape', async () => {
  const diff = `diff --git a/cfg.js b/cfg.js
new file mode 100644
index 0000000..1234567
--- /dev/null
+++ b/cfg.js
@@ -0,0 +1 @@
+const KEY = "sk-${'a'.repeat(40)}";
`;
  const r = await checkStagedDiffForSecrets({ runGitDiff: () => diff });
  assert.equal(r.ok, false);
  assert.ok(r.findings.length >= 1);
  assert.equal(r.findings[0].path, 'cfg.js');
  assert.match(r.findings[0].pattern, /openai/);
});

test('checkStagedDiffForSecrets: detects .env path', async () => {
  const diff = `diff --git a/.env b/.env
new file mode 100644
index 0000000..1234567
--- /dev/null
+++ b/.env
@@ -0,0 +1 @@
+FOO=bar
`;
  const r = await checkStagedDiffForSecrets({ runGitDiff: () => diff });
  assert.equal(r.ok, false);
  assert.ok(r.findings.some((f) => f.pattern === 'dotenv-path'));
});

test('checkStagedDiffForSecrets: detects secrets/ path', async () => {
  const diff = `diff --git a/secrets/api.key b/secrets/api.key
new file mode 100644
index 0000000..1234567
--- /dev/null
+++ b/secrets/api.key
@@ -0,0 +1 @@
+abc
`;
  const r = await checkStagedDiffForSecrets({ runGitDiff: () => diff });
  assert.equal(r.ok, false);
  assert.ok(r.findings.some((f) => f.pattern === 'secrets-path'));
});

test('checkStagedDiffForSecrets: AWS access key in added line', async () => {
  const diff = `diff --git a/foo.txt b/foo.txt
new file mode 100644
index 0000000..1234567
--- /dev/null
+++ b/foo.txt
@@ -0,0 +1 @@
+access=AKIA${'A'.repeat(16)}
`;
  const r = await checkStagedDiffForSecrets({ runGitDiff: () => diff });
  assert.equal(r.ok, false);
  assert.ok(r.findings.some((f) => f.pattern === 'aws_access_key'));
});

test('installPreCommit: writes hook file in fresh git repo', async () => {
  const dir = makeRepo();
  const r = await installPreCommit({ cwd: dir });
  assert.equal(r.installed, true);
  const hookPath = join(dir, '.git', 'hooks', 'pre-commit');
  assert.ok(existsSync(hookPath), 'hook file should exist');
  const content = readFileSync(hookPath, 'utf8');
  assert.match(content, /pre-commit run/);
  assert.match(content, /^#!\/usr\/bin\/env bash/);
});

test('installPreCommit: not a git repo returns reason', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'robin-no-git-'));
  const r = await installPreCommit({ cwd: dir });
  assert.equal(r.installed, false);
  assert.match(r.reason, /not a git repo/);
});

test('installPreCommit: idempotent — second install reports installed', async () => {
  const dir = makeRepo();
  const r1 = await installPreCommit({ cwd: dir });
  assert.equal(r1.installed, true);
  const before = readFileSync(join(dir, '.git', 'hooks', 'pre-commit'), 'utf8');
  const r2 = await installPreCommit({ cwd: dir });
  assert.equal(r2.installed, true);
  const after = readFileSync(join(dir, '.git', 'hooks', 'pre-commit'), 'utf8');
  assert.equal(before, after, 'idempotent install must not rewrite');
});

test('installPreCommit: refuses to overwrite an unrelated existing hook', async () => {
  const dir = makeRepo();
  const hookPath = join(dir, '.git', 'hooks', 'pre-commit');
  writeFileSync(hookPath, '#!/bin/sh\necho user hook\n', { mode: 0o755 });
  const r = await installPreCommit({ cwd: dir });
  assert.equal(r.installed, false);
  assert.match(r.reason, /existing/);
  // Existing user hook must be untouched.
  assert.equal(readFileSync(hookPath, 'utf8'), '#!/bin/sh\necho user hook\n');
});

test('uninstallPreCommit: removes our hook', async () => {
  const dir = makeRepo();
  await installPreCommit({ cwd: dir });
  const hookPath = join(dir, '.git', 'hooks', 'pre-commit');
  assert.ok(existsSync(hookPath));
  const r = await uninstallPreCommit({ cwd: dir });
  assert.equal(r.uninstalled, true);
  assert.ok(!existsSync(hookPath), 'hook should be removed');
});

test('uninstallPreCommit: leaves unrelated hook alone', async () => {
  const dir = makeRepo();
  const hookPath = join(dir, '.git', 'hooks', 'pre-commit');
  writeFileSync(hookPath, '#!/bin/sh\necho user hook\n', { mode: 0o755 });
  const r = await uninstallPreCommit({ cwd: dir });
  assert.equal(r.uninstalled, false);
  assert.ok(existsSync(hookPath), 'unrelated hook must remain');
});

test('uninstallPreCommit: not a git repo returns reason', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'robin-no-git-'));
  const r = await uninstallPreCommit({ cwd: dir });
  assert.equal(r.uninstalled, false);
  assert.match(r.reason, /not a git repo/);
});

test('runPreCommit: clean diff exits 0', async () => {
  const exitCalls = [];
  const stderrLines = [];
  await runPreCommit({
    runGitDiff: () => '',
    stderr: (s) => stderrLines.push(s),
    exit: (c) => exitCalls.push(c),
  });
  assert.deepEqual(exitCalls, [0]);
  assert.deepEqual(stderrLines, []);
});

test('runPreCommit: dirty diff exits 1 and prints findings', async () => {
  const diff = `diff --git a/.env b/.env
new file mode 100644
index 0000000..1234567
--- /dev/null
+++ b/.env
@@ -0,0 +1 @@
+SECRET_TOKEN=sk-${'a'.repeat(40)}
`;
  const exitCalls = [];
  const stderrLines = [];
  await runPreCommit({
    runGitDiff: () => diff,
    stderr: (s) => stderrLines.push(s),
    exit: (c) => exitCalls.push(c),
  });
  assert.deepEqual(exitCalls, [1]);
  assert.ok(stderrLines.length >= 1);
  for (const line of stderrLines) {
    assert.match(line, /^Robin pre-commit: blocked — /);
  }
});

test('parseStagedDiff: rename header sets path', async () => {
  const diff = `diff --git a/old.txt b/new.txt
similarity index 100%
rename from old.txt
rename to new.txt
`;
  const m = _internals.parseStagedDiff(diff);
  assert.ok(m.has('new.txt'));
});
