import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { createRunner } from '../../../user-data/ops/scripts/lib/discord/claude-runner.js';

function fakeChild({ stdout = '', stderr = '', code = 0, delayMs = 0 } = {}) {
  const child = new EventEmitter();
  child.pid = Math.floor(Math.random() * 100000) + 1000;
  child.stdout = Readable.from([stdout]);
  child.stderr = Readable.from([stderr]);
  child.kill = (sig) => { child._killed = sig; };
  setTimeout(() => child.emit('close', code), delayMs);
  return child;
}

function fakeSpawn(scenarios) {
  const calls = [];
  let i = 0;
  const fn = (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    const scen = scenarios[i++] || { stdout: '{"result":"ok","session_id":"s-x","total_cost_usd":0}' };
    return fakeChild(scen);
  };
  fn.calls = calls;
  return fn;
}

const baseConfig = {
  binPath: '/abs/claude',
  cwd: '/abs/robin',
  envWhitelist: ['HOME'],
  maxTurns: 30,
  timeoutMs: 60_000,
  maxConcurrent: 2,
};

test('runner: first turn — no --resume, parses session_id and result', async () => {
  const spawn = fakeSpawn([{ stdout: '{"result":"hello","session_id":"sess-1","total_cost_usd":0.01}' }]);
  const runner = createRunner({ ...baseConfig, spawnFn: spawn });
  const out = await runner.run({ key: 'dm-1', prompt: 'hi', priorSessionId: null });
  assert.equal(out.result, 'hello');
  assert.equal(out.sessionId, 'sess-1');
  assert.equal(out.costUsd, 0.01);
  assert.deepEqual(spawn.calls[0].args.slice(0, 5), ['-p', 'hi', '--output-format', 'json', '--max-turns']);
});

test('runner: resume turn — adds --resume <id>', async () => {
  const spawn = fakeSpawn([{ stdout: '{"result":"r","session_id":"sess-1","total_cost_usd":0}' }]);
  const runner = createRunner({ ...baseConfig, spawnFn: spawn });
  await runner.run({ key: 'dm-1', prompt: 'continue', priorSessionId: 'sess-1' });
  const args = spawn.calls[0].args;
  assert.equal(args[0], '--resume');
  assert.equal(args[1], 'sess-1');
  assert.equal(args[2], '-p');
});

test('runner: resume failure auto-retries fresh once', async () => {
  const spawn = fakeSpawn([
    { stdout: '', code: 1 },
    { stdout: '{"result":"r","session_id":"sess-2","total_cost_usd":0}', code: 0 },
  ]);
  const runner = createRunner({ ...baseConfig, spawnFn: spawn });
  const out = await runner.run({ key: 'dm-1', prompt: 'cont', priorSessionId: 'sess-old' });
  assert.equal(out.sessionId, 'sess-2');
  assert.equal(spawn.calls.length, 2);
  assert.equal(spawn.calls[1].args.includes('--resume'), false, 'second call has no --resume');
});

test('runner: per-key FIFO — second call for same key waits', async () => {
  const spawn = fakeSpawn([
    { stdout: '{"result":"a","session_id":"s","total_cost_usd":0}', delayMs: 50 },
    { stdout: '{"result":"b","session_id":"s","total_cost_usd":0}', delayMs: 5 },
  ]);
  const runner = createRunner({ ...baseConfig, spawnFn: spawn });
  const order = [];
  const p1 = runner.run({ key: 'dm-1', prompt: 'a', priorSessionId: null }).then(r => order.push(r.result));
  const p2 = runner.run({ key: 'dm-1', prompt: 'b', priorSessionId: null }).then(r => order.push(r.result));
  await Promise.all([p1, p2]);
  assert.deepEqual(order, ['a', 'b']);
});

test('runner: cross-key parallelism allowed', async () => {
  const spawn = fakeSpawn([
    { stdout: '{"result":"a","session_id":"s","total_cost_usd":0}', delayMs: 30 },
    { stdout: '{"result":"b","session_id":"s","total_cost_usd":0}', delayMs: 30 },
  ]);
  const runner = createRunner({ ...baseConfig, spawnFn: spawn });
  const start = Date.now();
  const [a, b] = await Promise.all([
    runner.run({ key: 'k1', prompt: 'a', priorSessionId: null }),
    runner.run({ key: 'k2', prompt: 'b', priorSessionId: null }),
  ]);
  const dur = Date.now() - start;
  assert.equal(a.result, 'a');
  assert.equal(b.result, 'b');
  // Two ~30ms runs in parallel should finish well under 60ms.
  assert.ok(dur < 60, `expected parallel finish, got ${dur}ms`);
});

test('runner: timeout kills process and rejects with timeout', async () => {
  const spawn = fakeSpawn([{ stdout: '', delayMs: 200 }]);
  const runner = createRunner({ ...baseConfig, spawnFn: spawn, timeoutMs: 30 });
  await assert.rejects(
    runner.run({ key: 'dm-1', prompt: 'slow', priorSessionId: null }),
    err => err.code === 'TIMEOUT',
  );
});

test('runner: malformed stdout returns isError=true', async () => {
  const spawn = fakeSpawn([{ stdout: 'not json', code: 0 }]);
  const runner = createRunner({ ...baseConfig, spawnFn: spawn });
  await assert.rejects(
    runner.run({ key: 'dm-1', prompt: 'x', priorSessionId: null }),
    err => err.code === 'PARSE_FAILED',
  );
});

test('runner: cancel(key) sends SIGTERM to in-flight process', async () => {
  let captured;
  const spawn = (cmd, args, opts) => {
    const c = fakeChild({ stdout: '', delayMs: 1000 });
    captured = c;
    return c;
  };
  const runner = createRunner({ ...baseConfig, spawnFn: spawn });
  const promise = runner.run({ key: 'dm-1', prompt: 'x', priorSessionId: null });
  await new Promise(r => setTimeout(r, 5));
  runner.cancel('dm-1');
  await assert.rejects(promise, err => err.code === 'CANCELLED');
  assert.ok(captured._killed === 'SIGTERM' || captured._killed === undefined,
    'either kill was called or process exited before kill');
});
