import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, writeFileSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireDensifyLock, releaseDensifyLock, sweepStaleDensifyLock } from '../../../scripts/memory/lib/densify-lock.js';

test('acquireDensifyLock creates lock and returns lock metadata', () => {
  const ws = mkdtempSync(join(tmpdir(), 'lock-test-'));
  try {
    const lock = acquireDensifyLock(ws);
    assert.ok(lock);
    assert.equal(lock.path, join(ws, '.locks', 'wiki-densify.lock'));
    assert.ok(existsSync(lock.path));
    releaseDensifyLock(lock);
    assert.ok(!existsSync(lock.path));
  } finally {
    rmSync(ws, { recursive: true });
  }
});

test('acquireDensifyLock throws when lock already held by live PID', () => {
  const ws = mkdtempSync(join(tmpdir(), 'lock-test-'));
  try {
    const first = acquireDensifyLock(ws);
    assert.throws(() => acquireDensifyLock(ws), /lock held/i);
    releaseDensifyLock(first);
  } finally {
    rmSync(ws, { recursive: true });
  }
});

test('sweepStaleDensifyLock removes lock with non-running PID', () => {
  const ws = mkdtempSync(join(tmpdir(), 'lock-test-'));
  try {
    const lockPath = join(ws, '.locks', 'wiki-densify.lock');
    mkdirSync(join(ws, '.locks'), { recursive: true });
    // Forge a lock with a definitely-dead PID.
    writeFileSync(lockPath, JSON.stringify({ pid: 999999999, started: Date.now() }));
    const swept = sweepStaleDensifyLock(ws);
    assert.equal(swept, true);
    assert.ok(!existsSync(lockPath));
  } finally {
    rmSync(ws, { recursive: true });
  }
});

test('sweepStaleDensifyLock removes lock older than 5 minutes', () => {
  const ws = mkdtempSync(join(tmpdir(), 'lock-test-'));
  try {
    const lockPath = join(ws, '.locks', 'wiki-densify.lock');
    mkdirSync(join(ws, '.locks'), { recursive: true });
    // PID is current process (alive), but started 6 min ago.
    writeFileSync(lockPath, JSON.stringify({ pid: process.pid, started: Date.now() - 6 * 60 * 1000 }));
    const swept = sweepStaleDensifyLock(ws);
    assert.equal(swept, true);
    assert.ok(!existsSync(lockPath));
  } finally {
    rmSync(ws, { recursive: true });
  }
});

test('sweepStaleDensifyLock returns false when lock is fresh and PID alive', () => {
  const ws = mkdtempSync(join(tmpdir(), 'lock-test-'));
  try {
    const lockPath = join(ws, '.locks', 'wiki-densify.lock');
    mkdirSync(join(ws, '.locks'), { recursive: true });
    writeFileSync(lockPath, JSON.stringify({ pid: process.pid, started: Date.now() }));
    const swept = sweepStaleDensifyLock(ws);
    assert.equal(swept, false);
    assert.ok(existsSync(lockPath));
    rmSync(lockPath);  // cleanup
  } finally {
    rmSync(ws, { recursive: true });
  }
});

test('releaseDensifyLock is no-op if lock owned by another PID (defensive)', () => {
  const ws = mkdtempSync(join(tmpdir(), 'lock-test-'));
  try {
    const lockPath = join(ws, '.locks', 'wiki-densify.lock');
    mkdirSync(join(ws, '.locks'), { recursive: true });
    // Lock owned by a different PID.
    writeFileSync(lockPath, JSON.stringify({ pid: 1, started: Date.now() }));
    // Caller's lock object claims THIS process owns it (simulating a stale ref).
    releaseDensifyLock({ path: lockPath, pid: process.pid, started: Date.now() });
    // Lock should still exist — we shouldn't delete someone else's lock.
    assert.ok(existsSync(lockPath));
  } finally {
    rmSync(ws, { recursive: true });
  }
});
