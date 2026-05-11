import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

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

import { ensureHome, packageRootDir, paths, resolveHomeStrict, POINTER_VERSION, robinHome } from '../../src/runtime/data-store.js';

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

// ── Task 1.4 imports ─────────────────────────────────────────────────────────
import { writeFileSync as fsWriteSync } from 'node:fs';

// ── Task 1.3: .robin-data marker ──────────────────────────────────────────────

test('ensureHome() writes .robin-data marker with version', async () => {
  const home = mkdtempSync(join(tmpdir(), 'robin-home-'));
  const prev = process.env.ROBIN_HOME;
  process.env.ROBIN_HOME = home;
  try {
    await ensureHome();
    const markerPath = paths.data.marker();
    const raw = readFileSync(markerPath, 'utf8');
    const parsed = JSON.parse(raw);
    assert.strictEqual(parsed.version, 1);
    assert.ok(typeof parsed.createdAt === 'string');
    assert.ok(new Date(parsed.createdAt).toISOString() === parsed.createdAt);
  } finally {
    if (prev) process.env.ROBIN_HOME = prev;
    else delete process.env.ROBIN_HOME;
    rmSync(home, { recursive: true, force: true });
  }
});

test('ensureHome() is idempotent and preserves an existing marker', async () => {
  const home = mkdtempSync(join(tmpdir(), 'robin-home-'));
  const prev = process.env.ROBIN_HOME;
  process.env.ROBIN_HOME = home;
  try {
    await ensureHome();
    const firstRaw = readFileSync(paths.data.marker(), 'utf8');
    await new Promise((r) => setTimeout(r, 5));
    await ensureHome();
    const secondRaw = readFileSync(paths.data.marker(), 'utf8');
    assert.strictEqual(firstRaw, secondRaw);
  } finally {
    if (prev) process.env.ROBIN_HOME = prev;
    else delete process.env.ROBIN_HOME;
    rmSync(home, { recursive: true, force: true });
  }
});

// ── Task 1.4: strict resolver + .robin-home pointer ──────────────────────────

test('strict resolver: $ROBIN_HOME wins when set and target exists', async () => {
  const home = mkdtempSync(join(tmpdir(), 'robin-home-'));
  const prev = process.env.ROBIN_HOME;
  process.env.ROBIN_HOME = home;
  try {
    const resolved = resolveHomeStrict();
    assert.strictEqual(resolved, home);
  } finally {
    if (prev) process.env.ROBIN_HOME = prev;
    else delete process.env.ROBIN_HOME;
    rmSync(home, { recursive: true, force: true });
  }
});

test('strict resolver: throws "Robin is not installed" when neither set', () => {
  const prev = process.env.ROBIN_HOME;
  delete process.env.ROBIN_HOME;
  try {
    assert.throws(
      () => resolveHomeStrict({ pointerPath: '/tmp/does-not-exist-robin-home.json' }),
      /Robin is not installed.*robin install/,
    );
  } finally {
    if (prev) process.env.ROBIN_HOME = prev;
  }
});

test('strict resolver: pointer file with valid target resolves to it', () => {
  const home = mkdtempSync(join(tmpdir(), 'robin-home-'));
  const pkg = mkdtempSync(join(tmpdir(), 'robin-pkg-'));
  const pointerPath = join(pkg, '.robin-home');
  fsWriteSync(pointerPath, JSON.stringify({
    version: 1, home, installedAt: '2026-05-10T00:00:00Z', installedBy: 'test',
  }));
  const prev = process.env.ROBIN_HOME;
  delete process.env.ROBIN_HOME;
  try {
    const resolved = resolveHomeStrict({ pointerPath });
    assert.strictEqual(resolved, home);
  } finally {
    if (prev) process.env.ROBIN_HOME = prev;
    rmSync(home, { recursive: true, force: true });
    rmSync(pkg, { recursive: true, force: true });
  }
});

test('strict resolver: pointer target missing throws --relocate hint', () => {
  const pkg = mkdtempSync(join(tmpdir(), 'robin-pkg-'));
  const pointerPath = join(pkg, '.robin-home');
  fsWriteSync(pointerPath, JSON.stringify({
    version: 1, home: '/tmp/this-path-does-not-exist-robin-xyz',
    installedAt: '2026-05-10T00:00:00Z', installedBy: 'test',
  }));
  const prev = process.env.ROBIN_HOME;
  delete process.env.ROBIN_HOME;
  try {
    assert.throws(
      () => resolveHomeStrict({ pointerPath }),
      /recorded in \.robin-home is missing.*--relocate/s,
    );
  } finally {
    if (prev) process.env.ROBIN_HOME = prev;
    rmSync(pkg, { recursive: true, force: true });
  }
});

test('strict resolver: pointer with unknown version throws', () => {
  const home = mkdtempSync(join(tmpdir(), 'robin-home-'));
  const pkg = mkdtempSync(join(tmpdir(), 'robin-pkg-'));
  const pointerPath = join(pkg, '.robin-home');
  fsWriteSync(pointerPath, JSON.stringify({ version: 999, home, installedAt: '', installedBy: '' }));
  const prev = process.env.ROBIN_HOME;
  delete process.env.ROBIN_HOME;
  try {
    assert.throws(
      () => resolveHomeStrict({ pointerPath }),
      /\.robin-home version 999 is not supported/,
    );
  } finally {
    if (prev) process.env.ROBIN_HOME = prev;
    rmSync(home, { recursive: true, force: true });
    rmSync(pkg, { recursive: true, force: true });
  }
});

// ── Task 1.5: no-fs.rename invariant ─────────────────────────────────────────

test('data-store.js never calls fs.rename — move uses copy+verify+delete', () => {
  const src = readFileSync(
    fileURLToPath(new URL('../../src/runtime/data-store.js', import.meta.url)),
    'utf8',
  );
  // Allowed single-file atomic replaces (tmp→final):
  //   1. writePointer   (pointer file)
  //   2. writeManifestAtomic (host-integrations.json)
  // Directory moves must use copy+verify+delete, never rename.
  const renameCalls = (src.match(/\brename(Sync)?\s*\(/g) ?? []).length;
  assert.strictEqual(
    renameCalls,
    2,
    `expected exactly 2 renameSync calls (writePointer + writeManifestAtomic); found ${renameCalls}`,
  );
});
