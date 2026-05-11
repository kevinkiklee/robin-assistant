import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const __robinTestHome = join(
  tmpdir(),
  `robin-test-${process.pid}-${Math.random().toString(36).slice(2)}`,
);
mkdirSync(__robinTestHome, { recursive: true });
process.env.ROBIN_HOME = __robinTestHome;

const { intuitionHandler } = await import('../../cognition/intuition/handler.js');

function startStubServer(handler) {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      let body = '';
      req.setEncoding('utf8');
      req.on('data', (chunk) => {
        body += chunk;
      });
      req.on('end', () => {
        let parsed;
        try {
          parsed = body ? JSON.parse(body) : {};
        } catch {
          parsed = { _raw: body };
        }
        handler({ req, res, body: parsed });
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, port });
    });
  });
}

function writeDaemonStateFile(port) {
  const statePath = join(__robinTestHome, '.daemon.state');
  writeFileSync(
    statePath,
    JSON.stringify({
      port,
      pid: process.pid,
      version: 'test',
      started_at: new Date().toISOString(),
    }),
    'utf8',
  );
  return statePath;
}

function clearDaemonStateFile() {
  try {
    rmSync(join(__robinTestHome, '.daemon.state'));
  } catch {
    // ignore
  }
}

function clearProjectDir() {
  delete process.env.CLAUDE_PROJECT_DIR;
}

test('handler POSTs payload to /internal/intuition and writes block to stdout', async () => {
  clearProjectDir();
  let received = null;
  const { server, port } = await startStubServer(({ req, res, body }) => {
    received = { url: req.url, method: req.method, body };
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        block: '<!-- relevant memory -->\n[event 2026-04-12] hi\n<!-- /relevant memory -->',
        hits: 1,
        tokens: 20,
        latency_ms: 1,
        truncated: false,
      }),
    );
  });
  writeDaemonStateFile(port);

  const out = [];
  const errs = [];
  await intuitionHandler({
    stdin: { prompt: 'hello', transcript_path: '' },
    stdout: (s) => out.push(s),
    stderr: (s) => errs.push(s),
  });

  assert.ok(received, 'stub server received a request');
  assert.equal(received.url, '/internal/intuition');
  assert.equal(received.method, 'POST');
  assert.equal(received.body.query, 'hello');
  assert.equal(received.body.prior_assistant, '');
  assert.equal(received.body.k, 6);
  assert.equal(received.body.recency_days, 30);
  assert.equal(received.body.token_budget, 1500);
  assert.equal(out.length, 1);
  assert.match(out[0], /<!-- relevant memory -->/);
  assert.match(out[0], /<!-- \/relevant memory -->/);
  assert.deepEqual(errs, []);

  server.close();
  clearDaemonStateFile();
});

test('handler is fail-soft when daemon returns 500 — no stdout', async () => {
  clearProjectDir();
  const { server, port } = await startStubServer(({ res }) => {
    res.writeHead(500);
    res.end('boom');
  });
  writeDaemonStateFile(port);

  const out = [];
  const errs = [];
  await assert.doesNotReject(() =>
    intuitionHandler({
      stdin: { prompt: 'hello', transcript_path: '' },
      stdout: (s) => out.push(s),
      stderr: (s) => errs.push(s),
    }),
  );
  assert.deepEqual(out, []);
  assert.deepEqual(errs, []);

  server.close();
  clearDaemonStateFile();
});

test('handler exits silently when no .daemon.state is present', async () => {
  clearProjectDir();
  clearDaemonStateFile();
  const out = [];
  const errs = [];
  await assert.doesNotReject(() =>
    intuitionHandler({
      stdin: { prompt: 'hello', transcript_path: '' },
      stdout: (s) => out.push(s),
      stderr: (s) => errs.push(s),
    }),
  );
  assert.deepEqual(out, []);
  assert.deepEqual(errs, []);
});

test('handler suppresses injection when v1 hooks are active in CLAUDE_PROJECT_DIR', async () => {
  // Plant a v1 marker in a temp dir.
  const v1Dir = mkdtempSync(join(tmpdir(), 'robin-v1-marker-'));
  const hookDir = join(v1Dir, 'system/scripts/hooks');
  mkdirSync(hookDir, { recursive: true });
  writeFileSync(join(hookDir, 'host-hook.js'), '// v1 marker', 'utf8');
  process.env.CLAUDE_PROJECT_DIR = v1Dir;

  // Stub server should NOT be hit, but write state anyway to make the test
  // strict — if the handler did call the daemon we'd see it in `received`.
  let received = null;
  const { server, port } = await startStubServer(({ req, res, body }) => {
    received = { req, body };
    res.writeHead(200);
    res.end('{}');
  });
  writeDaemonStateFile(port);

  const out = [];
  const errs = [];
  await intuitionHandler({
    stdin: { prompt: 'hello', transcript_path: '' },
    stdout: (s) => out.push(s),
    stderr: (s) => errs.push(s),
  });

  assert.equal(received, null, 'daemon should not have been contacted during cutover');
  assert.deepEqual(out, []);
  assert.equal(errs.length, 1);
  assert.match(errs[0], /v1 hooks active.*v2 intuition yielding/);

  server.close();
  clearDaemonStateFile();
  clearProjectDir();
  rmSync(v1Dir, { recursive: true, force: true });
});

test('handler reads prior assistant message from JSONL transcript tail', async () => {
  clearProjectDir();
  const transcriptPath = join(
    __robinTestHome,
    `transcript-${Math.random().toString(36).slice(2)}.jsonl`,
  );
  const lines = [
    JSON.stringify({ role: 'user', content: 'first user message' }),
    JSON.stringify({ role: 'assistant', content: 'first assistant reply' }),
    JSON.stringify({ role: 'user', content: 'follow-up' }),
    JSON.stringify({
      role: 'assistant',
      content: [
        { type: 'text', text: 'we were discussing the kettlebell program' },
        { type: 'tool_use', id: 'x', name: 'foo', input: {} },
        { type: 'text', text: 'and how progress has been steady' },
      ],
    }),
  ];
  writeFileSync(transcriptPath, `${lines.join('\n')}\n`, 'utf8');

  let received = null;
  const { server, port } = await startStubServer(({ res, body }) => {
    received = body;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ block: '', hits: 0, tokens: 0, latency_ms: 0, truncated: false }));
  });
  writeDaemonStateFile(port);

  await intuitionHandler({
    stdin: { prompt: 'tell me more', transcript_path: transcriptPath },
    stdout: () => {},
    stderr: () => {},
  });

  assert.ok(received);
  assert.equal(received.query, 'tell me more');
  assert.match(received.prior_assistant, /kettlebell program/);
  assert.match(received.prior_assistant, /steady/);

  server.close();
  clearDaemonStateFile();
});

test('intuitionHandler forwards session_id from stdin in POST body', async () => {
  clearProjectDir();
  let captured = null;
  const fetchFn = async (_url, init) => {
    captured = JSON.parse(init.body);
    return { ok: true, json: async () => ({ block: '' }) };
  };
  await intuitionHandler({
    stdin: { prompt: 'hi', session_id: 'sess-abc' },
    stdout: () => {},
    stderr: () => {},
    readState: async () => ({ port: 9999 }),
    fetchFn,
  });
  assert.equal(captured?.session_id, 'sess-abc');
});

test('handler writes nothing to stdout when daemon returns empty block', async () => {
  clearProjectDir();
  const { server, port } = await startStubServer(({ res }) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ block: '', hits: 0, tokens: 0, latency_ms: 1, truncated: false }));
  });
  writeDaemonStateFile(port);

  const out = [];
  await intuitionHandler({
    stdin: { prompt: 'x', transcript_path: '' },
    stdout: (s) => out.push(s),
    stderr: () => {},
  });
  assert.deepEqual(out, []);

  server.close();
  clearDaemonStateFile();
});
