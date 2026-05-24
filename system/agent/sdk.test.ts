import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runSdk, type SdkResult } from './sdk.ts';

// Fake query: async-iterable of SDK messages, mirrors the live result shape.
function fakeQuery(messages: unknown[]) {
  return (async function* () {
    for (const m of messages) yield m;
  })();
}

test('runSdk: extracts text + usage + cost from the result message', async () => {
  const q = () =>
    fakeQuery([
      { type: 'assistant', message: { content: [{ text: 'hi' }] } },
      {
        type: 'result',
        subtype: 'success',
        is_error: false,
        result: 'hi',
        total_cost_usd: 0.01,
        num_turns: 1,
        usage: { input_tokens: 10, output_tokens: 2 },
      },
    ]);
  const r: SdkResult = await runSdk({ prompt: 'x', queryFn: q });
  assert.equal(r.status, 'success');
  assert.equal(r.text, 'hi');
  assert.equal(r.costUsd, 0.01);
  assert.equal(r.usage.inputTokens, 10);
  assert.equal(r.turns, 1);
});

test('runSdk: maps error subtypes to status', async () => {
  const q = () =>
    fakeQuery([
      {
        type: 'result',
        subtype: 'error_max_turns',
        is_error: true,
        total_cost_usd: 0.02,
        num_turns: 30,
        usage: { input_tokens: 5, output_tokens: 1 },
      },
    ]);
  const r = await runSdk({ prompt: 'x', queryFn: q });
  assert.equal(r.status, 'max_turns');
  assert.equal(r.costUsd, 0.02);
});

test('runSdk: strips API-key env vars to force subscription billing', async () => {
  let seenEnv: Record<string, string> | undefined;
  const q = (opts: { options?: { env?: Record<string, string> } }) => {
    seenEnv = opts.options?.env;
    return fakeQuery([
      {
        type: 'result',
        subtype: 'success',
        is_error: false,
        result: 'ok',
        total_cost_usd: 0,
        num_turns: 1,
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    ]);
  };
  await runSdk({
    prompt: 'x',
    queryFn: q,
    billToPool: true,
    baseEnv: { ANTHROPIC_API_KEY: 'sk-leak', CLAUDE_API_KEY: 'leak', PATH: '/usr/bin' },
  });
  assert.equal(seenEnv?.ANTHROPIC_API_KEY, undefined);
  assert.equal(seenEnv?.CLAUDE_API_KEY, undefined);
  assert.equal(seenEnv?.PATH, '/usr/bin');
});
