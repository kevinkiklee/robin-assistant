import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
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
  const v3UserData = mkdtempSync(join(tmpdir(), 'robin-v3-fake-'));
  process.env.ROBIN_USER_DATA_DIR = v3UserData;
  const r = await migrateFromV2({ v2Path: v2 });
  assert.equal(r.phases.flatfiles?.ok, true);
  assert.ok((r.phases.flatfiles?.count ?? 0) >= 2);
  // verify files were copied
  assert.ok(existsSync(join(v3UserData, 'content', 'artifacts', 'plan.md')));
  assert.ok(existsSync(join(v3UserData, 'extensions', 'scripts', 'noop.sh')));
  // clean up env
  delete process.env.ROBIN_USER_DATA_DIR;
});

test('migrate: dry-run does not copy files but counts', async () => {
  const v2 = makeFakeV2();
  const v3UserData = mkdtempSync(join(tmpdir(), 'robin-v3-fake-'));
  process.env.ROBIN_USER_DATA_DIR = v3UserData;
  const r = await migrateFromV2({ v2Path: v2, dryRun: true });
  assert.equal(r.dryRun, true);
  assert.ok((r.phases.flatfiles?.count ?? 0) >= 2);
  // verify no files were copied
  assert.equal(existsSync(join(v3UserData, 'content', 'artifacts', 'plan.md')), false);
  // clean up env
  delete process.env.ROBIN_USER_DATA_DIR;
});

test('migrate: writes a report file to state/migrations', async () => {
  const v2 = makeFakeV2();
  const v3UserData = mkdtempSync(join(tmpdir(), 'robin-v3-fake-'));
  process.env.ROBIN_USER_DATA_DIR = v3UserData;
  await migrateFromV2({ v2Path: v2 });
  const { readdirSync } = await import('node:fs');
  const files = existsSync(join(v3UserData, 'state', 'migrations'))
    ? readdirSync(join(v3UserData, 'state', 'migrations'))
    : [];
  assert.ok(files.some((f) => f.startsWith('migrate-report-')));
  // clean up env
  delete process.env.ROBIN_USER_DATA_DIR;
});
