import assert from 'node:assert/strict';
import { mkdirSync as __robinMkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir as __robinTmpdir, tmpdir } from 'node:os';
import { join as __robinJoin, join } from 'node:path';
import { test } from 'node:test';
import { close, connect } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { writeConfig as __robinWriteConfig } from '../../src/runtime/config.js';

// __robin_test_home_setup__
const __robinTestHome = __robinJoin(
  __robinTmpdir(),
  `robin-test-${process.pid}-${Math.random().toString(36).slice(2)}`,
);
__robinMkdirSync(__robinTestHome, { recursive: true });
process.env.ROBIN_HOME = __robinTestHome;
await __robinWriteConfig({ embedder_profile: 'mxbai-1024' });

function setupMigrationsDir(files) {
  const dir = mkdtempSync(join(tmpdir(), 'robin-mig-'));
  for (const [name, sql] of Object.entries(files)) {
    writeFileSync(join(dir, name), sql);
  }
  return dir;
}

test('runs a single migration on a fresh db (bootstrap path: no _migrations table)', async () => {
  const dir = setupMigrationsDir({
    '0001-init.surql': `
      DEFINE TABLE _migrations SCHEMAFULL TYPE NORMAL;
      DEFINE FIELD version  ON _migrations TYPE int;
      DEFINE FIELD name     ON _migrations TYPE string;
      DEFINE FIELD checksum ON _migrations TYPE string;
      DEFINE FIELD applied_at ON _migrations TYPE datetime DEFAULT time::now() READONLY;
      DEFINE INDEX _migrations_version ON _migrations FIELDS version UNIQUE;
      DEFINE TABLE thing SCHEMAFULL TYPE NORMAL;
      DEFINE FIELD name ON thing TYPE string;
    `,
  });
  const db = await connect({ engine: 'mem://' });
  const applied = await runMigrations(db, dir);
  assert.deepEqual(applied, [1]);
  // Re-run is a no-op
  const applied2 = await runMigrations(db, dir);
  assert.deepEqual(applied2, []);
  rmSync(dir, { recursive: true });
  await close(db);
});

test('checksum mismatch on already-applied migration errors', async () => {
  const dir = setupMigrationsDir({
    '0001-init.surql': `
      DEFINE TABLE _migrations SCHEMAFULL TYPE NORMAL;
      DEFINE FIELD version    ON _migrations TYPE int;
      DEFINE FIELD name       ON _migrations TYPE string;
      DEFINE FIELD checksum   ON _migrations TYPE string;
      DEFINE FIELD applied_at ON _migrations TYPE datetime DEFAULT time::now() READONLY;
      DEFINE INDEX _migrations_version ON _migrations FIELDS version UNIQUE;
    `,
  });
  const db = await connect({ engine: 'mem://' });
  await runMigrations(db, dir);
  // Mutate the file so the checksum no longer matches
  writeFileSync(join(dir, '0001-init.surql'), `-- changed\n${'SELECT 1;'}`);
  await assert.rejects(runMigrations(db, dir), /checksum mismatch/);
  rmSync(dir, { recursive: true });
  await close(db);
});

test('applies multiple migrations in version order', async () => {
  const dir = setupMigrationsDir({
    '0001-init.surql': `
      DEFINE TABLE _migrations SCHEMAFULL TYPE NORMAL;
      DEFINE FIELD version    ON _migrations TYPE int;
      DEFINE FIELD name       ON _migrations TYPE string;
      DEFINE FIELD checksum   ON _migrations TYPE string;
      DEFINE FIELD applied_at ON _migrations TYPE datetime DEFAULT time::now() READONLY;
      DEFINE INDEX _migrations_version ON _migrations FIELDS version UNIQUE;
      DEFINE TABLE a SCHEMAFULL TYPE NORMAL;
    `,
    '0002-add-b.surql': 'DEFINE TABLE b SCHEMAFULL TYPE NORMAL;',
  });
  const db = await connect({ engine: 'mem://' });
  const applied = await runMigrations(db, dir);
  assert.deepEqual(applied, [1, 2]);
  rmSync(dir, { recursive: true });
  await close(db);
});

test('errors on file with no leading version digits', async () => {
  const dir = setupMigrationsDir({ 'init.surql': '-- nope' });
  const db = await connect({ engine: 'mem://' });
  await assert.rejects(runMigrations(db, dir), /version/);
  rmSync(dir, { recursive: true });
  await close(db);
});
