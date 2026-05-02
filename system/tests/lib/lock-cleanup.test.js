import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  existsSync,
  rmSync,
  utimesSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cleanupStaleLocks } from '../../scripts/jobs/lib/lock-cleanup.js';

function makeWorkspace() {
  const root = mkdtempSync(join(tmpdir(), 'robin-lc-'));
  mkdirSync(join(root, 'user-data/ops/state/jobs/locks'), { recursive: true });
  return root;
}

function writeLock(workspaceDir, name, content) {
  const p = join(workspaceDir, 'user-data/ops/state/jobs/locks', name + '.lock');
  writeFileSync(p, typeof content === 'string' ? content : JSON.stringify(content));
  return p;
}

function setMtime(path, ageMs) {
  const t = new Date(Date.now() - ageMs);
  utimesSync(path, t, t);
}

describe('cleanupStaleLocks', () => {
  test('missing locks dir is a no-op', () => {
    const root = mkdtempSync(join(tmpdir(), 'robin-lc-nodir-'));
    // Do NOT create the locks dir
    const result = cleanupStaleLocks(root);
    assert.deepEqual(result.removed, []);
    rmSync(root, { recursive: true, force: true });
  });

  test('removes lock stale by mtime', () => {
    const root = makeWorkspace();
    const lp = writeLock(root, 'old-job', { pid: process.pid, started_at: new Date().toISOString() });
    // Backdate mtime to 6 minutes ago
    setMtime(lp, 6 * 60 * 1000);
    const result = cleanupStaleLocks(root, { staleMs: 5 * 60 * 1000 });
    assert.deepEqual(result.removed, ['old-job.lock']);
    assert.equal(existsSync(lp), false, 'lock file should be removed');
    rmSync(root, { recursive: true, force: true });
  });

  test('removes lock with dead PID (fresh mtime)', () => {
    const root = makeWorkspace();
    // Use a PID that is almost certainly not running: very large number
    const deadPid = 999999999;
    writeLock(root, 'dead-job', { pid: deadPid, started_at: new Date().toISOString() });
    const result = cleanupStaleLocks(root, { staleMs: 5 * 60 * 1000 });
    assert.deepEqual(result.removed, ['dead-job.lock']);
    rmSync(root, { recursive: true, force: true });
  });

  test('keeps lock held by live PID with fresh mtime', () => {
    const root = makeWorkspace();
    // current process is definitely alive
    const lp = writeLock(root, 'live-job', { pid: process.pid, started_at: new Date().toISOString() });
    const result = cleanupStaleLocks(root, { staleMs: 5 * 60 * 1000 });
    assert.deepEqual(result.removed, [], 'live lock should NOT be removed');
    assert.equal(existsSync(lp), true, 'lock file should still exist');
    rmSync(root, { recursive: true, force: true });
  });

  test('removes corrupt / unreadable lock', () => {
    const root = makeWorkspace();
    // Write invalid JSON — readLock returns null
    writeLock(root, 'corrupt', 'NOT JSON {{{');
    const result = cleanupStaleLocks(root, { staleMs: 5 * 60 * 1000 });
    assert.deepEqual(result.removed, ['corrupt.lock']);
    rmSync(root, { recursive: true, force: true });
  });

  test('ignores non-.lock files in locks dir', () => {
    const root = makeWorkspace();
    writeFileSync(join(root, 'user-data/ops/state/jobs/locks', 'README.txt'), 'ignored');
    const result = cleanupStaleLocks(root, { staleMs: 5 * 60 * 1000 });
    assert.deepEqual(result.removed, []);
    rmSync(root, { recursive: true, force: true });
  });

  test('returns all removed lock names when multiple are stale', () => {
    const root = makeWorkspace();
    const lp1 = writeLock(root, 'a', { pid: process.pid, started_at: new Date().toISOString() });
    const lp2 = writeLock(root, 'b', { pid: process.pid, started_at: new Date().toISOString() });
    writeLock(root, 'c', { pid: process.pid, started_at: new Date().toISOString() });
    setMtime(lp1, 6 * 60 * 1000);
    setMtime(lp2, 6 * 60 * 1000);
    // c is fresh — should be kept
    const result = cleanupStaleLocks(root, { staleMs: 5 * 60 * 1000 });
    assert.deepEqual([...result.removed].sort(), ['a.lock', 'b.lock']);
    rmSync(root, { recursive: true, force: true });
  });
});
