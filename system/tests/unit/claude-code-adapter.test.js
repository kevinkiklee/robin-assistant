import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import { createClaudeCodeAdapter } from '../../runtime/hosts/claude-code.js';

// Note on test technique: Node 22's `mock.module()` requires the
// `--experimental-test-module-mocks` flag and cannot redefine the same
// module across multiple tests in a run (ERR_INVALID_STATE). To keep the
// behaviors covered while staying on stable Node APIs, the adapter
// exposes a `createClaudeCodeAdapter({ spawn })` factory that takes the
// spawn dependency by injection. The default `claudeCodeAdapter` export
// is built from the real `node:child_process` spawn.

function makeFakeSpawn(stdout, exitCode = 0) {
  return mock.fn(() => {
    const stdoutHandlers = [];
    const exitHandlers = [];
    return {
      stdout: {
        on: (event, cb) => {
          if (event === 'data') stdoutHandlers.push(cb);
          setImmediate(() => {
            for (const fn of stdoutHandlers) fn(Buffer.from(stdout));
          });
        },
      },
      stderr: { on: () => {} },
      stdin: { write: () => {}, end: () => {} },
      on: (event, cb) => {
        if (event === 'exit') exitHandlers.push(cb);
        setImmediate(() => {
          for (const fn of exitHandlers) fn(exitCode);
        });
      },
    };
  });
}

function makeErroringSpawn(error) {
  return mock.fn(() => ({
    stdout: { on: () => {} },
    stderr: { on: () => {} },
    stdin: { write: () => {}, end: () => {} },
    on: (event, cb) => {
      if (event === 'error') setImmediate(() => cb(error));
    },
  }));
}

test('claudeCodeAdapter.invokeLLM spawns claude CLI and parses JSON envelope', async () => {
  // Real `claude -p --output-format=json` envelope shape.
  const stdout = JSON.stringify({
    type: 'result',
    result: '{"ok":true}',
    usage: { input_tokens: 10, output_tokens: 5 },
  });
  const fakeSpawn = makeFakeSpawn(stdout, 0);
  const adapter = createClaudeCodeAdapter({ spawn: fakeSpawn });

  const result = await adapter.invokeLLM([{ role: 'user', content: 'hi' }], {
    tier: 'fast',
    json: true,
  });
  assert.equal(result.content, '{"ok":true}');
  assert.equal(result.usage.input_tokens, 10);
  assert.equal(result.usage.output_tokens, 5);
  assert.equal(fakeSpawn.mock.callCount(), 1);
  const [cmd, args] = fakeSpawn.mock.calls[0].arguments;
  assert.equal(cmd, 'claude');
  assert.ok(args.includes('-p'), `args missing -p: ${args}`);
  assert.ok(args.includes('--output-format=json'), `args missing --output-format=json: ${args}`);
  assert.ok(args.includes('--model'), `args missing --model: ${args}`);
});

test('claudeCodeAdapter.invokeLLM rejects when claude exits non-zero', async () => {
  const fakeSpawn = makeFakeSpawn('', 1);
  const adapter = createClaudeCodeAdapter({ spawn: fakeSpawn });
  await assert.rejects(
    adapter.invokeLLM([{ role: 'user', content: 'hi' }], { tier: 'fast' }),
    /claude exited 1/,
  );
});

test('claudeCodeAdapter.isAvailable returns true when claude --version exits 0', async () => {
  const fakeSpawn = makeFakeSpawn('claude 1.0\n', 0);
  const adapter = createClaudeCodeAdapter({ spawn: fakeSpawn });
  const ok = await adapter.isAvailable();
  assert.equal(ok, true);
});

test('claudeCodeAdapter.isAvailable returns false when claude is not on PATH', async () => {
  const fakeSpawn = makeErroringSpawn(new Error('ENOENT'));
  const adapter = createClaudeCodeAdapter({ spawn: fakeSpawn });
  const ok = await adapter.isAvailable();
  assert.equal(ok, false);
});

test('claudeCodeAdapter.name is claude-code', async () => {
  const fakeSpawn = makeFakeSpawn('', 0);
  const adapter = createClaudeCodeAdapter({ spawn: fakeSpawn });
  assert.equal(adapter.name, 'claude-code');
});

// Spawn that never exits on its own; only `kill()` resolves the exit handler.
// Lets us test the abort path without relying on real subprocess timing.
function makeHangingSpawn() {
  let killed = false;
  const proc = {
    stdout: { on: () => {} },
    stderr: { on: () => {} },
    stdin: { write: () => {}, end: () => {} },
    _exitHandlers: [],
    on(event, cb) {
      if (event === 'exit') this._exitHandlers.push(cb);
    },
    kill() {
      killed = true;
      // Real `kill('SIGKILL')` causes node to fire 'exit' with code=null and
      // signal='SIGKILL'. runClaude's onExit listener checks `aborted` and
      // returns early in that case, so the code value doesn't matter here.
      setImmediate(() => {
        for (const fn of this._exitHandlers) fn(null);
      });
    },
  };
  const spawn = mock.fn(() => proc);
  return { spawn, wasKilled: () => killed };
}

test('claudeCodeAdapter.invokeLLM aborts via signal: rejects + kills subprocess', async () => {
  const { spawn, wasKilled } = makeHangingSpawn();
  const adapter = createClaudeCodeAdapter({ spawn });
  const ac = new AbortController();

  const callPromise = adapter.invokeLLM([{ role: 'user', content: 'hi' }], {
    tier: 'fast',
    signal: ac.signal,
  });
  // Tick so the spawn + signal listener attach before we abort.
  await new Promise((r) => setImmediate(r));
  ac.abort();

  await assert.rejects(callPromise, /aborted/);
  assert.equal(wasKilled(), true, 'expected proc.kill() to have been called');
});

test('claudeCodeAdapter.invokeLLM rejects immediately if signal is pre-aborted', async () => {
  const { spawn } = makeHangingSpawn();
  const adapter = createClaudeCodeAdapter({ spawn });
  const ac = new AbortController();
  ac.abort();

  await assert.rejects(
    adapter.invokeLLM([{ role: 'user', content: 'hi' }], { tier: 'fast', signal: ac.signal }),
    /aborted/,
  );
  // Spawn should not even have been called.
  assert.equal(spawn.mock.callCount(), 0);
});
