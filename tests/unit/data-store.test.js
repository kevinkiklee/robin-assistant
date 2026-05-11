import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';

test('paths.data.home() defaults to <package_root>/user-data when ROBIN_HOME unset', async () => {
  Reflect.deleteProperty(process.env, 'ROBIN_HOME');
  const { paths, packageRootDir } = await import(
    `../../src/runtime/data-store.js?cb=${Date.now()}`
  );
  const root = packageRootDir();
  assert.equal(paths.data.home(), join(root, 'user-data'));
});

test('ROBIN_HOME env var overrides default', async () => {
  process.env.ROBIN_HOME = '/tmp/robin-test-override';
  const { paths } = await import(`../../src/runtime/data-store.js?cb=${Date.now()}`);
  assert.equal(paths.data.home(), '/tmp/robin-test-override');
});

test('paths.data includes db, secrets, cache, config, backup, daemonState, daemonLock; paths.source includes migrations', async () => {
  process.env.ROBIN_HOME = '/tmp/robin-test-paths';
  const { paths } = await import(`../../src/runtime/data-store.js?cb=${Date.now()}`);
  assert.equal(paths.data.db(), '/tmp/robin-test-paths/db');
  assert.equal(paths.data.secrets(), '/tmp/robin-test-paths/secrets');
  assert.equal(paths.data.cache(), '/tmp/robin-test-paths/cache');
  assert.equal(paths.data.config(), '/tmp/robin-test-paths/config.json');
  assert.equal(paths.data.backup(), '/tmp/robin-test-paths/backup');
  assert.equal(paths.data.daemonState(), '/tmp/robin-test-paths/.daemon.state');
  assert.equal(paths.data.daemonLock(), '/tmp/robin-test-paths/.daemon.lock');
  assert.match(paths.source.migrations(), /\/src\/schema\/migrations$/);
});

test('migrations resolves to source tree even when ROBIN_HOME is set elsewhere', async () => {
  process.env.ROBIN_HOME = '/tmp/something';
  const { paths, packageRootDir } = await import(
    `../../src/runtime/data-store.js?cb=${Date.now()}`
  );
  assert.equal(paths.source.migrations(), join(packageRootDir(), 'src', 'schema', 'migrations'));
});

import { packageRootDir, paths, robinHome } from '../../src/runtime/data-store.js';

test('paths.data is under robinHome()', () => {
  const home = robinHome();
  for (const key of [
    'db',
    'secrets',
    'cache',
    'logs',
    'backup',
    'upload',
    'config',
    'hostIntegrations',
    'daemonState',
    'daemonLock',
    'manifestLock',
    'marker',
  ]) {
    const v = paths.data[key]();
    assert.ok(v.startsWith(home), `paths.data.${key}() should start with home (got ${v})`);
  }
});

test('paths.source is under packageRootDir()', () => {
  const root = packageRootDir();
  for (const key of ['migrations', 'hookShim', 'robinBin']) {
    const v = paths.source[key]();
    assert.ok(
      v.startsWith(root),
      `paths.source.${key}() should start with package root (got ${v})`,
    );
  }
});

test('paths.data and paths.source roots do not overlap', () => {
  assert.notStrictEqual(
    robinHome(),
    packageRootDir(),
    'data root and source root must be distinct',
  );
});
