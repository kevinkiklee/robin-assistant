import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { stopHookHandler } from '../../src/hooks/handlers/stop-hook.js';

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

test('Stop hook routes through daemon when running', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'robin-stop-daemon-'));
  seedConfig(tmp);
  const root = resolve(import.meta.dirname, '../..');
  const m = spawn(process.execPath, [join(root, 'bin/robin'), 'migrate'], {
    env: { ...process.env, ROBIN_HOME: tmp },
    stdio: 'inherit',
  });
  await new Promise((resolve) => m.on('exit', resolve));
  const daemon = spawn(process.execPath, [join(root, 'src/daemon/server.js')], {
    env: { ...process.env, ROBIN_HOME: tmp, ROBIN_HOST: 'claude_code' },
    stdio: 'pipe',
  });
  try {
    await waitForState(tmp);
    const orig = process.env.ROBIN_HOME;
    process.env.ROBIN_HOME = tmp;
    try {
      await stopHookHandler({ since: new Date().toISOString() });
    } finally {
      if (orig) process.env.ROBIN_HOME = orig;
      else Reflect.deleteProperty(process.env, 'ROBIN_HOME');
    }
    assert.ok(true);
  } finally {
    daemon.kill('SIGTERM');
    await new Promise((r) => daemon.once('exit', r));
    rmSync(tmp, { recursive: true });
  }
});
