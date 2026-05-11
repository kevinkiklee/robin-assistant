import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { acquire } from '../../src/db/lock.js';

test('acquire returns a release function', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'robin-lock-'));
  const release = await acquire(join(tmp, '.lock'));
  assert.equal(typeof release, 'function');
  await release();
  rmSync(tmp, { recursive: true });
});

test('second acquire blocks until first released or times out', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'robin-lock2-'));
  const path = join(tmp, '.lock');
  const release1 = await acquire(path);
  let resolved = false;
  const second = acquire(path, { timeoutMs: 200 })
    .then((r) => {
      resolved = true;
      return r;
    })
    .catch((e) => e);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(resolved, false);
  await release1();
  const result = await second;
  assert.equal(typeof result, 'function'); // got the lock after first release
  await result();
  rmSync(tmp, { recursive: true });
});

test('acquire throws after timeout', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'robin-lock3-'));
  const path = join(tmp, '.lock');
  const release1 = await acquire(path);
  await assert.rejects(acquire(path, { timeoutMs: 100 }), /lock timeout/);
  await release1();
  rmSync(tmp, { recursive: true });
});
