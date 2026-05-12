import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  acquireDaemonLock,
  isDaemonProcess,
  isPidAlive,
  releaseDaemonLock,
} from '../../runtime/daemon/lock.js';

// Stubs for the pluggable daemon-identity check. Production callers use the
// real `isDaemonProcess` (which sniffs the process's command line via `ps`);
// tests inject synchronous results to express intent directly.
const alwaysDaemon = () => true;
const neverDaemon = () => false;

test('acquireDaemonLock writes pid; release deletes file', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'robin-daemon-lock-'));
  const path = join(tmp, '.daemon.lock');
  await acquireDaemonLock(path);
  await releaseDaemonLock(path);
  rmSync(tmp, { recursive: true });
});

test('acquireDaemonLock fails when locked by live PID that IS the daemon', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'robin-daemon-lock2-'));
  const path = join(tmp, '.daemon.lock');
  writeFileSync(path, String(process.pid));
  await assert.rejects(
    acquireDaemonLock(path, { isDaemonProcess: alwaysDaemon }),
    /already running/i,
  );
  rmSync(tmp, { recursive: true });
});

test('acquireDaemonLock reclaims when locked by live PID that is NOT the daemon', async () => {
  // PID reuse hazard: an old daemon's PID gets recycled to an unrelated
  // process (a biographer flush, a shell, anything). Without an identity
  // check, that recycled PID looks alive and the new daemon refuses to
  // start. With the check, we recognise it isn't a daemon and reclaim.
  const tmp = mkdtempSync(join(tmpdir(), 'robin-daemon-lock-reuse-'));
  const path = join(tmp, '.daemon.lock');
  writeFileSync(path, String(process.pid));
  await acquireDaemonLock(path, { isDaemonProcess: neverDaemon });
  await releaseDaemonLock(path);
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

test('isDaemonProcess returns false for the test runner itself', () => {
  // The unit-test runner is a `node --test` process; its command line
  // doesn't contain the daemon's marker strings, so the identity check
  // must return false. This pins the contract that prevented the PID-
  // reuse hazard from blocking daemon startup.
  assert.equal(isDaemonProcess(process.pid), false);
});

test('isDaemonProcess returns false for a clearly-dead PID', () => {
  assert.equal(isDaemonProcess(999999), false);
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
  // Concurrency contract: with the wx-based atomic create, exactly one
  // caller wins the file. The loser sees EEXIST, reads the winner's pid,
  // and — because we stub the identity check to "yes, this is the daemon"
  // — rejects with EALREADY. (Without the stub, both callers would
  // observe the test runner's pid, conclude "not a daemon, reclaim," and
  // unlink the winner's file — exactly the PID-reuse hazard the new
  // contract is designed to handle, but not what this test is pinning.)
  const opts = { isDaemonProcess: alwaysDaemon };
  const results = await Promise.allSettled([
    acquireDaemonLock(path, opts),
    acquireDaemonLock(path, opts),
  ]);
  const fulfilled = results.filter((r) => r.status === 'fulfilled').length;
  const rejected = results.filter((r) => r.status === 'rejected').length;
  assert.equal(
    fulfilled,
    1,
    `expected exactly one acquire to fulfill, got ${fulfilled}/${rejected}`,
  );
  await releaseDaemonLock(path);
  rmSync(tmp, { recursive: true });
});
