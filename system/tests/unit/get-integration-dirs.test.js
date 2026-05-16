import { strict as assert } from 'node:assert';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { getIntegrationDirs, packageRootDir } from '../../config/data-store.js';

test('returns [systemDir] when user-data integrations dir does not exist', () => {
  const home = mkdtempSync(join(tmpdir(), 'robin-int-dirs-'));
  const prev = process.env.ROBIN_HOME;
  try {
    process.env.ROBIN_HOME = home;
    const dirs = getIntegrationDirs();
    assert.equal(dirs.length, 1);
    assert.equal(dirs[0], join(packageRootDir(), 'system', 'io', 'integrations'));
  } finally {
    if (prev === undefined) delete process.env.ROBIN_HOME;
    else process.env.ROBIN_HOME = prev;
    rmSync(home, { recursive: true, force: true });
  }
});

test('returns [systemDir, userDataDir] when user-data integrations dir exists', () => {
  const home = mkdtempSync(join(tmpdir(), 'robin-int-dirs-'));
  const prev = process.env.ROBIN_HOME;
  try {
    mkdirSync(join(home, 'io', 'integrations'), { recursive: true });
    process.env.ROBIN_HOME = home;
    const dirs = getIntegrationDirs();
    assert.equal(dirs.length, 2);
    assert.equal(dirs[0], join(packageRootDir(), 'system', 'io', 'integrations'));
    assert.equal(dirs[1], join(home, 'io', 'integrations'));
  } finally {
    if (prev === undefined) delete process.env.ROBIN_HOME;
    else process.env.ROBIN_HOME = prev;
    rmSync(home, { recursive: true, force: true });
  }
});

test('returns [systemDir] when no home is configured (no ROBIN_HOME, no pointer)', () => {
  const prev = process.env.ROBIN_HOME;
  const prevPtr = process.env.ROBIN_POINTER_PATH;
  const prevPkgRoot = process.env.ROBIN_PACKAGE_ROOT_OVERRIDE;
  const prevFallback = process.env.ROBIN_POINTER_FALLBACK_PATH;
  const tmp = mkdtempSync(join(tmpdir(), 'robin-int-dirs-nohome-'));
  try {
    delete process.env.ROBIN_HOME;
    // Point pointer search at locations that do not exist, so readPointer() returns null.
    process.env.ROBIN_POINTER_PATH = join(tmp, 'nonexistent-pointer.json');
    const dirs = getIntegrationDirs();
    assert.equal(dirs.length, 1);
    assert.equal(dirs[0], join(packageRootDir(), 'system', 'io', 'integrations'));
  } finally {
    if (prev === undefined) delete process.env.ROBIN_HOME;
    else process.env.ROBIN_HOME = prev;
    if (prevPtr === undefined) delete process.env.ROBIN_POINTER_PATH;
    else process.env.ROBIN_POINTER_PATH = prevPtr;
    if (prevPkgRoot === undefined) delete process.env.ROBIN_PACKAGE_ROOT_OVERRIDE;
    else process.env.ROBIN_PACKAGE_ROOT_OVERRIDE = prevPkgRoot;
    if (prevFallback === undefined) delete process.env.ROBIN_POINTER_FALLBACK_PATH;
    else process.env.ROBIN_POINTER_FALLBACK_PATH = prevFallback;
    rmSync(tmp, { recursive: true, force: true });
  }
});
