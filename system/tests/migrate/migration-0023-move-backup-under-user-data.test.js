import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { up, down, id, description } from '../../migrations/0023-move-backup-under-user-data.js';

function workspace() {
  const dir = mkdtempSync(join(tmpdir(), 'mig0023-'));
  mkdirSync(join(dir, 'user-data'), { recursive: true });
  return dir;
}

test('migration metadata', () => {
  assert.equal(id, '0023-move-backup-under-user-data');
  assert.match(description, /backup/);
});

test('up moves backup/ entries → user-data/backup/', async () => {
  const ws = workspace();
  mkdirSync(join(ws, 'backup/2026-04-29-pre-prune'), { recursive: true });
  writeFileSync(join(ws, 'backup/snapshot-a.tar.gz'), 'archive-a');
  writeFileSync(join(ws, 'backup/snapshot-b.tar.gz'), 'archive-b');

  await up({ workspaceDir: ws });

  assert.ok(!existsSync(join(ws, 'backup')), 'backup/ should be gone');
  assert.ok(existsSync(join(ws, 'user-data/backup/2026-04-29-pre-prune')));
  assert.equal(
    readFileSync(join(ws, 'user-data/backup/snapshot-a.tar.gz'), 'utf8'),
    'archive-a',
  );
  assert.equal(
    readFileSync(join(ws, 'user-data/backup/snapshot-b.tar.gz'), 'utf8'),
    'archive-b',
  );
});

test('up is idempotent — no-op when backup/ does not exist', async () => {
  const ws = workspace();
  mkdirSync(join(ws, 'user-data/backup'), { recursive: true });
  writeFileSync(join(ws, 'user-data/backup/already.tar.gz'), 'already');

  await up({ workspaceDir: ws });

  assert.ok(!existsSync(join(ws, 'backup')));
  assert.equal(
    readFileSync(join(ws, 'user-data/backup/already.tar.gz'), 'utf8'),
    'already',
  );
});

test('up merges into existing user-data/backup/ (apply runner makes a tarball there before this migration runs)', async () => {
  const ws = workspace();
  mkdirSync(join(ws, 'backup'), { recursive: true });
  writeFileSync(join(ws, 'backup/old.tar.gz'), 'old');
  // Simulate the apply runner having just written the pre-migration tarball
  // at the new location before this migration runs:
  mkdirSync(join(ws, 'user-data/backup'), { recursive: true });
  writeFileSync(join(ws, 'user-data/backup/pre-migration-now.tar.gz'), 'pre-mig');

  await up({ workspaceDir: ws });

  assert.ok(!existsSync(join(ws, 'backup')));
  const entries = readdirSync(join(ws, 'user-data/backup')).sort();
  assert.deepEqual(entries, ['old.tar.gz', 'pre-migration-now.tar.gz']);
});

test('up refuses when same-named entry already exists in user-data/backup/', async () => {
  const ws = workspace();
  mkdirSync(join(ws, 'backup'), { recursive: true });
  writeFileSync(join(ws, 'backup/dupe.tar.gz'), 'src');
  mkdirSync(join(ws, 'user-data/backup'), { recursive: true });
  writeFileSync(join(ws, 'user-data/backup/dupe.tar.gz'), 'dst');

  await assert.rejects(() => up({ workspaceDir: ws }), /already exists/);
});

test('down reverses the move', async () => {
  const ws = workspace();
  mkdirSync(join(ws, 'user-data/backup'), { recursive: true });
  writeFileSync(join(ws, 'user-data/backup/snap.tar.gz'), 'snap');

  await down({ workspaceDir: ws });

  assert.ok(!existsSync(join(ws, 'user-data/backup')));
  assert.equal(readFileSync(join(ws, 'backup/snap.tar.gz'), 'utf8'), 'snap');
});

test('down is idempotent — no-op when user-data/backup/ does not exist', async () => {
  const ws = workspace();

  await down({ workspaceDir: ws });

  assert.ok(!existsSync(join(ws, 'backup')));
});
