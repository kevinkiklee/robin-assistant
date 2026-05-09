import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import { createGeminiAdapter } from '../../src/hosts/gemini.js';

// Note on test technique: same dependency-injection factory pattern as the
// Claude Code adapter — `createGeminiAdapter({ spawn })` accepts a fake
// `spawn` so we can exercise the subprocess wiring without launching the
// real `gemini` binary. The default `geminiAdapter` export is built from
// the real `node:child_process` spawn.
//
// Note on envelope shape: per the spike note at
// docs/superpowers/specs/2026-05-09-gemini-host-adapter-spike.md, the
// real Gemini CLI returns `stats.models` as an OBJECT keyed by model name
// (not an array), and the output-token field is `candidates` (not
// `output`). Test fixtures and the adapter both follow that real shape.

function fakeSpawnFactory({ stdout = '', exitCode = 0, errorOnSpawn = null } = {}) {
  return mock.fn(() => {
    if (errorOnSpawn) {
      return {
        stdout: { on: () => {} },
        stderr: { on: () => {} },
        stdin: { write: () => {}, end: () => {} },
        on: (event, cb) => {
          if (event === 'error') setImmediate(() => cb(errorOnSpawn));
        },
      };
    }
    return {
      stdout: {
        on: (event, cb) => {
          if (event === 'data') setImmediate(() => cb(Buffer.from(stdout)));
        },
      },
      stderr: { on: () => {} },
      stdin: { write: () => {}, end: () => {} },
      on: (event, cb) => {
        if (event === 'exit') setImmediate(() => cb(exitCode));
      },
    };
  });
}

test('geminiAdapter.invokeLLM spawns gemini -p -o json and parses response', async () => {
  const envelope = JSON.stringify({
    session_id: 'sess-1',
    response: '{"ok":true}',
    stats: {
      models: {
        'gemini-2.5-flash-lite': {
          tokens: { prompt: 100, cached: 0, candidates: 5 },
        },
        'gemini-2.5-flash': {
          tokens: { prompt: 200, cached: 50, candidates: 12 },
        },
      },
    },
  });
  const fakeSpawn = fakeSpawnFactory({ stdout: envelope });
  const adapter = createGeminiAdapter({ spawn: fakeSpawn });
  const result = await adapter.invokeLLM([{ role: 'user', content: 'hi' }], {
    tier: 'fast',
    json: true,
  });
  assert.equal(result.content, '{"ok":true}');
  // Total tokens summed across models
  assert.equal(result.usage.input_tokens, 300);
  assert.equal(result.usage.output_tokens, 17);
  assert.equal(result.usage.cache_read_tokens, 50);
  assert.equal(fakeSpawn.mock.callCount(), 1);
  const [cmd, args] = fakeSpawn.mock.calls[0].arguments;
  assert.equal(cmd, 'gemini');
  assert.ok(args.includes('-p'), `expected -p in args; got ${args.join(' ')}`);
  assert.ok(
    args.includes('-o') && args.includes('json'),
    `expected -o json in args; got ${args.join(' ')}`,
  );
});

test('geminiAdapter.invokeLLM rejects when gemini exits non-zero', async () => {
  const fakeSpawn = fakeSpawnFactory({ stdout: '', exitCode: 2 });
  const adapter = createGeminiAdapter({ spawn: fakeSpawn });
  await assert.rejects(
    adapter.invokeLLM([{ role: 'user', content: 'hi' }], { tier: 'fast' }),
    /gemini exited 2/,
  );
});

test('geminiAdapter.invokeLLM rejects when stdout is not parseable JSON', async () => {
  const fakeSpawn = fakeSpawnFactory({ stdout: 'not valid json' });
  const adapter = createGeminiAdapter({ spawn: fakeSpawn });
  await assert.rejects(
    adapter.invokeLLM([{ role: 'user', content: 'hi' }], { tier: 'fast' }),
    /JSON|parse/i,
  );
});

test('geminiAdapter.isAvailable returns true when gemini --version exits 0', async () => {
  const fakeSpawn = fakeSpawnFactory({ stdout: 'gemini 0.37.1\n', exitCode: 0 });
  const adapter = createGeminiAdapter({ spawn: fakeSpawn });
  assert.equal(await adapter.isAvailable(), true);
});

test('geminiAdapter.isAvailable returns false when gemini is not on PATH', async () => {
  const fakeSpawn = fakeSpawnFactory({ errorOnSpawn: new Error('ENOENT') });
  const adapter = createGeminiAdapter({ spawn: fakeSpawn });
  assert.equal(await adapter.isAvailable(), false);
});

test('geminiAdapter.name is gemini_cli', async () => {
  const adapter = createGeminiAdapter({ spawn: fakeSpawnFactory({}) });
  assert.equal(adapter.name, 'gemini_cli');
});

test('geminiAdapter spawns with neutral cwd to avoid v1 hooks', async () => {
  const fakeSpawn = fakeSpawnFactory({
    stdout: JSON.stringify({ response: 'x', stats: { models: {} } }),
  });
  const adapter = createGeminiAdapter({ spawn: fakeSpawn });
  await adapter.invokeLLM([{ role: 'user', content: 'q' }], { tier: 'fast' });
  const callOpts = fakeSpawn.mock.calls[0].arguments[2];
  // cwd should be set (not undefined / not the v1 dir)
  assert.ok(callOpts.cwd, 'expected cwd to be set explicitly');
  assert.ok(!String(callOpts.cwd).includes('robin-assistant/'), 'cwd should not be v1');
});
