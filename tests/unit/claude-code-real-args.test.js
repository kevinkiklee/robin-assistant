import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import { createClaudeCodeAdapter } from '../../src/hosts/claude-code.js';

function captureSpawn(stdout) {
  const calls = [];
  const fakeSpawn = mock.fn((cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    return {
      stdout: { on: (e, cb) => e === 'data' && setImmediate(() => cb(Buffer.from(stdout))) },
      stderr: { on: () => {} },
      stdin: { write: () => {}, end: () => {} },
      on: (event, cb) => {
        if (event === 'exit') setImmediate(() => cb(0));
      },
    };
  });
  return { fakeSpawn, calls };
}

test('claude adapter spawns `claude -p <prompt>` with JSON output flag', async () => {
  const envelope = JSON.stringify({
    type: 'result',
    result: '{"ok":true}',
    usage: { input_tokens: 12, output_tokens: 4 },
  });
  const { fakeSpawn, calls } = captureSpawn(envelope);
  const adapter = createClaudeCodeAdapter({ spawn: fakeSpawn });
  const r = await adapter.invokeLLM([{ role: 'user', content: 'hi' }], {
    tier: 'fast',
    json: true,
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].cmd, 'claude');
  assert.ok(calls[0].args.includes('-p'), `args missing -p: ${calls[0].args}`);
  assert.ok(
    calls[0].args.includes('--output-format=json') ||
      calls[0].args.includes('-o') ||
      calls[0].args.includes('json'),
    `args missing JSON output flag: ${calls[0].args}`,
  );
  assert.equal(r.content, '{"ok":true}');
  assert.equal(r.usage.input_tokens, 12);
  assert.equal(r.usage.output_tokens, 4);
});
