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

test('runSdk: forwards sandbox settings to the query options', async () => {
  let seenSandbox: unknown;
  const q = (opts: { options?: { sandbox?: unknown } }) => {
    seenSandbox = opts.options?.sandbox;
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
  const sandbox = { enabled: true, autoAllowBashIfSandboxed: true, failIfUnavailable: true };
  await runSdk({ prompt: 'x', queryFn: q, sandbox });
  assert.deepEqual(seenSandbox, sandbox);
});

test('runSdk: a mid-stream throw surfaces accumulated partial usage, not zero', async () => {
  const q = () =>
    (async function* () {
      yield {
        type: 'assistant',
        message: { usage: { input_tokens: 12, output_tokens: 4, cache_read_input_tokens: 3 } },
      };
      throw new Error('aborted');
    })();
  const r = await runSdk({ prompt: 'x', queryFn: q });
  assert.equal(r.status, 'error');
  assert.equal(r.usage.inputTokens, 12, 'partial input tokens must survive the throw');
  assert.equal(r.usage.outputTokens, 4);
  assert.equal(r.usage.cachedInputTokens, 3);
  assert.equal(r.costUsd, 0, 'USD is best-effort: 0 when no result message arrived');
});

test('runSdk: a result message before a throw still wins over accumulated usage', async () => {
  const q = () =>
    (async function* () {
      yield { type: 'assistant', message: { usage: { input_tokens: 5, output_tokens: 1 } } };
      yield {
        type: 'result',
        subtype: 'success',
        is_error: false,
        result: 'done',
        total_cost_usd: 0.03,
        num_turns: 2,
        usage: { input_tokens: 20, output_tokens: 8 },
      };
      throw new Error('late throw after result');
    })();
  const r = await runSdk({ prompt: 'x', queryFn: q });
  assert.equal(r.status, 'success');
  assert.equal(r.costUsd, 0.03);
  assert.equal(r.usage.inputTokens, 20, 'authoritative result usage wins over the running tally');
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

test('runSdk: marks SDK children as Robin-internal so capture hooks can skip them', async () => {
  // Every runSdk child is one of Robin's own LLM calls, never a user session.
  // Without this marker the SessionEnd capture hook ingests each call as a
  // session.captured event — observed live 2026-06-12: 16k+ junk captures of
  // the biographer's own disambiguation prompts, self-amplifying (the
  // biographer then re-processes its own captured prompts with more SDK calls).
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
  await runSdk({ prompt: 'x', queryFn: q, baseEnv: { PATH: '/usr/bin' } });
  assert.equal(seenEnv?.ROBIN_INTERNAL_SDK, '1');
});
