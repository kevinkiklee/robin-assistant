import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { updateIndex } from '../../scripts/sync/lib/index-updater.js';

function setupWorkspace() {
  const ws = mkdtempSync(join(tmpdir(), 'idx-'));
  mkdirSync(join(ws, 'user-data/memory/knowledge'), { recursive: true });
  writeFileSync(
    join(ws, 'user-data/memory/knowledge/foo.md'),
    '---\ndescription: Foo entry\n---\n\nbody\n'
  );
  return ws;
}

test('updateIndex regenerates user-data/memory/INDEX.md', async () => {
  const ws = setupWorkspace();
  await updateIndex(ws);
  const idx = readFileSync(join(ws, 'user-data/memory/INDEX.md'), 'utf-8');
  assert.match(idx, /knowledge\/foo\.md \| Foo entry/);
  rmSync(ws, { recursive: true });
});

test('updateIndex acquires the lock and releases on success', async () => {
  const ws = setupWorkspace();
  await updateIndex(ws);
  assert.ok(!existsSync(join(ws, 'user-data/state/locks/index.lock')));
  rmSync(ws, { recursive: true });
});

test('updateIndex skips cleanly when lock is already held by a live PID', async () => {
  const ws = setupWorkspace();
  mkdirSync(join(ws, 'user-data/state/locks'), { recursive: true });
  writeFileSync(join(ws, 'user-data/state/locks/index.lock'), `${process.pid}`);
  const result = await updateIndex(ws, { skipIfLocked: true });
  assert.equal(result, 'skipped');
  const owner = readFileSync(join(ws, 'user-data/state/locks/index.lock'), 'utf-8');
  assert.equal(owner, `${process.pid}`);
  rmSync(ws, { recursive: true });
});

test('updateIndex steals a stale lock (PID not running)', async () => {
  const ws = setupWorkspace();
  mkdirSync(join(ws, 'user-data/state/locks'), { recursive: true });
  writeFileSync(join(ws, 'user-data/state/locks/index.lock'), '999999');
  const result = await updateIndex(ws);
  assert.equal(result, 'updated');
  rmSync(ws, { recursive: true });
});
