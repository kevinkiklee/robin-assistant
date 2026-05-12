import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..', '..');
const binPath = join(repoRoot, 'system', 'bin', 'robin');
const pkgVersion = JSON.parse(
  execFileSync('node', ['-p', `JSON.stringify(require('${join(repoRoot, 'package.json')}'))`], {
    encoding: 'utf8',
  }),
).version;

// Regression: a previous version of commands/version.js used the wrong
// relative path (`../../../package.json`) and read `system/package.json`
// instead of the real one, so `robin --version` failed with ENOENT before
// install had a chance to set up the home pointer. The CLI must report a
// version and continue gracefully when no home pointer is set.
function runCli(args, env = {}) {
  return execFileSync('node', [binPath, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ROBIN_SKIP_FIRST_RUN: '1', ...env },
  });
}

test('`robin --version` reports the package.json version', () => {
  const isolatedHome = join(tmpdir(), `robin-cli-version-${Date.now()}`);
  mkdirSync(isolatedHome, { recursive: true });
  try {
    const out = runCli(['--version'], {
      // Point pointer + fallback at empty files so we cleanly simulate
      // "not installed" without depending on Kevin's machine state.
      ROBIN_POINTER_PATH: join(isolatedHome, 'pointer.json'),
      HOME: isolatedHome,
    });
    assert.match(out, new RegExp(`robin-assistant ${pkgVersion.replace(/\./g, '\\.')}`));
    assert.match(out, /home:/);
  } finally {
    rmSync(isolatedHome, { recursive: true, force: true });
  }
});

test('`robin --version` does not throw when uninstalled', () => {
  const isolatedHome = join(tmpdir(), `robin-cli-version-uninstalled-${Date.now()}`);
  mkdirSync(isolatedHome, { recursive: true });
  try {
    const out = runCli(['--version'], {
      ROBIN_POINTER_PATH: join(isolatedHome, 'pointer.json'),
      HOME: isolatedHome,
    });
    // Either "not installed" message or a valid home path is acceptable;
    // both are exit-0 outcomes.
    assert.match(out, /home:/);
  } finally {
    rmSync(isolatedHome, { recursive: true, force: true });
  }
});

test('`robin --version` honours an installed pointer', () => {
  const isolatedHome = join(tmpdir(), `robin-cli-version-installed-${Date.now()}`);
  mkdirSync(isolatedHome, { recursive: true });
  const userData = join(isolatedHome, 'user-data');
  mkdirSync(userData, { recursive: true });
  const pointerPath = join(isolatedHome, 'pointer.json');
  writeFileSync(
    pointerPath,
    JSON.stringify({
      version: 1,
      home: userData,
      installedAt: new Date().toISOString(),
      installedBy: 'test',
    }),
  );
  try {
    const out = runCli(['--version'], {
      ROBIN_POINTER_PATH: pointerPath,
      HOME: isolatedHome,
    });
    assert.match(out, new RegExp(`robin-assistant ${pkgVersion.replace(/\./g, '\\.')}`));
    assert.match(out, new RegExp(`home: ${userData.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  } finally {
    rmSync(isolatedHome, { recursive: true, force: true });
  }
});
