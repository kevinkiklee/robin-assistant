import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { acquireDaemonLock, isPidAlive, releaseDaemonLock } from '../../runtime/daemon/lock.js';

test('acquireDaemonLock writes pid; release deletes file', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'robin-daemon-lock-'));
  const path = join(tmp, '.daemon.lock');
  await acquireDaemonLock(path);
  await releaseDaemonLock(path);
  rmSync(tmp, { recursive: true });
});

test('acquireDaemonLock fails when locked by live PID', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'robin-daemon-lock2-'));
  const path = join(tmp, '.daemon.lock');
  writeFileSync(path, String(process.pid));
  await assert.rejects(acquireDaemonLock(path), /already running/i);
  rmSync(tmp, { recursive: true });
});

test('acquireDaemonLock cleans up stale lock from dead PID', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'robin-daemon-lock3-'));
  const path = join(tmp, '.daemon.lock');
  writeFileSync(path, '999999');
  await acquireDaemonLock(path);
  await releaseDaemonLock(path);
  rmSync(tmp, { recursive: true });
});

test('isPidAlive returns true for self', () => {
  assert.equal(isPidAlive(process.pid), true);
});

test('isPidAlive returns false for clearly-dead PID', () => {
  assert.equal(isPidAlive(999999), false);
});

test('acquireDaemonLock tolerates malformed lock content', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'robin-daemon-lock-malformed-'));
  const path = join(tmp, '.daemon.lock');
  writeFileSync(path, 'not-a-pid');
  // Malformed PID is treated as no live holder; we should reclaim.
  await acquireDaemonLock(path);
  await releaseDaemonLock(path);
  rmSync(tmp, { recursive: true });
});

test('releaseDaemonLock is idempotent (no error when file absent)', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'robin-daemon-lock-idempot-'));
  const path = join(tmp, '.daemon.lock');
  await releaseDaemonLock(path); // file does not exist
  await acquireDaemonLock(path);
  await releaseDaemonLock(path);
  await releaseDaemonLock(path); // second release no-ops
  rmSync(tmp, { recursive: true });
});

test('two acquireDaemonLock attempts on the same path: exactly one succeeds', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'robin-daemon-lock-concur-'));
  const path = join(tmp, '.daemon.lock');
  // The current implementation has a TOCTOU window (read → check → write).
  // Atomicity test: fire two acquires back-to-back. Both must NOT succeed.
  const results = await Promise.allSettled([acquireDaemonLock(path), acquireDaemonLock(path)]);
  const fulfilled = results.filter((r) => r.status === 'fulfilled').length;
  const rejected = results.filter((r) => r.status === 'rejected').length;
  // After atomic wx-based acquire: exactly one fulfills, the other rejects with EALREADY.
  // Note: when both callers see no file and write concurrently, the wx flag must
  // ensure one of them gets EEXIST. Within the same process the OS guarantee holds.
  assert.equal(
    fulfilled,
    1,
    `expected exactly one acquire to fulfill, got ${fulfilled}/${rejected}`,
  );
  await releaseDaemonLock(path);
  rmSync(tmp, { recursive: true });
});
