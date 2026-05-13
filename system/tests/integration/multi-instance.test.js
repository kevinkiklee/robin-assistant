import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { connect as netConnect, createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

function hasSurrealBinary() {
  // Spawning a standalone server requires the surreal CLI on PATH (installed
  // via `brew install surrealdb/tap/surreal` or the install.surrealdb.com
  // script). Skip cleanly when it isn't available — embedded surrealkv is
  // single-writer and can't satisfy the concurrent-write assertion below.
  const r = spawnSync('surreal', ['version'], { stdio: 'ignore' });
  return r.status === 0;
}

function seedConfig(home, dbUrl, user = 'root', pass = 'root') {
  mkdirSync(join(home, 'config'), { recursive: true });
  writeFileSync(
    join(home, 'config', 'config.json'),
    JSON.stringify({
      embedder_profile: 'mxbai-1024',
      db: { url: dbUrl, user, pass },
    }),
  );
}

async function pickFreePort() {
  return await new Promise((resolveFn, reject) => {
    const s = createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const port = s.address().port;
      s.close(() => resolveFn(port));
    });
  });
}

async function waitForState(home, timeoutMs = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      return JSON.parse(readFileSync(join(home, 'runtime', 'daemon', '.state'), 'utf8'));
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  throw new Error('daemon did not start');
}

async function waitForTcp(host, port, timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const reachable = await new Promise((resolveFn) => {
      const sock = netConnect({ host, port });
      const done = (ok) => {
        sock.destroy();
        resolveFn(ok);
      };
      sock.once('connect', () => done(true));
      sock.once('error', () => done(false));
      sock.setTimeout(500, () => done(false));
    });
    if (reachable) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`server did not listen on ${host}:${port} within ${timeoutMs}ms`);
}

test('multiple parallel HTTP requests to the daemon do not corrupt the DB', {
  skip: hasSurrealBinary() ? false : 'requires `surreal` binary on PATH (multi-writer DB)',
}, async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'robin-multi-'));
  const root = resolve(import.meta.dirname, '../../..');
  const dbDir = join(tmp, 'db');
  mkdirSync(dbDir, { recursive: true });
  const surrealPort = await pickFreePort();
  // Standalone surreal lets the daemon's integration ticks and the test's
  // parallel HTTP fan-out share one MVCC writer; embedded surrealkv is
  // single-writer and deadlocks under that load.
  const surreal = spawn(
    'surreal',
    [
      'start',
      '--bind',
      `127.0.0.1:${surrealPort}`,
      '--user',
      'root',
      '--pass',
      'root',
      '--log',
      'error',
      `surrealkv://${dbDir}`,
    ],
    { stdio: 'ignore' },
  );
  try {
    await waitForTcp('127.0.0.1', surrealPort, 15000);
    seedConfig(tmp, `ws://127.0.0.1:${surrealPort}`);
    const m = spawn(process.execPath, [join(root, 'system/bin/robin'), 'migrate'], {
      env: { ...process.env, ROBIN_HOME: tmp },
      stdio: 'inherit',
    });
    await new Promise((resolveFn) => m.on('exit', resolveFn));

    // Strip host-detect signals so detectHost() returns null and the daemon
    // boots without a host adapter. With a real host, the biographer queue
    // worker tries to spawn `claude` / `gemini` subprocesses for each
    // enqueued event, saturating the single ws connection. PATH is reduced
    // to /usr/bin:/bin so detect.js's isAvailable() probes (which shell out
    // to `claude --version` / `gemini --version`) can't find either binary.
    const cleanEnv = { ...process.env, ROBIN_HOME: tmp, PATH: '/usr/bin:/bin' };
    delete cleanEnv.ROBIN_HOST;
    delete cleanEnv.CLAUDE_PROJECT_DIR;
    delete cleanEnv.GEMINI_API_KEY;

    // `stdio: 'ignore'` (not 'pipe') is load-bearing: the daemon emits a
    // line per integration tick + per scheduler bucket, and stdio: 'pipe'
    // without an attached drain causes the OS pipe buffer to fill (~64 KB)
    // and back-pressure the daemon's writes, freezing its event loop right
    // when we want to measure its HTTP throughput.
    const daemon = spawn(process.execPath, [join(root, 'system/runtime/daemon/server.js')], {
      env: cleanEnv,
      stdio: 'ignore',
    });
    try {
      const state = await waitForState(tmp);
      // `/internal/*` is bearer-token-gated (per-boot 64-char hex token
      // written to .daemon.state). Without it, every request 401s and the
      // assertion below trivially fails. Read the token from the state
      // file the same way the real CLI/hook callers do.
      const headers = {
        'content-type': 'application/json',
        ...(state.auth_token ? { authorization: `Bearer ${state.auth_token}` } : {}),
      };
      // boot() fans out ~15 integration sync ticks immediately on a fresh
      // DB. On a single ws connection those ticks dominate the queue for
      // ~10–15s. Probe instead of fixed-sleep: wait until the route can
      // round-trip in <1 s, then assume contention has cleared. Under
      // suite-parallel load this is much cheaper than a hardcoded settle.
      const settleDeadline = Date.now() + 30_000;
      while (Date.now() < settleDeadline) {
        const start = Date.now();
        const r = await fetch(
          `http://127.0.0.1:${state.port}/internal/biographer/process-pending`,
          { method: 'POST', headers, body: '{}', signal: AbortSignal.timeout(2_000) },
        ).catch(() => null);
        if (r && r.ok && Date.now() - start < 1_000) break;
        await new Promise((r) => setTimeout(r, 500));
      }
      const reqs = Array.from({ length: 10 }, () =>
        fetch(`http://127.0.0.1:${state.port}/internal/biographer/process-pending`, {
          method: 'POST',
          headers,
          body: JSON.stringify({}),
          signal: AbortSignal.timeout(15_000),
        }).catch((e) => ({ ok: false, error: e.message })),
      );
      const responses = await Promise.all(reqs);
      const ok = responses.filter((r) => r.ok).length;
      assert.ok(ok >= 5, `expected at least 5 successful responses, got ${ok}`);
    } finally {
      daemon.kill('SIGTERM');
      await new Promise((r) => daemon.once('exit', r));
    }
  } finally {
    surreal.kill('SIGTERM');
    await new Promise((r) => surreal.once('exit', r));
    rmSync(tmp, { recursive: true });
  }
});
