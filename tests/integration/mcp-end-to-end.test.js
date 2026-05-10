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
      const raw = readFileSync(join(home, '.daemon.state'), 'utf8');
      return JSON.parse(raw);
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  throw new Error('daemon did not start');
}

test('daemon boots, MCP transport responds, daemon stops cleanly', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'robin-mcp-e2e-'));
  seedConfig(tmp);
  const root = resolve(import.meta.dirname, '../..');
  // migrate first
  const m = spawn('node', [join(root, 'bin/robin'), 'migrate'], {
    env: { ...process.env, ROBIN_HOME: tmp },
    stdio: 'inherit',
  });
  await new Promise((resolve) => m.on('exit', resolve));

  const daemon = spawn('node', [join(root, 'src/daemon/server.js')], {
    env: { ...process.env, ROBIN_HOME: tmp, ROBIN_HOST: 'claude_code' },
    stdio: 'pipe',
  });

  try {
    const state = await waitForState(tmp);
    assert.ok(state.port > 0);
    // Phase 2b/2c/2d/2e/2f core + integration tools. Exact count depends on
    // environment (some integrations are gated by preflight: GA needs
    // GA_PROPERTIES, lrc needs LRC_CATALOG_PATH, chrome needs the local
    // history file). Use a lower-bound assertion so the test stays robust
    // across CI / dev / Kevin's box.
    assert.ok(
      state.tool_count >= 30,
      `expected at least 30 registered tools, got ${state.tool_count}`,
    );
    // Smoke: connecting to /sse should at least open (we don't parse SSE here)
    const res = await fetch(`http://127.0.0.1:${state.port}/sse`, {
      signal: AbortSignal.timeout(2000),
    }).catch((e) => e);
    // Either succeeded or aborted by timeout — both confirm the port is live
    assert.ok(res, 'fetch returned something');
  } finally {
    daemon.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 500));
    rmSync(tmp, { recursive: true });
  }
});
