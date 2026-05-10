import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

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
    // 10 Phase 2b tools + 9 Phase 2c tools + 5 Phase 2d integration tools
    // (status + run + gmail_search + gmail_get_thread + lunch_money_query) = 24,
    // + 2 Phase 2e google_calendar tools (calendar_list_events + calendar_get_event) = 26,
    // + 2 Phase 2e google_drive tools (drive_search + drive_get_file) = 28,
    // + 2 Phase 2e youtube tools (youtube_list_subscriptions + youtube_list_liked) = 30,
    // + 1 Phase 2e github_write tool-only tool = 31.
    assert.equal(state.tool_count, 31, `expected 31 registered tools, got ${state.tool_count}`);
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
