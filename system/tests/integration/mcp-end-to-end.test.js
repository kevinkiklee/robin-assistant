import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

function seedConfig(home) {
  mkdirSync(join(home, 'config'), { recursive: true });
  writeFileSync(
    join(home, 'config', 'config.json'),
    JSON.stringify({ embedder_profile: 'mxbai-1024' }),
  );
}

async function waitForState(home, timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const raw = readFileSync(join(home, 'runtime', 'daemon', '.state'), 'utf8');
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
  const root = resolve(import.meta.dirname, '../../..');
  // migrate first
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
    assert.ok(state.port > 0);
    // /sse + /messages now require Bearer authToken from .state — the daemon
    // mints it at boot and Claude Code reads it from this file. Tests have to
    // do the same to clear the auth gate.
    const auth = state.auth_token ? { Authorization: `Bearer ${state.auth_token}` } : {};
    // Phase 2b/2c/2d/2e/2f core + integration tools. Exact count depends on
    // environment (some integrations are gated by preflight: GA needs
    // GA_PROPERTIES, lrc needs LRC_CATALOG_PATH, chrome needs the local
    // history file). Use a lower-bound assertion so the test stays robust
    // across CI / dev / local boxes.
    assert.ok(
      state.tool_count >= 30,
      `expected at least 30 registered tools, got ${state.tool_count}`,
    );
    // Full SSE round-trip: open /sse, parse the `endpoint` event for the
    // server-assigned sessionId, then drive initialize + tools/list over
    // POST /messages?sessionId=… and read the JSON-RPC responses back off
    // the SSE stream. Without the daemon's POST /messages handler this
    // step would 404 (and previously did — that's the bug this test pins).
    const base = `http://127.0.0.1:${state.port}`;
    const ac = new AbortController();
    try {
      const sse = await fetch(`${base}/sse`, { signal: ac.signal, headers: auth });
      assert.equal(sse.status, 200, 'SSE handshake');
      const reader = sse.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      const events = [];
      const readUntil = async (pred, timeoutMs = 5000) => {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          for (;;) {
            const idx = buf.indexOf('\n\n');
            if (idx === -1) break;
            const block = buf.slice(0, idx);
            buf = buf.slice(idx + 2);
            const ev = { event: 'message', data: '' };
            for (const line of block.split('\n')) {
              if (line.startsWith('event: ')) ev.event = line.slice(7);
              else if (line.startsWith('data: ')) ev.data += line.slice(6);
            }
            events.push(ev);
            const hit = pred(ev);
            if (hit) return hit;
          }
        }
        throw new Error(
          `SSE event matching predicate not seen within ${timeoutMs}ms; got: ${JSON.stringify(events)}`,
        );
      };

      const endpointEv = await readUntil((e) => (e.event === 'endpoint' ? e : null));
      const endpointPath = endpointEv.data.trim();
      assert.match(endpointPath, /^\/messages\?sessionId=/, 'endpoint event format');

      const post = async (body) =>
        await fetch(`${base}${endpointPath}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...auth },
          body: JSON.stringify(body),
        });

      const initRes = await post({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'mcp-e2e-test', version: '0.0.0' },
        },
      });
      assert.equal(initRes.status, 202, 'initialize accepted');

      const initReply = await readUntil((e) => {
        if (e.event !== 'message') return null;
        try {
          const j = JSON.parse(e.data);
          return j.id === 1 ? j : null;
        } catch {
          return null;
        }
      });
      assert.ok(initReply.result, 'initialize result');
      assert.equal(initReply.result.serverInfo.name, 'robin');

      const initialized = await post({
        jsonrpc: '2.0',
        method: 'notifications/initialized',
      });
      assert.equal(initialized.status, 202, 'notifications/initialized accepted');

      const listRes = await post({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
      assert.equal(listRes.status, 202, 'tools/list accepted');
      const listReply = await readUntil((e) => {
        if (e.event !== 'message') return null;
        try {
          const j = JSON.parse(e.data);
          return j.id === 2 ? j : null;
        } catch {
          return null;
        }
      });
      assert.ok(Array.isArray(listReply.result?.tools), 'tools array');
      assert.ok(
        listReply.result.tools.length >= 30,
        `expected ≥30 tools over MCP, got ${listReply.result.tools.length}`,
      );
    } finally {
      ac.abort();
    }

    // Negative: a POST to /messages with no sessionId should 404 cleanly
    // (not crash the daemon, not 500). Pins the "unknown SSE session"
    // branch in handlePostMessage.
    const stray = await fetch(`${base}/messages?sessionId=does-not-exist`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...auth },
      body: '{}',
    });
    assert.equal(stray.status, 404, 'stray POST /messages 404s');
  } finally {
    daemon.kill('SIGTERM');
    await new Promise((r) => daemon.once('exit', r));
    rmSync(tmp, { recursive: true });
  }
});
