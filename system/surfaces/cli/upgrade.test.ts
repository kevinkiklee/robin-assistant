import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openDb, closeDb } from '../../brain/memory/db.ts';
import { allMigrations, applyMigrations } from '../../brain/memory/migrations/index.ts';
import { dbFilePath } from '../../lib/paths.ts';
import { runUpgrade } from './upgrade.ts';

function fresh(): string {
  const dir = mkdtempSync(join(tmpdir(), 'robin-upg-'));
  mkdirSync(join(dir, 'state', 'db'), { recursive: true });
  const db = openDb(dbFilePath(dir));
  applyMigrations(db, allMigrations);
  closeDb(db);
  return dir;
}

test('robin upgrade: reports nothing when up-to-date', () => {
  const dir = fresh();
  process.env.ROBIN_USER_DATA_DIR = dir;
  const r = runUpgrade({ skipBackup: true });
  assert.equal(r.applied.length, 0);
  assert.equal(r.beforeVersion, r.afterVersion);
});

test('robin upgrade: dry-run does not change schema', () => {
  const dir = fresh();
  process.env.ROBIN_USER_DATA_DIR = dir;
  const r = runUpgrade({ dryRun: true });
  assert.equal(r.applied.length, 0);
});
