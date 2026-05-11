import assert from 'node:assert/strict';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

let tmpHome;
test.beforeEach(() => {
  tmpHome = join(tmpdir(), `robin-manifest-${process.pid}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(tmpHome, { recursive: true });
  mkdirSync(join(tmpHome, 'db'), { recursive: true });
  mkdirSync(join(tmpHome, 'secrets'), { recursive: true });
  process.env.ROBIN_HOME = tmpHome;
});
test.afterEach(() => {
  rmSync(tmpHome, { recursive: true, force: true });
});

test('computeManifest returns expected shape with package_version + file hashes', async () => {
  const { computeManifest } = await import(`../../runtime/install/manifest.js?cb=${Date.now()}`);
  const m = await computeManifest({ includeSupervisor: false });

  assert.ok(m.package_version, 'package_version present');
  assert.match(m.package_version, /\d+\.\d+/);
  assert.ok(typeof m.generated_at === 'string', 'generated_at is string');
  assert.match(m.generated_at, /T.*Z$/);

  assert.ok(Array.isArray(m.files), 'files is array');
  assert.ok(m.files.length > 0, 'at least one tracked file exists');
  for (const f of m.files) {
    assert.ok(typeof f.path === 'string' && f.path.length > 0, 'file.path is string');
    assert.match(f.sha256, /^[0-9a-f]{64}$/, `file.sha256 is 64-char hex (got ${f.sha256})`);
  }
  // bin/robin must be tracked — it ships with every install.
  assert.ok(
    m.files.some((f) => f.path === 'system/bin/robin'),
    'system/bin/robin tracked',
  );

  assert.ok(m.perms && typeof m.perms === 'object', 'perms object present');
  assert.ok('secrets_env_mode' in m.perms);
  assert.ok('db_dir_mode' in m.perms);

  // includeSupervisor: false → no supervisor key.
  assert.equal('supervisor' in m, false, 'supervisor omitted when includeSupervisor=false');
});

test('computeManifest reports db_dir_mode for the test home', async () => {
  const { computeManifest } = await import(`../../runtime/install/manifest.js?cb=${Date.now()}`);
  const m = await computeManifest({ includeSupervisor: false });
  // db dir was just created; mode reflects umask. Just check shape ('0xxx').
  assert.match(m.perms.db_dir_mode, /^0[0-7]{3}$/);
  // secrets/.env wasn't created → null.
  assert.equal(m.perms.secrets_env_mode, null);
});

test('writeManifest + readManifest round-trip', async () => {
  const { computeManifest, writeManifest, readManifest } = await import(
    `../../runtime/install/manifest.js?cb=${Date.now()}`
  );
  const m = await computeManifest({ includeSupervisor: false });
  await writeManifest(m);

  const read = await readManifest();
  assert.deepEqual(read, m);
  // No leftover tmp file.
  assert.equal(existsSync(join(tmpHome, 'manifest.json.tmp')), false);
  assert.equal(existsSync(join(tmpHome, 'manifest.json')), true);
});

test('readManifest returns null when file missing', async () => {
  const { readManifest } = await import(`../../runtime/install/manifest.js?cb=${Date.now()}`);
  assert.equal(await readManifest(), null);
});

test('readManifest returns null when file malformed', async () => {
  const { writeFileSync } = await import('node:fs');
  writeFileSync(join(tmpHome, 'manifest.json'), '{not json', 'utf-8');
  const { readManifest } = await import(`../../runtime/install/manifest.js?cb=${Date.now()}`);
  assert.equal(await readManifest(), null);
});
