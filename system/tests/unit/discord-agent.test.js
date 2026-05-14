import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import { __test__, runDiscordAgent } from '../../io/integrations/discord/agent.js';

const { buildArgs, parseEnvelope, envTimeoutMs, FALLBACK_TIMEOUT_MS } = __test__;

test('buildArgs: no prior sessionId uses -p flag without --resume', () => {
  const args = buildArgs({ prompt: 'hi', sessionId: null, maxTurns: 20 });
  assert.deepEqual(args, ['-p', 'hi', '--output-format', 'json', '--max-turns', '20']);
});

test('buildArgs: prior sessionId prepends --resume', () => {
  const args = buildArgs({ prompt: 'hi', sessionId: 'sess-123', maxTurns: 20 });
  assert.deepEqual(args, [
    '--resume',
    'sess-123',
    '-p',
    'hi',
    '--output-format',
    'json',
    '--max-turns',
    '20',
  ]);
});

test('parseEnvelope: whole-buffer JSON envelope', () => {
  const env = parseEnvelope(
    JSON.stringify({ result: 'hello', session_id: 'sess-1', total_cost_usd: 0.01 }),
  );
  assert.equal(env.result, 'hello');
  assert.equal(env.session_id, 'sess-1');
});

test('parseEnvelope: scans from bottom for last JSON line on multi-line stdout', () => {
  const stdout = [
    'spurious log line',
    '{"random":"junk"}', // valid JSON earlier — we want the LAST one
    JSON.stringify({ result: 'final', session_id: 'sess-2' }),
  ].join('\n');
  const env = parseEnvelope(stdout);
  assert.equal(env.result, 'final');
  assert.equal(env.session_id, 'sess-2');
});

test('parseEnvelope: returns null when nothing parses', () => {
  assert.equal(parseEnvelope('this is not JSON'), null);
});

test('envTimeoutMs: defaults to 15 minutes', () => {
  const prev = process.env.ROBIN_DISCORD_AGENT_TIMEOUT_MS;
  delete process.env.ROBIN_DISCORD_AGENT_TIMEOUT_MS;
  try {
    assert.equal(envTimeoutMs(), FALLBACK_TIMEOUT_MS);
    assert.equal(FALLBACK_TIMEOUT_MS, 15 * 60 * 1000);
  } finally {
    if (prev !== undefined) process.env.ROBIN_DISCORD_AGENT_TIMEOUT_MS = prev;
  }
});

test('envTimeoutMs: honors ROBIN_DISCORD_AGENT_TIMEOUT_MS override', () => {
  const prev = process.env.ROBIN_DISCORD_AGENT_TIMEOUT_MS;
  process.env.ROBIN_DISCORD_AGENT_TIMEOUT_MS = '60000';
  try {
    assert.equal(envTimeoutMs(), 60_000);
  } finally {
    if (prev === undefined) delete process.env.ROBIN_DISCORD_AGENT_TIMEOUT_MS;
    else process.env.ROBIN_DISCORD_AGENT_TIMEOUT_MS = prev;
  }
});

test('envTimeoutMs: falls back when override is non-numeric or non-positive', () => {
  const prev = process.env.ROBIN_DISCORD_AGENT_TIMEOUT_MS;
  try {
    for (const bad of ['', 'abc', '0', '-5', 'NaN']) {
      process.env.ROBIN_DISCORD_AGENT_TIMEOUT_MS = bad;
      assert.equal(envTimeoutMs(), FALLBACK_TIMEOUT_MS, `bad value: ${JSON.stringify(bad)}`);
    }
  } finally {
    if (prev === undefined) delete process.env.ROBIN_DISCORD_AGENT_TIMEOUT_MS;
    else process.env.ROBIN_DISCORD_AGENT_TIMEOUT_MS = prev;
  }
});

// --- spawn-based behavioral tests ---

function makeFakeSpawn({ stdout = '', stderr = '', exitCode = 0, hang = false } = {}) {
  let killed = false;
  const closeHandlers = [];
  let dataHandler = null;
  let completed = false;

  // Real child processes deliver `stdout 'data'` BEFORE `close`. Fire in that
  // order: schedule completion only once BOTH the data handler and a close
  // handler have been registered (runDiscordAgent registers them
  // synchronously, so a single microtask tick is enough).
  function maybeComplete() {
    if (hang || completed) return;
    if (!dataHandler || closeHandlers.length === 0) return;
    completed = true;
    Promise.resolve()
      .then(() => {
        if (stdout) dataHandler(Buffer.from(stdout));
      })
      .then(() => {
        for (const cb of closeHandlers) cb(exitCode);
      });
  }

  const proc = {
    stdout: {
      on: (event, cb) => {
        if (event === 'data') {
          dataHandler = cb;
          maybeComplete();
        }
      },
    },
    stderr: {
      on: (event, cb) => {
        if (event === 'data' && stderr) setImmediate(() => cb(Buffer.from(stderr)));
      },
    },
    stdin: { write: () => {}, end: () => {} },
    pid: 12345,
    killed: false,
    on(event, cb) {
      if (event === 'exit' || event === 'close') {
        closeHandlers.push(cb);
        maybeComplete();
      }
    },
    kill() {
      killed = true;
      this.killed = true;
      // Simulate the OS firing 'close' after the kill signal lands.
      Promise.resolve().then(() => {
        for (const cb of closeHandlers) cb(null);
      });
    },
  };

  const spawn = mock.fn(() => proc);
  return { spawn, wasKilled: () => killed, proc };
}

test('runDiscordAgent: happy path parses envelope and returns text + sessionId', async () => {
  const stdout = JSON.stringify({
    result: 'the answer is 42',
    session_id: 'sess-abc',
    total_cost_usd: 0.005,
    is_error: false,
  });
  const { spawn } = makeFakeSpawn({ stdout, exitCode: 0 });
  const r = await runDiscordAgent({ prompt: 'q', spawnFn: spawn });
  assert.equal(r.code, 'OK');
  assert.equal(r.text, 'the answer is 42');
  assert.equal(r.sessionId, 'sess-abc');
  assert.equal(r.costUsd, 0.005);
});

test('runDiscordAgent: passes --resume when sessionId provided', async () => {
  const stdout = JSON.stringify({ result: 'ok', session_id: 'sess-2' });
  const { spawn } = makeFakeSpawn({ stdout });
  await runDiscordAgent({ prompt: 'q', sessionId: 'sess-1', spawnFn: spawn });
  const [, args] = spawn.mock.calls[0].arguments;
  assert.equal(args[0], '--resume');
  assert.equal(args[1], 'sess-1');
});

test('runDiscordAgent: pre-aborted signal returns CANCELLED without spawning', async () => {
  const { spawn } = makeFakeSpawn();
  const ac = new AbortController();
  ac.abort();
  const r = await runDiscordAgent({ prompt: 'q', signal: ac.signal, spawnFn: spawn });
  assert.equal(r.code, 'CANCELLED');
  assert.equal(spawn.mock.callCount(), 0);
});

test('runDiscordAgent: abort mid-flight kills child and returns CANCELLED', async () => {
  const { spawn, wasKilled } = makeFakeSpawn({ hang: true });
  const ac = new AbortController();
  const p = runDiscordAgent({ prompt: 'q', signal: ac.signal, spawnFn: spawn });
  await new Promise((r) => setImmediate(r));
  ac.abort();
  const r = await p;
  assert.equal(r.code, 'CANCELLED');
  assert.equal(wasKilled(), true);
});

test('runDiscordAgent: nonzero exit returns NONZERO_EXIT with error message', async () => {
  const { spawn } = makeFakeSpawn({ stdout: '', stderr: 'oops', exitCode: 2 });
  const r = await runDiscordAgent({ prompt: 'q', spawnFn: spawn });
  assert.equal(r.code, 'NONZERO_EXIT');
  assert.equal(r.isError, true);
  assert.match(r.text, /agent exited 2/);
});

test('runDiscordAgent: unparseable stdout returns PARSE_FAILED', async () => {
  const { spawn } = makeFakeSpawn({ stdout: 'not json at all', exitCode: 0 });
  const r = await runDiscordAgent({ prompt: 'q', spawnFn: spawn });
  assert.equal(r.code, 'PARSE_FAILED');
  assert.equal(r.isError, true);
});

test('runDiscordAgent: timeout kills child and returns TIMEOUT', async () => {
  const { spawn, wasKilled } = makeFakeSpawn({ hang: true });
  const r = await runDiscordAgent({ prompt: 'q', spawnFn: spawn, timeoutMs: 30 });
  assert.equal(r.code, 'TIMEOUT');
  assert.equal(r.isError, true);
  assert.equal(wasKilled(), true);
});

test('runDiscordAgent: spawn cwd defaults to package root (.mcp.json directory)', async () => {
  const stdout = JSON.stringify({ result: 'ok', session_id: 'x' });
  const { spawn } = makeFakeSpawn({ stdout });
  await runDiscordAgent({ prompt: 'q', spawnFn: spawn });
  const [, , opts] = spawn.mock.calls[0].arguments;
  // PKG_ROOT should end with `robin-assistant-v2` so claude picks up .mcp.json.
  assert.match(opts.cwd, /robin-assistant-v2$/);
});

test('runDiscordAgent: env carries ROBIN_SESSION_PLATFORM=discord', async () => {
  const stdout = JSON.stringify({ result: 'ok' });
  const { spawn } = makeFakeSpawn({ stdout });
  await runDiscordAgent({ prompt: 'q', spawnFn: spawn });
  const [, , opts] = spawn.mock.calls[0].arguments;
  assert.equal(opts.env.ROBIN_SESSION_PLATFORM, 'discord');
});
