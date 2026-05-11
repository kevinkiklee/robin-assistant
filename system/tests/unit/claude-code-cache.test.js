import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import { createClaudeCodeAdapter } from '../../src/hosts/claude-code.js';

// The Claude Code CLI takes a single positional prompt under `-p`. Unlike
// the v1 SDK call, `cache_control: { type: 'ephemeral' }` is not a CLI
// surface — Claude Code manages prompt caching transparently across
// invocations. These tests pin the contract that system messages flow
// into the concatenated prompt so callers don't lose system context when
// they migrate from the v1 SDK shape.

function captureArgsSpawn({ stdout = '', exitCode = 0 } = {}) {
  let lastArgs = null;
  const fn = mock.fn((_cmd, args) => {
    lastArgs = args;
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
  fn.getLastArgs = () => lastArgs;
  return fn;
}

function getPromptArg(args) {
  // The prompt is the positional arg directly after `-p`.
  const i = args.indexOf('-p');
  assert.ok(i >= 0, `-p not in args: ${args}`);
  return args[i + 1];
}

test('Claude adapter concatenates multiple system messages into the prompt', async () => {
  const stdout = JSON.stringify({
    type: 'result',
    result: 'ok',
    usage: { input_tokens: 0, output_tokens: 0 },
  });
  const fakeSpawn = captureArgsSpawn({ stdout });
  const adapter = createClaudeCodeAdapter({ spawn: fakeSpawn });

  await adapter.invokeLLM([{ role: 'user', content: 'q' }], {
    system: [
      { role: 'system', content: 'sys-prompt-1', cache_control: { type: 'ephemeral' } },
      { role: 'system', content: 'sys-prompt-2' },
    ],
  });

  const prompt = getPromptArg(fakeSpawn.getLastArgs());
  // Both system contents must appear in the prompt; user content too.
  assert.ok(prompt.includes('sys-prompt-1'), `prompt missing sys-prompt-1: ${prompt}`);
  assert.ok(prompt.includes('sys-prompt-2'), `prompt missing sys-prompt-2: ${prompt}`);
  assert.ok(prompt.includes('USER: q'), `prompt missing USER turn: ${prompt}`);
});

test('Claude adapter omits system text cleanly when no system messages', async () => {
  const stdout = JSON.stringify({
    type: 'result',
    result: 'ok',
    usage: { input_tokens: 0, output_tokens: 0 },
  });
  const fakeSpawn = captureArgsSpawn({ stdout });
  const adapter = createClaudeCodeAdapter({ spawn: fakeSpawn });

  await adapter.invokeLLM([{ role: 'user', content: 'q' }], { tier: 'fast' });

  const prompt = getPromptArg(fakeSpawn.getLastArgs());
  // With no system messages, the prompt is just the conversation.
  assert.equal(prompt, 'USER: q');
});
