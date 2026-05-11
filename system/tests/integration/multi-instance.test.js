import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

function seedConfig(home) {
  writeFileSync(join(home, 'config.json'), JSON.stringify({ embedder_profile: 'mxbai-1024' }));
}

async function waitForState(home, timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      return JSON.parse(readFileSync(join(home, '.daemon.state'), 'utf8'));
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  throw new Error('daemon did not start');
}

test('multiple parallel HTTP requests to the daemon do not corrupt the DB', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'robin-multi-'));
  seedConfig(tmp);
  const root = resolve(import.meta.dirname, '../../..');
  const m = spawn(process.execPath, [join(root, 'system/bin/robin'), 'migrate'], {
    env: { ...process.env, ROBIN_HOME: tmp },
    stdio: 'inherit',
  });
  await new Promise((resolve) => m.on('exit', resolve));
  const daemon = spawn(process.execPath, [join(root, 'system/runtime/daemon/server.js')], {
    env: { ...process.env, ROBIN_HOME: tmp, ROBIN_HOST: 'claude_code' },
    stdio: 'pipe',
  });
  try {
    const state = await waitForState(tmp);
    const reqs = Array.from({ length: 10 }, () =>
      fetch(`http://127.0.0.1:${state.port}/internal/biographer/process-pending`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
        signal: AbortSignal.timeout(5000),
      }).catch((e) => ({ ok: false, error: e.message })),
    );
    const responses = await Promise.all(reqs);
    const ok = responses.filter((r) => r.ok).length;
    assert.ok(ok >= 5, `expected at least 5 successful responses, got ${ok}`);
  } finally {
    daemon.kill('SIGTERM');
    await new Promise((r) => daemon.once('exit', r));
    rmSync(tmp, { recursive: true });
  }
});
