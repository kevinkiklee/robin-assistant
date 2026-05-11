/**
 * Tests for the read-only-package-root fallback introduced in data-store.js §18.
 *
 * Strategy: two env vars control both ends of the fallback chain without
 * touching real OS config directories:
 *
 *   ROBIN_PACKAGE_ROOT_OVERRIDE  — redirects the primary (package-root) pointer
 *                                  to a controlled tmpdir.
 *   ROBIN_POINTER_FALLBACK_PATH  — overrides the OS-config fallback path.
 *
 * We do NOT use ROBIN_POINTER_PATH here because that collapses the two-path
 * logic into a single path, which would bypass the fallback behaviour.
 *
 * We also export `osConfigPointerPath` as a pure function so the
 * path-computation logic can be unit-tested without filesystem access.
 */

import assert from 'node:assert/strict';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  POINTER_VERSION,
  deletePointer,
  osConfigPointerPath,
  pointerExists,
  readPointer,
  writePointer,
} from '../../src/runtime/data-store.js';

// ── helpers ───────────────────────────────────────────────────────────────────

function makeTmp(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

/**
 * Run `fn` with ROBIN_PACKAGE_ROOT_OVERRIDE and ROBIN_POINTER_FALLBACK_PATH
 * set, then restore originals.
 *
 * `pkgRoot`  → ROBIN_PACKAGE_ROOT_OVERRIDE
 *               The primary pointer lives at `join(pkgRoot, '.robin-home')`.
 * `fallback` → ROBIN_POINTER_FALLBACK_PATH
 *               Overrides the OS-config path used as the write/read fallback.
 *
 * ROBIN_HOME is cleared so it cannot mask pointer resolution.
 */
function withPointerEnv({ pkgRoot, fallback }, fn) {
  const prevPkgRoot = process.env.ROBIN_PACKAGE_ROOT_OVERRIDE;
  const prevFallback = process.env.ROBIN_POINTER_FALLBACK_PATH;
  const prevHome = process.env.ROBIN_HOME;

  if (pkgRoot !== undefined) process.env.ROBIN_PACKAGE_ROOT_OVERRIDE = pkgRoot;
  // biome-ignore lint/performance/noDelete: intentional env-var clearing
  else delete process.env.ROBIN_PACKAGE_ROOT_OVERRIDE;
  if (fallback !== undefined) process.env.ROBIN_POINTER_FALLBACK_PATH = fallback;
  // biome-ignore lint/performance/noDelete: intentional env-var clearing
  else delete process.env.ROBIN_POINTER_FALLBACK_PATH;
  // biome-ignore lint/performance/noDelete: env vars must be deleted, not assigned undefined
  delete process.env.ROBIN_HOME;

  try {
    return fn();
  } finally {
    if (prevPkgRoot !== undefined) process.env.ROBIN_PACKAGE_ROOT_OVERRIDE = prevPkgRoot;
    // biome-ignore lint/performance/noDelete: env vars must be deleted, not assigned undefined
    else delete process.env.ROBIN_PACKAGE_ROOT_OVERRIDE;
    if (prevFallback !== undefined) process.env.ROBIN_POINTER_FALLBACK_PATH = prevFallback;
    // biome-ignore lint/performance/noDelete: env vars must be deleted, not assigned undefined
    else delete process.env.ROBIN_POINTER_FALLBACK_PATH;
    if (prevHome !== undefined) process.env.ROBIN_HOME = prevHome;
    // biome-ignore lint/performance/noDelete: env vars must be deleted, not assigned undefined
    else delete process.env.ROBIN_HOME;
  }
}

// ── osConfigPointerPath() pure-function tests ─────────────────────────────────

test('osConfigPointerPath: macOS returns Library/Application Support/Robin/install.json', () => {
  const result = osConfigPointerPath({
    platform: 'darwin',
    home: '/Users/alice',
    xdgConfigHome: undefined,
  });
  assert.strictEqual(result, '/Users/alice/Library/Application Support/Robin/install.json');
});

test('osConfigPointerPath: Linux without XDG_CONFIG_HOME uses ~/.config/robin/install.json', () => {
  const result = osConfigPointerPath({
    platform: 'linux',
    home: '/home/bob',
    xdgConfigHome: undefined,
  });
  assert.strictEqual(result, '/home/bob/.config/robin/install.json');
});

test('osConfigPointerPath: Linux with XDG_CONFIG_HOME uses that dir', () => {
  const result = osConfigPointerPath({
    platform: 'linux',
    home: '/home/bob',
    xdgConfigHome: '/home/bob/.xdg-config',
  });
  assert.strictEqual(result, '/home/bob/.xdg-config/robin/install.json');
});

test('osConfigPointerPath: non-darwin/linux (FreeBSD etc.) falls through to XDG path', () => {
  const result = osConfigPointerPath({
    platform: 'freebsd',
    home: '/home/carol',
    xdgConfigHome: undefined,
  });
  assert.strictEqual(result, '/home/carol/.config/robin/install.json');
});

// ── writePointer fallback on EACCES ──────────────────────────────────────────

test('writePointer falls back to ROBIN_POINTER_FALLBACK_PATH when primary dir is read-only', () => {
  const readOnlyDir = makeTmp('robin-ptr-ro-');
  const fallbackDir = makeTmp('robin-ptr-fb-');
  // Primary pointer path is join(readOnlyDir, '.robin-home') — derived inside pointerLocation().
  const primaryPath = join(readOnlyDir, '.robin-home');
  const fallbackPath = join(fallbackDir, 'install.json');
  const homeDir = makeTmp('robin-home-');

  // Make the primary dir read-only so writes to it fail with EACCES.
  chmodSync(readOnlyDir, 0o500);

  try {
    withPointerEnv({ pkgRoot: readOnlyDir, fallback: fallbackPath }, () => {
      writePointer({ home: homeDir, installedBy: 'test-fallback' });

      // Primary must NOT have been written.
      assert.ok(!existsSync(primaryPath), 'primary pointer must not exist in read-only dir');

      // Fallback must have been written with the correct payload.
      assert.ok(existsSync(fallbackPath), 'fallback pointer must exist');
      const parsed = JSON.parse(readFileSync(fallbackPath, 'utf8'));
      assert.strictEqual(parsed.version, POINTER_VERSION);
      assert.ok(parsed.home.endsWith(homeDir.replace(/^.*\//, '')), 'home path mismatch');
      assert.strictEqual(parsed.installedBy, 'test-fallback');
    });
  } finally {
    chmodSync(readOnlyDir, 0o700); // restore so rmSync can clean up
    rmSync(readOnlyDir, { recursive: true, force: true });
    rmSync(fallbackDir, { recursive: true, force: true });
    rmSync(homeDir, { recursive: true, force: true });
  }
});

// ── readPointer finds the fallback when primary is absent ────────────────────

test('readPointer returns pointer from fallback location when primary is missing', () => {
  const primaryDir = makeTmp('robin-ptr-pri-');
  const fallbackDir = makeTmp('robin-ptr-fb-');
  const primaryPath = join(primaryDir, '.robin-home');
  const fallbackPath = join(fallbackDir, 'install.json');
  const homeDir = makeTmp('robin-home-');

  const payload = {
    version: POINTER_VERSION,
    home: homeDir,
    installedAt: new Date().toISOString(),
    installedBy: 'test-read-fallback',
  };
  writeFileSync(fallbackPath, JSON.stringify(payload, null, 2));

  try {
    withPointerEnv({ pkgRoot: primaryDir, fallback: fallbackPath }, () => {
      // Confirm primary does not exist.
      assert.ok(!existsSync(primaryPath), 'precondition: primary must be absent');

      const result = readPointer();
      assert.ok(result !== null, 'readPointer must return non-null');
      assert.strictEqual(result.home, homeDir);
      assert.strictEqual(result.installedBy, 'test-read-fallback');
    });
  } finally {
    rmSync(primaryDir, { recursive: true, force: true });
    rmSync(fallbackDir, { recursive: true, force: true });
    rmSync(homeDir, { recursive: true, force: true });
  }
});

test('readPointer returns null when neither primary nor fallback exists', () => {
  const primaryDir = makeTmp('robin-ptr-pri-');
  const fallbackDir = makeTmp('robin-ptr-fb-');
  const fallbackPath = join(fallbackDir, 'install.json');

  try {
    withPointerEnv({ pkgRoot: primaryDir, fallback: fallbackPath }, () => {
      const result = readPointer();
      assert.strictEqual(result, null);
    });
  } finally {
    rmSync(primaryDir, { recursive: true, force: true });
    rmSync(fallbackDir, { recursive: true, force: true });
  }
});

// ── pointerExists returns true if EITHER location has a pointer ───────────────

test('pointerExists is true when only primary has a pointer', () => {
  const primaryDir = makeTmp('robin-ptr-pri-');
  const fallbackDir = makeTmp('robin-ptr-fb-');
  const primaryPath = join(primaryDir, '.robin-home');
  const fallbackPath = join(fallbackDir, 'install.json');

  const payload = {
    version: POINTER_VERSION,
    home: '/tmp/x',
    installedAt: '',
    installedBy: 'test',
  };
  writeFileSync(primaryPath, JSON.stringify(payload));

  try {
    withPointerEnv({ pkgRoot: primaryDir, fallback: fallbackPath }, () => {
      assert.ok(pointerExists(), 'must be true with only primary present');
    });
  } finally {
    rmSync(primaryDir, { recursive: true, force: true });
    rmSync(fallbackDir, { recursive: true, force: true });
  }
});

test('pointerExists is true when only fallback has a pointer', () => {
  const primaryDir = makeTmp('robin-ptr-pri-');
  const fallbackDir = makeTmp('robin-ptr-fb-');
  const fallbackPath = join(fallbackDir, 'install.json');

  const payload = {
    version: POINTER_VERSION,
    home: '/tmp/x',
    installedAt: '',
    installedBy: 'test',
  };
  writeFileSync(fallbackPath, JSON.stringify(payload));

  try {
    withPointerEnv({ pkgRoot: primaryDir, fallback: fallbackPath }, () => {
      assert.ok(pointerExists(), 'must be true with only fallback present');
    });
  } finally {
    rmSync(primaryDir, { recursive: true, force: true });
    rmSync(fallbackDir, { recursive: true, force: true });
  }
});

test('pointerExists is false when neither location has a pointer', () => {
  const primaryDir = makeTmp('robin-ptr-pri-');
  const fallbackDir = makeTmp('robin-ptr-fb-');
  const fallbackPath = join(fallbackDir, 'install.json');

  try {
    withPointerEnv({ pkgRoot: primaryDir, fallback: fallbackPath }, () => {
      assert.ok(!pointerExists(), 'must be false with no pointer anywhere');
    });
  } finally {
    rmSync(primaryDir, { recursive: true, force: true });
    rmSync(fallbackDir, { recursive: true, force: true });
  }
});

// ── deletePointer cleans up BOTH locations ────────────────────────────────────

test('deletePointer removes both primary and fallback when both exist', () => {
  const primaryDir = makeTmp('robin-ptr-pri-');
  const fallbackDir = makeTmp('robin-ptr-fb-');
  const primaryPath = join(primaryDir, '.robin-home');
  const fallbackPath = join(fallbackDir, 'install.json');

  const payload = {
    version: POINTER_VERSION,
    home: '/tmp/x',
    installedAt: '',
    installedBy: 'test',
  };
  writeFileSync(primaryPath, JSON.stringify(payload));
  writeFileSync(fallbackPath, JSON.stringify(payload));

  try {
    withPointerEnv({ pkgRoot: primaryDir, fallback: fallbackPath }, () => {
      deletePointer();
      assert.ok(!existsSync(primaryPath), 'primary must be deleted');
      assert.ok(!existsSync(fallbackPath), 'fallback must be deleted');
    });
  } finally {
    rmSync(primaryDir, { recursive: true, force: true });
    rmSync(fallbackDir, { recursive: true, force: true });
  }
});

test('deletePointer removes only primary when fallback is absent', () => {
  const primaryDir = makeTmp('robin-ptr-pri-');
  const fallbackDir = makeTmp('robin-ptr-fb-');
  const primaryPath = join(primaryDir, '.robin-home');
  const fallbackPath = join(fallbackDir, 'install.json');

  const payload = {
    version: POINTER_VERSION,
    home: '/tmp/x',
    installedAt: '',
    installedBy: 'test',
  };
  writeFileSync(primaryPath, JSON.stringify(payload));

  try {
    withPointerEnv({ pkgRoot: primaryDir, fallback: fallbackPath }, () => {
      deletePointer();
      assert.ok(!existsSync(primaryPath), 'primary must be deleted');
      assert.ok(!existsSync(fallbackPath), 'fallback must remain absent');
    });
  } finally {
    rmSync(primaryDir, { recursive: true, force: true });
    rmSync(fallbackDir, { recursive: true, force: true });
  }
});

test('deletePointer removes only fallback when primary is absent', () => {
  const primaryDir = makeTmp('robin-ptr-pri-');
  const fallbackDir = makeTmp('robin-ptr-fb-');
  const primaryPath = join(primaryDir, '.robin-home');
  const fallbackPath = join(fallbackDir, 'install.json');

  const payload = {
    version: POINTER_VERSION,
    home: '/tmp/x',
    installedAt: '',
    installedBy: 'test',
  };
  writeFileSync(fallbackPath, JSON.stringify(payload));

  try {
    withPointerEnv({ pkgRoot: primaryDir, fallback: fallbackPath }, () => {
      deletePointer();
      assert.ok(!existsSync(primaryPath), 'primary must remain absent');
      assert.ok(!existsSync(fallbackPath), 'fallback must be deleted');
    });
  } finally {
    rmSync(primaryDir, { recursive: true, force: true });
    rmSync(fallbackDir, { recursive: true, force: true });
  }
});

// ── writePointer creates parent dirs for fallback ─────────────────────────────

test('writePointer creates fallback parent directories automatically', () => {
  const readOnlyDir = makeTmp('robin-ptr-ro-');
  const fallbackBase = makeTmp('robin-ptr-fb-base-');
  // Nested path that does not yet exist — writePointer must mkdirSync it.
  const fallbackPath = join(fallbackBase, 'nested', 'deep', 'install.json');
  const homeDir = makeTmp('robin-home-');

  chmodSync(readOnlyDir, 0o500);

  try {
    withPointerEnv({ pkgRoot: readOnlyDir, fallback: fallbackPath }, () => {
      writePointer({ home: homeDir, installedBy: 'test-mkdir' });
      assert.ok(existsSync(fallbackPath), 'fallback must be written into auto-created dirs');
    });
  } finally {
    chmodSync(readOnlyDir, 0o700);
    rmSync(readOnlyDir, { recursive: true, force: true });
    rmSync(fallbackBase, { recursive: true, force: true });
    rmSync(homeDir, { recursive: true, force: true });
  }
});

// ── writePointer: non-EACCES errors are re-thrown ────────────────────────────

test('writePointer re-throws errors that are not EACCES/EROFS/ENOENT', () => {
  // Make the primary path a directory — writeFileSync on the .tmp path will
  // fail with EISDIR because the path ends in a directory name, not a file.
  // We achieve this by pointing pkgRoot at a dir whose name ends in '.robin-home'
  // would conflict — simpler: write a directory at the .tmp path location.
  // Easiest: make primaryDir/.robin-home a directory (not a file).
  const primaryDir = makeTmp('robin-ptr-pri-');
  // Create a directory where the pointer file would go.
  const primaryPointerAsDir = join(primaryDir, '.robin-home');
  mkdirSync(primaryPointerAsDir, { recursive: true });
  // Now when writePointerAtomic tries to write .robin-home.tmp and rename,
  // the rename step will fail because .robin-home is a non-empty dir path that
  // we can't overwrite atomically (EISDIR on the rename target).
  // Actually, writeFileSync writes to .robin-home.tmp (succeeds), then
  // renameSync(.tmp, .robin-home) where .robin-home is a directory → EISDIR.

  const fallbackDir = makeTmp('robin-ptr-fb-');
  const fallbackPath = join(fallbackDir, 'install.json');
  const homeDir = makeTmp('robin-home-');

  try {
    withPointerEnv({ pkgRoot: primaryDir, fallback: fallbackPath }, () => {
      assert.throws(
        () => writePointer({ home: homeDir, installedBy: 'test-throws' }),
        (e) =>
          e.code !== undefined && e.code !== 'EACCES' && e.code !== 'EROFS' && e.code !== 'ENOENT',
      );
      // Fallback must NOT have been written since we re-threw.
      assert.ok(!existsSync(fallbackPath), 'fallback must not be written on non-EACCES error');
    });
  } finally {
    rmSync(primaryDir, { recursive: true, force: true });
    rmSync(fallbackDir, { recursive: true, force: true });
    rmSync(homeDir, { recursive: true, force: true });
  }
});
