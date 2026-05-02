import { describe, test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import {
  acquireLock,
  releaseLock,
  readLock,
  writeIfChanged,
  atomicWrite,
  readJSON,
  writeJSON,
  writeJSONIfChanged,
  sha256,
} from '../../../scripts/jobs/lib/atomic.js';

let dir;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'jobs-atomic-'));
});

describe('writeIfChanged', () => {
  test('writes when content is new', () => {
    const p = join(dir, 'a.txt');
    const wrote = writeIfChanged(p, 'hello');
    assert.equal(wrote, true);
    assert.equal(readFileSync(p, 'utf-8'), 'hello');
  });

  test('skips when content is unchanged (mtime unchanged)', async () => {
    const p = join(dir, 'a.txt');
    writeIfChanged(p, 'hello');
    const m1 = statSync(p).mtimeMs;
    await new Promise((r) => setTimeout(r, 10));
    const wrote = writeIfChanged(p, 'hello');
    assert.equal(wrote, false);
    assert.equal(statSync(p).mtimeMs, m1);
  });

  test('writes on change', () => {
    const p = join(dir, 'a.txt');
    writeIfChanged(p, 'hello');
    const wrote = writeIfChanged(p, 'world');
    assert.equal(wrote, true);
    assert.equal(readFileSync(p, 'utf-8'), 'world');
  });

  test('creates parent directories', () => {
    const p = join(dir, 'nested/deep/a.txt');
    const wrote = writeIfChanged(p, 'hello');
    assert.equal(wrote, true);
    assert.equal(readFileSync(p, 'utf-8'), 'hello');
  });
});

describe('atomicWrite + readJSON / writeJSON', () => {
  test('round-trips JSON', () => {
    const p = join(dir, 'state.json');
    writeJSON(p, { a: 1, b: 'two' });
    assert.deepEqual(readJSON(p), { a: 1, b: 'two' });
  });

  test('readJSON returns fallback for missing file', () => {
    assert.equal(readJSON(join(dir, 'nope.json'), null), null);
    assert.deepEqual(readJSON(join(dir, 'nope.json'), { x: 1 }), { x: 1 });
  });

  test('writeJSONIfChanged skips equal content', () => {
    const p = join(dir, 's.json');
    assert.equal(writeJSONIfChanged(p, { a: 1 }), true);
    assert.equal(writeJSONIfChanged(p, { a: 1 }), false);
    assert.equal(writeJSONIfChanged(p, { a: 2 }), true);
  });
});

describe('acquireLock / releaseLock', () => {
  test('acquire succeeds when no prior lock', () => {
    const p = join(dir, 'a.lock');
    assert.equal(acquireLock(p), null);
    assert.equal(readLock(p).pid, process.pid);
  });

  test('acquire fails when held by live PID', () => {
    const p = join(dir, 'a.lock');
    assert.equal(acquireLock(p), null);
    // Second acquire from a "different" caller: reuse current pid (alive).
    assert.equal(acquireLock(p), 'held');
  });

  test('acquire reclaims when holder PID is dead', () => {
    const p = join(dir, 'a.lock');
    // Write a fake lock with a definitely-dead PID.
    writeFileSync(p, JSON.stringify({ pid: 999999, started_at: new Date().toISOString(), host: '' }));
    assert.equal(acquireLock(p), null);
    assert.equal(readLock(p).pid, process.pid);
  });

  test('acquire reclaims when lock is older than staleMs', () => {
    const p = join(dir, 'a.lock');
    // Write a fake lock with current pid (alive) but very old timestamp.
    writeFileSync(
      p,
      JSON.stringify({
        pid: 999999,
        started_at: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
        host: 'other-host',
      })
    );
    // Different host disables the PID-liveness check; staleness path triggers reclaim.
    assert.equal(acquireLock(p, { host: 'this-host', staleMs: 5 * 60 * 1000 }), null);
  });

  test('release is idempotent', () => {
    const p = join(dir, 'a.lock');
    acquireLock(p);
    assert.equal(releaseLock(p), true);
    assert.equal(releaseLock(p), true);
  });

  test('two simultaneous acquires from separate processes — exactly one wins', async () => {
    const p = join(dir, 'a.lock');
    // Each child holds the lock briefly so both are alive when contending.
    const script = `
      import { acquireLock } from '${join(process.cwd(), 'system/scripts/jobs/lib/atomic.js')}';
      const r = acquireLock('${p}');
      process.stdout.write(r === null ? 'won' : 'lost');
      await new Promise((r) => setTimeout(r, 200));
    `;
    const launch = () => {
      const proc = spawn(process.execPath, ['--input-type=module', '-e', script]);
      let out = '';
      proc.stdout.on('data', (d) => (out += d.toString()));
      return new Promise((resolve) => proc.on('close', () => resolve(out)));
    };
    const [a, b] = await Promise.all([launch(), launch()]);
    const sorted = [a, b].sort();
    assert.deepEqual(sorted, ['lost', 'won']);
  });
});

describe('sha256', () => {
  test('stable hash', () => {
    assert.equal(sha256('hello').slice(0, 12), '2cf24dba5fb0');
  });
});

// teardown
import { afterEach } from 'node:test';
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});
