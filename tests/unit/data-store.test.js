import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';

test('paths().home defaults to <package_root>/user-data when ROBIN_HOME unset', async () => {
  Reflect.deleteProperty(process.env, 'ROBIN_HOME');
  const { paths, packageRootDir } = await import(
    `../../src/runtime/data-store.js?cb=${Date.now()}`
  );
  const root = packageRootDir();
  assert.equal(paths().home, join(root, 'user-data'));
});

test('ROBIN_HOME env var overrides default', async () => {
  process.env.ROBIN_HOME = '/tmp/robin-test-override';
  const { paths } = await import(`../../src/runtime/data-store.js?cb=${Date.now()}`);
  assert.equal(paths().home, '/tmp/robin-test-override');
});

test('paths() includes db, secrets, cache, config, backup, daemonState, daemonLock, migrationsDir', async () => {
  process.env.ROBIN_HOME = '/tmp/robin-test-paths';
  const { paths } = await import(`../../src/runtime/data-store.js?cb=${Date.now()}`);
  const p = paths();
  assert.equal(p.db, '/tmp/robin-test-paths/db');
  assert.equal(p.secrets, '/tmp/robin-test-paths/secrets');
  assert.equal(p.cache, '/tmp/robin-test-paths/cache');
  assert.equal(p.config, '/tmp/robin-test-paths/config.json');
  assert.equal(p.backup, '/tmp/robin-test-paths/backup');
  assert.equal(p.daemonState, '/tmp/robin-test-paths/.daemon.state');
  assert.equal(p.daemonLock, '/tmp/robin-test-paths/.daemon.lock');
  assert.match(p.migrationsDir, /\/src\/schema\/migrations$/);
});

test('migrationsDir resolves to source tree even when ROBIN_HOME is set elsewhere', async () => {
  process.env.ROBIN_HOME = '/tmp/something';
  const { paths, packageRootDir } = await import(
    `../../src/runtime/data-store.js?cb=${Date.now()}`
  );
  assert.equal(paths().migrationsDir, join(packageRootDir(), 'src', 'schema', 'migrations'));
});
