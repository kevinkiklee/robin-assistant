import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { snapshot } from '../../data/db/backup.js';

test('snapshot writes a tar archive named with a timestamp', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'robin-backup-'));
  const dbDir = join(tmp, 'db');
  const backupDir = join(tmp, 'backup');
  mkdirSync(dbDir);
  mkdirSync(backupDir);
  writeFileSync(join(dbDir, 'file.dat'), 'hello');

  const archive = await snapshot(dbDir, backupDir);

  const files = readdirSync(backupDir);
  assert.equal(files.length, 1);
  assert.match(files[0], /^\d{8}-\d{6}\.tar$/);
  assert.equal(archive, join(backupDir, files[0]));
  rmSync(tmp, { recursive: true });
});

test('snapshot is a no-op when source is missing or empty', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'robin-backup2-'));
  const dbDir = join(tmp, 'db');
  const backupDir = join(tmp, 'backup');
  mkdirSync(dbDir);
  mkdirSync(backupDir);
  const archive = await snapshot(dbDir, backupDir);
  assert.equal(archive, null);
  assert.equal(readdirSync(backupDir).length, 0);
  rmSync(tmp, { recursive: true });
});
