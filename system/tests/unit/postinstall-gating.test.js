// Verifies that the postinstall script (npm/pnpm/yarn `postinstall` entry)
// correctly *skips* execution in the documented gating conditions: explicit
// opt-out, CI, global install, transitive install, and already-installed.
// The actual auto-setup path (calling `robin install --auto`) is exercised by
// install.test.js and is too host-mutating to invoke here.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(here, '../../..');
const postinstallPath = join(packageRoot, 'system/runtime/install/postinstall.js');

function runPostinstall(env, opts = {}) {
  return spawnSync(process.execPath, [opts.scriptPath ?? postinstallPath], {
    // Pass only the env we want — strip inherited ROBIN_*/CI/npm_* so prior
    // shell state cannot contaminate the gating decision under test.
    env: { PATH: process.env.PATH, ...env },
    cwd: opts.cwd ?? packageRoot,
    encoding: 'utf-8',
    timeout: 10000,
  });
}

test('postinstall skips silently when ROBIN_SKIP_INSTALL is set', () => {
  const res = runPostinstall({ ROBIN_SKIP_INSTALL: '1' });
  assert.equal(res.status, 0);
  assert.equal(res.stdout.trim(), '');
  assert.equal(res.stderr.trim(), '');
});

test('postinstall skips silently when CI is set', () => {
  const res = runPostinstall({ CI: 'true' });
  assert.equal(res.status, 0);
  assert.equal(res.stdout.trim(), '');
  assert.equal(res.stderr.trim(), '');
});

test('postinstall skips with hint when npm_config_global=true', () => {
  const res = runPostinstall({ npm_config_global: 'true' });
  assert.equal(res.status, 0);
  assert.match(res.stdout, /global/i);
});

test('postinstall skips silently when INIT_CWD differs from cwd (transitive install)', () => {
  // npm sets INIT_CWD to the directory where install was invoked.
  // When that differs from cwd (the package being installed as a dep),
  // the postinstall must skip.
  const tmp = mkdtempSync(join(tmpdir(), 'robin-init-cwd-'));
  try {
    const res = runPostinstall({ INIT_CWD: tmp });
    assert.equal(res.status, 0);
    assert.equal(res.stdout.trim(), '');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('postinstall runs `install --upgrade` when .robin-home pointer exists at package root', () => {
  // Simulate an already-installed package by placing a copy of the script in
  // a fake package-root tree (so `resolve(here, "../../..")` lands at the
  // tmpdir) and writing a `.robin-home` pointer there.
  //
  // The fake tree has no `system/bin/robin`, so the spawned node process
  // exits non-zero. We assert (a) postinstall did NOT print the old
  // "already installed" advise (the manual-step hint is gone), and (b) it
  // attempted to launch auto-setup — proving it took the run path rather
  // than the silent-skip path.
  const tmp = mkdtempSync(join(tmpdir(), 'robin-fake-root-'));
  try {
    writeFileSync(join(tmp, '.robin-home'), '/tmp/somewhere');
    const fakeDir = join(tmp, 'system', 'runtime', 'install');
    mkdirSync(fakeDir, { recursive: true });
    const fakeScript = join(fakeDir, 'postinstall.js');
    writeFileSync(fakeScript, readFileSync(postinstallPath, 'utf-8'));
    const res = runPostinstall({}, { scriptPath: fakeScript, cwd: tmp });
    assert.equal(res.status, 0);
    assert.doesNotMatch(res.stdout, /already installed/i);
    assert.match(res.stdout, /auto-setup exited/i);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
