import { test } from 'node:test';
import assert from 'node:assert/strict';
import { backup } from '../core/scripts/backup.js';
import { mkdtempSync, writeFileSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function makeRepo() {
  const root = mkdtempSync(join(tmpdir(), 'robin-bk-'));
  mkdirSync(join(root, 'user-data'));
  writeFileSync(join(root, 'user-data/profile.md'), '# Test profile\n');
  writeFileSync(join(root, 'user-data/robin.config.json'), '{"version":"3.0.0"}');
  return root;
}

test('backup writes a tar.gz under backup/', async () => {
  const root = makeRepo();
  await backup(root);
  const archives = readdirSync(join(root, 'backup')).filter(f => f.endsWith('.tar.gz'));
  assert.equal(archives.length, 1);
  assert.match(archives[0], /^user-data-.*\.tar\.gz$/);
  rmSync(root, { recursive: true, force: true });
});
