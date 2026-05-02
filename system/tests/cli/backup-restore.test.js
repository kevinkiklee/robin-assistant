import { test } from 'node:test';
import assert from 'node:assert/strict';
import { backup } from '../../scripts/cli/backup.js';
import { restore } from '../../scripts/cli/restore.js';
import {
  mkdtempSync, writeFileSync, mkdirSync, readdirSync, rmSync,
  readFileSync, statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function makeRepo() {
  const root = mkdtempSync(join(tmpdir(), 'robin-bk-'));
  mkdirSync(join(root, 'user-data/memory'), { recursive: true });
  mkdirSync(join(root, 'user-data/runtime/config'), { recursive: true });
  writeFileSync(join(root, 'user-data/memory/profile.md'), '# Test profile\n');
  writeFileSync(join(root, 'user-data/runtime/config/robin.config.json'), '{"version":"3.0.0"}');
  return root;
}

function readUserData(root) {
  const ud = join(root, 'user-data');
  const out = {};
  for (const entry of readdirSync(ud)) {
    if (statSync(join(ud, entry)).isFile()) out[entry] = readFileSync(join(ud, entry), 'utf-8');
  }
  return out;
}

test('backup writes a tar.gz under user-data/backup/', async () => {
  const root = makeRepo();
  await backup(root);
  const archives = readdirSync(join(root, 'user-data/backup')).filter(f => f.endsWith('.tar.gz'));
  assert.equal(archives.length, 1);
  assert.match(archives[0], /^user-data-.*\.tar\.gz$/);
  rmSync(root, { recursive: true, force: true });
});

test('restore: backup → wipe → restore returns identical content (preserves backup/)', async () => {
  const root = makeRepo();
  const before = readUserData(root);
  await backup(root);
  // Simulate user damage: delete some live state but keep user-data/backup/.
  rmSync(join(root, 'user-data/memory'), { recursive: true, force: true });
  rmSync(join(root, 'user-data/runtime'), { recursive: true, force: true });
  await restore(root, { auto: true }); // auto-pick most recent
  const after = readUserData(root);
  assert.deepEqual(after, before);
  // Backup archive must still be present after restore.
  const archives = readdirSync(join(root, 'user-data/backup')).filter(f => f.endsWith('.tar.gz'));
  assert.equal(archives.length, 1, 'backup archive should survive restore');
  rmSync(root, { recursive: true, force: true });
});
