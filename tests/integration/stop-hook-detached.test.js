import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { test } from 'node:test';
import { stopHookHandler } from '../../src/hooks/stop-hook.js';

test('stopHookHandler returns within 100ms (fire-and-forget)', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'robin-stop-hook-'));
  const orig = process.env.ROBIN_HOME;
  process.env.ROBIN_HOME = tmp;
  try {
    const t0 = performance.now();
    await stopHookHandler({ since: new Date(Date.now() - 5000).toISOString() });
    const elapsed = performance.now() - t0;
    assert.ok(elapsed < 100, `expected < 100ms, got ${elapsed.toFixed(0)}ms`);
    // The detached subprocess may or may not have written the log yet; just confirm the dir exists
    assert.ok(existsSync(join(tmp, 'logs')));
  } finally {
    if (orig) process.env.ROBIN_HOME = orig;
    else Reflect.deleteProperty(process.env, 'ROBIN_HOME');
    rmSync(tmp, { recursive: true });
  }
});

test('stopHookHandler works without --since', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'robin-stop-hook-no-since-'));
  const orig = process.env.ROBIN_HOME;
  process.env.ROBIN_HOME = tmp;
  try {
    const t0 = performance.now();
    await stopHookHandler();
    const elapsed = performance.now() - t0;
    assert.ok(elapsed < 100, `expected < 100ms, got ${elapsed.toFixed(0)}ms`);
  } finally {
    if (orig) process.env.ROBIN_HOME = orig;
    else Reflect.deleteProperty(process.env, 'ROBIN_HOME');
    rmSync(tmp, { recursive: true });
  }
});
