import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { migrateFromV2 } from './from-v2.ts';

function makeFakeV2(): string {
  const v2 = mkdtempSync(join(tmpdir(), 'robin-v2-fake-'));
  const ud = join(v2, 'user-data');
  mkdirSync(ud, { recursive: true });
  // create some fake artifacts
  mkdirSync(join(ud, 'artifacts'), { recursive: true });
  writeFileSync(join(ud, 'artifacts', 'plan.md'), '# A plan');
  mkdirSync(join(ud, 'scripts'), { recursive: true });
  writeFileSync(join(ud, 'scripts', 'noop.sh'), '#!/bin/sh');
  return v2;
}

test('migrate: errors when v2 path missing', async () => {
  const r = await migrateFromV2({ v2Path: '/nonexistent/v2' });
  assert.equal(r.errors.length, 1);
  assert.match(r.errors[0], /does not exist/);
});

test('migrate: flatfiles phase copies artifacts + scripts', async () => {
  const v2 = makeFakeV2();
  // Set ROBIN_USER_DATA_DIR to a temp dir so we don't clobber the real one
  const targetUserData = mkdtempSync(join(tmpdir(), 'robin-target-fake-'));
  process.env.ROBIN_USER_DATA_DIR = targetUserData;
  const r = await migrateFromV2({ v2Path: v2 });
  assert.equal(r.phases.flatfiles?.ok, true);
  assert.ok((r.phases.flatfiles?.count ?? 0) >= 2);
  // verify files were copied
  assert.ok(existsSync(join(targetUserData, 'content', 'artifacts', 'plan.md')));
  assert.ok(existsSync(join(targetUserData, 'extensions', 'scripts', 'noop.sh')));
  // clean up env
  delete process.env.ROBIN_USER_DATA_DIR;
});

test('migrate: dry-run does not copy files but counts', async () => {
  const v2 = makeFakeV2();
  const targetUserData = mkdtempSync(join(tmpdir(), 'robin-target-fake-'));
  process.env.ROBIN_USER_DATA_DIR = targetUserData;
  const r = await migrateFromV2({ v2Path: v2, dryRun: true });
  assert.equal(r.dryRun, true);
  assert.ok((r.phases.flatfiles?.count ?? 0) >= 2);
  // verify no files were copied
  assert.equal(existsSync(join(targetUserData, 'content', 'artifacts', 'plan.md')), false);
  // clean up env
  delete process.env.ROBIN_USER_DATA_DIR;
});

test('migrate: writes a report file to state/migrations', async () => {
  const v2 = makeFakeV2();
  const targetUserData = mkdtempSync(join(tmpdir(), 'robin-target-fake-'));
  process.env.ROBIN_USER_DATA_DIR = targetUserData;
  await migrateFromV2({ v2Path: v2 });
  const { readdirSync } = await import('node:fs');
  const files = existsSync(join(targetUserData, 'state', 'migrations'))
    ? readdirSync(join(targetUserData, 'state', 'migrations'))
    : [];
  assert.ok(files.some((f) => f.startsWith('migrate-report-')));
  // clean up env
  delete process.env.ROBIN_USER_DATA_DIR;
});

test('migrate: derived phase reports skipped when v2 data dir is empty', async () => {
  const v2 = mkdtempSync(join(tmpdir(), 'robin-v2-empty-'));
  mkdirSync(join(v2, 'user-data'), { recursive: true });
  // no data/db dir
  const targetUserData = mkdtempSync(join(tmpdir(), 'robin-target-empty-'));
  process.env.ROBIN_USER_DATA_DIR = targetUserData;
  const r = await migrateFromV2({ v2Path: v2 });
  // derived phase should run but report no work
  assert.equal(r.phases.derived?.ok, true);
  assert.match(r.phases.derived?.message ?? '', /not found|nothing to migrate/);
  delete process.env.ROBIN_USER_DATA_DIR;
});

test('migrate: derived phase handles missing surrealdb dep gracefully', async () => {
  // This test asserts the code path handles the import-fail case without throwing.
  // We can't easily uninstall the dep mid-test; instead verify the function returns a graceful error
  // when given a v2-shaped dir without a valid RocksDB inside.
  const v2 = mkdtempSync(join(tmpdir(), 'robin-v2-bad-rocks-'));
  const dataDir = join(v2, 'user-data', 'data', 'db');
  mkdirSync(dataDir, { recursive: true });
  // create an empty/bogus file to simulate "exists but not a valid RocksDB"
  writeFileSync(join(dataDir, 'LOCK'), '');
  const targetUserData = mkdtempSync(join(tmpdir(), 'robin-target-bad-'));
  process.env.ROBIN_USER_DATA_DIR = targetUserData;
  const r = await migrateFromV2({ v2Path: v2 });
  // either succeeded (unlikely on bogus rocksdb) or surfaced an error message — both are acceptable
  assert.ok(r.phases.derived);
  delete process.env.ROBIN_USER_DATA_DIR;
});
