import assert from 'node:assert';
import { mkdirSync, mkdtempSync, readdirSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { snapshot } from '../../data/db/backup.js';

function makeTar(dir, name, mtimeSec) {
  const path = join(dir, name);
  writeFileSync(path, 'fake tar');
  utimesSync(path, mtimeSec, mtimeSec);
}

test('snapshot prunes >30d backups before writing new one', async () => {
  const root = mkdtempSync(join(tmpdir(), 'robin-backup-prune-'));
  const src = join(root, 'src');
  const backup = join(root, 'backup');
  mkdirSync(src);
  mkdirSync(backup);
  writeFileSync(join(src, 'data.sst'), 'data');

  const now = Date.now() / 1000;
  makeTar(backup, 'old.tar', now - 31 * 86400);
  makeTar(backup, 'recent.tar', now - 5 * 86400);
  makeTar(backup, 'note.txt', now - 60 * 86400);

  await snapshot(src, backup);

  const remaining = readdirSync(backup).sort();
  assert.ok(!remaining.includes('old.tar'), 'expected old.tar pruned');
  assert.ok(remaining.includes('recent.tar'), 'expected recent.tar preserved');
  assert.ok(remaining.includes('note.txt'), 'expected non-tar preserved');
});

test('ROBIN_BACKUP_RETENTION_DAYS=0 disables pruning', async () => {
  const root = mkdtempSync(join(tmpdir(), 'robin-backup-prune-disabled-'));
  const src = join(root, 'src');
  const backup = join(root, 'backup');
  mkdirSync(src);
  mkdirSync(backup);
  writeFileSync(join(src, 'data.sst'), 'data');

  const now = Date.now() / 1000;
  makeTar(backup, 'ancient.tar', now - 365 * 86400);

  const orig = process.env.ROBIN_BACKUP_RETENTION_DAYS;
  process.env.ROBIN_BACKUP_RETENTION_DAYS = '0';
  try {
    await snapshot(src, backup);
  } finally {
    if (orig === undefined) process.env.ROBIN_BACKUP_RETENTION_DAYS = undefined;
    else process.env.ROBIN_BACKUP_RETENTION_DAYS = orig;
  }

  const remaining = readdirSync(backup);
  assert.ok(remaining.includes('ancient.tar'));
});
