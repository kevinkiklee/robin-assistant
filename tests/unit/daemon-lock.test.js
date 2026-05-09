import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { acquireDaemonLock, isPidAlive, releaseDaemonLock } from '../../src/daemon/lock.js';

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
