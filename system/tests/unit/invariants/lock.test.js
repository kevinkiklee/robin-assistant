import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { test } from 'node:test';
import { acquire, isLockStale, lockPath, withLock } from '../../../runtime/invariants/lock.js';
import { withTempStateFile } from '../../helpers/invariant-fixtures.js';

test('acquire returns handle when no lock exists', () =>
  withTempStateFile(({ lockDir }) => {
    const handle = acquire(lockDir, 'foo');
    assert.ok(handle, 'expected handle');
    assert.ok(existsSync(lockPath(lockDir, 'foo')));
    handle.release();
    assert.equal(existsSync(lockPath(lockDir, 'foo')), false);
  }));

test('acquire returns null when fresh lock held by different pid', () =>
  withTempStateFile(({ lockDir }) => {
    const ts = 1000;
    const first = acquire(lockDir, 'foo', { now: () => ts, pid: 1 });
    assert.ok(first);
    const second = acquire(lockDir, 'foo', { now: () => ts + 1000, pid: 2 });
    assert.equal(second, null);
    first.release();
  }));

test('acquire reclaims stale lock', () =>
  withTempStateFile(({ lockDir }) => {
    const t0 = 1000;
    const first = acquire(lockDir, 'foo', { now: () => t0, pid: 999 });
    assert.ok(first);
    // 60s later, the original lock is stale (>30s heartbeat)
    const second = acquire(lockDir, 'foo', { now: () => t0 + 60_000, pid: 1 });
    assert.ok(second, 'expected to reclaim');
    second.release();
  }));

test('isLockStale: null payload is stale', () => {
  assert.equal(isLockStale(null), true);
});

test('isLockStale: fresh heartbeat is not stale', () => {
  assert.equal(isLockStale({ heartbeat_at: 1000 }, 5000), false);
});

test('isLockStale: heartbeat older than 30s is stale', () => {
  assert.equal(isLockStale({ heartbeat_at: 1000 }, 35_000), true);
});

test('withLock executes fn and releases lock', () =>
  withTempStateFile(async ({ lockDir }) => {
    const r = await withLock(lockDir, 'foo', async () => ({ repaired: true, action: 'ok' }));
    assert.equal(r.acquired, true);
    assert.equal(r.result.repaired, true);
    assert.equal(existsSync(lockPath(lockDir, 'foo')), false, 'lock file removed');
  }));

test('withLock returns acquired:false when contended', () =>
  withTempStateFile(async ({ lockDir }) => {
    const handle = acquire(lockDir, 'foo');
    const r = await withLock(lockDir, 'foo', async () => ({ repaired: true }));
    assert.equal(r.acquired, false);
    handle.release();
  }));
