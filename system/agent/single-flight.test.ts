import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { acquire, release } from './single-flight.ts';

function freshLockPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'robin-sf-'));
  return join(dir, 'nested', 'agent-runner.lock');
}

test('single-flight: fresh acquire succeeds + writes pid/ts', () => {
  const lock = freshLockPath();
  const ok = acquire(lock, { staleMs: 60_000, now: () => 1000, pid: 4242 });
  assert.equal(ok, true);
  assert.ok(existsSync(lock), 'lockfile should exist after acquire');
  const body = JSON.parse(readFileSync(lock, 'utf8'));
  assert.equal(body.pid, 4242);
  assert.equal(body.ts, 1000);
});

test('single-flight: second acquire of a fresh lock is skipped', () => {
  const lock = freshLockPath();
  let t = 1000;
  assert.equal(acquire(lock, { staleMs: 60_000, now: () => t, pid: 1 }), true);
  // 30s later — still well within the 60s stale window.
  t = 31_000;
  assert.equal(acquire(lock, { staleMs: 60_000, now: () => t, pid: 2 }), false);
  // The original holder's pid is untouched.
  assert.equal(JSON.parse(readFileSync(lock, 'utf8')).pid, 1);
});

test('single-flight: a stale lock is stolen', () => {
  const lock = freshLockPath();
  assert.equal(acquire(lock, { staleMs: 60_000, now: () => 1000, pid: 1 }), true);
  // Far past the stale window — the holder is presumed dead.
  assert.equal(acquire(lock, { staleMs: 60_000, now: () => 1000 + 120_000, pid: 99 }), true);
  const body = JSON.parse(readFileSync(lock, 'utf8'));
  assert.equal(body.pid, 99, 'stolen lock should record the new holder');
  assert.equal(body.ts, 1000 + 120_000);
});

test('single-flight: release removes the lock and re-acquire succeeds', () => {
  const lock = freshLockPath();
  assert.equal(acquire(lock, { staleMs: 60_000, now: () => 1000, pid: 1 }), true);
  release(lock);
  assert.equal(existsSync(lock), false);
  // A fresh acquire after release works even within the stale window.
  assert.equal(acquire(lock, { staleMs: 60_000, now: () => 2000, pid: 2 }), true);
});

test('single-flight: release of a missing lock is a no-op', () => {
  const lock = freshLockPath();
  assert.doesNotThrow(() => release(lock));
});

test('single-flight: a corrupt lockfile is treated as absent', () => {
  const lock = freshLockPath();
  // Seed a fresh lock then corrupt it.
  assert.equal(acquire(lock, { staleMs: 60_000, now: () => 1000, pid: 1 }), true);
  // Overwrite with garbage by hand.
  writeFileSync(lock, 'not json', 'utf8');
  // Unreadable lock → acquire treats it as free.
  assert.equal(acquire(lock, { staleMs: 60_000, now: () => 2000, pid: 7 }), true);
  assert.equal(JSON.parse(readFileSync(lock, 'utf8')).pid, 7);
});
