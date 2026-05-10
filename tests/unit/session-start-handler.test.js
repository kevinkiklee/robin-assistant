import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
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

const { sessionStartHandler } = await import('../../src/hooks/handlers/session-start.js');

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

test('handler POSTs payload to /internal/session/register', async () => {
  let received = null;
  const { server, port } = await startStubServer(({ req, res, body }) => {
    received = { url: req.url, method: req.method, body };
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ session_count: 1, tamper_findings: [] }));
  });
  writeDaemonStateFile(port);

  const errs = [];
  await sessionStartHandler({
    stdin: { session_id: 's1', transcript_path: '/tmp/t.jsonl' },
    stderr: (s) => errs.push(s),
  });

  assert.ok(received, 'stub server received a request');
  assert.equal(received.url, '/internal/session/register');
  assert.equal(received.method, 'POST');
  assert.equal(received.body.session_id, 's1');
  assert.equal(received.body.transcript_path, '/tmp/t.jsonl');
  assert.equal(typeof received.body.host, 'string');
  assert.equal(received.body.pid, process.pid);
  assert.deepEqual(errs, []);

  server.close();
  clearDaemonStateFile();
});

test('handler is fail-soft when daemon returns 500', async () => {
  const { server, port } = await startStubServer(({ res }) => {
    res.writeHead(500);
    res.end('boom');
  });
  writeDaemonStateFile(port);

  const errs = [];
  await assert.doesNotReject(() =>
    sessionStartHandler({
      stdin: { session_id: 's2', transcript_path: '/tmp/x.jsonl' },
      stderr: (s) => errs.push(s),
    }),
  );
  assert.deepEqual(errs, []);

  server.close();
  clearDaemonStateFile();
});

test('handler exits silently when no .daemon.state is present', async () => {
  clearDaemonStateFile();
  const errs = [];
  await assert.doesNotReject(() =>
    sessionStartHandler({
      stdin: { session_id: 's3', transcript_path: '/tmp/y.jsonl' },
      stderr: (s) => errs.push(s),
    }),
  );
  assert.deepEqual(errs, []);
});

test('handler emits "session N of N" stderr when session_count > 1', async () => {
  const { server, port } = await startStubServer(({ res }) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ session_count: 2, tamper_findings: [] }));
  });
  writeDaemonStateFile(port);

  const errs = [];
  await sessionStartHandler({
    stdin: { session_id: 's4', transcript_path: '/tmp/z.jsonl' },
    stderr: (s) => errs.push(s),
  });
  assert.equal(errs.length, 1);
  assert.match(errs[0], /^Robin: session 2 of 2$/);

  server.close();
  clearDaemonStateFile();
});

test('handler surfaces tamper findings on stderr', async () => {
  const { server, port } = await startStubServer(({ res }) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        session_count: 1,
        tamper_findings: [
          { kind: 'hash_drift', path: '/some/file' },
          { kind: 'mode_drift', path: '/secrets/.env' },
        ],
      }),
    );
  });
  writeDaemonStateFile(port);

  const errs = [];
  await sessionStartHandler({
    stdin: { session_id: 's5', transcript_path: '/tmp/q.jsonl' },
    stderr: (s) => errs.push(s),
  });
  assert.equal(errs.length, 2);
  assert.match(errs[0], /tamper warning — hash_drift: \/some\/file/);
  assert.match(errs[1], /tamper warning — mode_drift: \/secrets\/\.env/);

  server.close();
  clearDaemonStateFile();
});
