import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CREDENTIAL_SOURCE_VARS } from './credentials/config.ts';
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

test('runSdk: a subtype-success result carrying is_error (usage-limit 429) maps to error', async () => {
  // Observed live 2026-06-12: a weekly-usage-limited account returns
  // subtype:'success' + is_error:true with the limit banner as text.
  const q = () =>
    fakeQuery([
      {
        type: 'result',
        subtype: 'success',
        is_error: true,
        api_error_status: 429,
        result: "You've hit your weekly limit · resets Jun 15 at 7am (America/Chicago)",
        total_cost_usd: 0,
        num_turns: 1,
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    ]);
  const r = await runSdk({ prompt: 'x', queryFn: q });
  assert.equal(r.status, 'error');
  assert.match(r.text, /hit your weekly limit/i);
});

test('runSdk: a subtype-success result whose text is the limit banner maps to error even without is_error', async () => {
  const q = () =>
    fakeQuery([
      {
        type: 'result',
        subtype: 'success',
        is_error: false,
        result: "You've hit your Sonnet limit · resets Jun 15 at 7am (America/Chicago)",
        total_cost_usd: 0,
        num_turns: 1,
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    ]);
  const r = await runSdk({ prompt: 'x', queryFn: q });
  assert.equal(r.status, 'error');
});

test('runSdk: structured output proves a real completion — banner-like text stays success', async () => {
  const q = () =>
    fakeQuery([
      {
        type: 'result',
        subtype: 'success',
        is_error: false,
        result: "You've hit your weekly limit · resets Jun 15 at 7am (America/Chicago)",
        structured_output: { ok: true },
        total_cost_usd: 0.01,
        num_turns: 1,
        usage: { input_tokens: 10, output_tokens: 2 },
      },
    ]);
  const r = await runSdk({ prompt: 'x', queryFn: q });
  assert.equal(r.status, 'success');
  assert.deepEqual(r.structured, { ok: true });
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

test('runSdk: loads NO settings sources unless project settings are requested', async () => {
  const seen: unknown[] = [];
  const q = (opts: { options?: { settingSources?: unknown } }) => {
    seen.push(opts.options?.settingSources);
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
  await runSdk({ prompt: 'x', queryFn: q });
  await runSdk({ prompt: 'x', queryFn: q, loadProjectSettings: true });
  // [] — not undefined, which the SDK reads as "user + project + local", running
  // the user's hooks (and the daemon-kickstarting SessionStart hook) per call.
  assert.deepEqual(seen, [[], ['project']]);
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
  // No model on the message → priced at the agentic default (Opus 5.5, $4/$20):
  // 12×4 + 3×0.4 + 4×20 = 129.2 µ$.
  assert.ok(Math.abs(r.costUsd - 129.2e-6) < 1e-12, `estimated cost, got ${r.costUsd}`);
  assert.equal(r.costEstimated, true);
  assert.equal(r.turns, 1);
});

test('runSdk: no-result fallback dedupes per message.id and estimates stub output from content', async () => {
  // Live SDK shape: each content block of one API turn is its own assistant
  // message repeating the same id + message_start usage (output_tokens a stub).
  const usage = {
    input_tokens: 2,
    cache_creation_input_tokens: 1000,
    cache_read_input_tokens: 10000,
    output_tokens: 8,
  };
  const q = () =>
    (async function* () {
      yield {
        type: 'assistant',
        message: {
          id: 'msg_a',
          model: 'claude-sonnet-4-6',
          usage,
          content: [{ type: 'text', text: 'x'.repeat(400) }],
        },
      };
      yield {
        type: 'assistant',
        message: {
          id: 'msg_a',
          model: 'claude-sonnet-4-6',
          usage,
          content: [{ type: 'tool_use', input: { q: 'y'.repeat(392) } }],
        },
      };
      // Stream ends with no result (deadline abort surfaced as a clean end).
    })();
  const r = await runSdk({ prompt: 'x', queryFn: q });
  assert.equal(r.status, 'error');
  assert.equal(r.costEstimated, true);
  assert.equal(r.turns, 1, 'two blocks of one turn are one turn');
  assert.equal(r.usage.inputTokens, 2, 'usage is not double-counted across blocks');
  assert.equal(r.usage.cachedInputTokens, 10000);
  // 400 + JSON {"q":"y…"} (392 + 8 = 400) chars → 200 tokens, beats the stub 8.
  assert.equal(r.usage.outputTokens, 200);
  // Sonnet $3/$15: 2×3 + 1000×3.75 + 10000×0.3 + 200×15 = 9756 µ$.
  assert.ok(Math.abs(r.costUsd - 9756e-6) < 1e-12, `got ${r.costUsd}`);
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

test('runSdk: forwards effort to the query options only when set', async () => {
  const seen: unknown[] = [];
  const q = (opts: { options?: Record<string, unknown> }) => {
    seen.push(opts.options && 'effort' in opts.options ? opts.options.effort : '<absent>');
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
  await runSdk({ prompt: 'x', queryFn: q, effort: 'low' });
  await runSdk({ prompt: 'x', queryFn: q });
  assert.deepEqual(seen, ['low', '<absent>']);
});

const OK_RESULT = {
  type: 'result',
  subtype: 'success',
  is_error: false,
  result: 'ok',
  total_cost_usd: 0,
  num_turns: 1,
  usage: { input_tokens: 1, output_tokens: 1 },
};

test('runSdk: captures the last rate_limit_event (resetsAt seconds -> ms)', async () => {
  const q = () =>
    fakeQuery([
      {
        type: 'rate_limit_event',
        rate_limit_info: { status: 'allowed', rateLimitType: 'five_hour', utilization: 0.1 },
      },
      {
        type: 'rate_limit_event',
        rate_limit_info: {
          status: 'allowed_warning',
          resetsAt: 1767225600,
          utilization: 0.91,
          rateLimitType: 'five_hour',
        },
      },
      OK_RESULT,
    ]);
  const r = await runSdk({ prompt: 'x', queryFn: q });
  assert.deepEqual(r.rateLimit, {
    status: 'allowed_warning',
    resetsAtMs: 1767225600000,
    utilization: 0.91,
    type: 'five_hour',
  });
  assert.equal(r.limitHit, false);
});

test('runSdk: a millisecond resetsAt is kept as-is', async () => {
  const q = () =>
    fakeQuery([
      {
        type: 'rate_limit_event',
        rate_limit_info: { status: 'allowed_warning', resetsAt: 1767225600000 },
      },
      OK_RESULT,
    ]);
  const r = await runSdk({ prompt: 'x', queryFn: q });
  assert.equal(r.rateLimit?.resetsAtMs, 1767225600000);
});

test('runSdk: no rate_limit_event leaves rateLimit undefined and limitHit false', async () => {
  const r = await runSdk({ prompt: 'x', queryFn: () => fakeQuery([OK_RESULT]) });
  assert.equal(r.rateLimit, undefined);
  assert.equal(r.limitHit, false);
  assert.equal(r.authError, undefined);
});

test('runSdk: captures authError from assistant messages, ignores rate_limit', async () => {
  const q = (error: string) => () =>
    fakeQuery([{ type: 'assistant', error, message: { content: [{ text: 'x' }] } }, OK_RESULT]);
  const a = await runSdk({ prompt: 'x', queryFn: q('authentication_failed') });
  assert.equal(a.authError, 'authentication_failed');
  const b = await runSdk({ prompt: 'x', queryFn: q('rate_limit') });
  assert.equal(b.authError, undefined);
});

test('runSdk: authError keeps the first one seen', async () => {
  const q = () =>
    fakeQuery([
      { type: 'assistant', error: 'billing_error', message: { content: [] } },
      { type: 'assistant', error: 'account_on_hold', message: { content: [] } },
      OK_RESULT,
    ]);
  const r = await runSdk({ prompt: 'x', queryFn: q });
  assert.equal(r.authError, 'billing_error');
});

test('runSdk: a rejected rate_limit_event sets limitHit, even on the no-result path', async () => {
  const events = [
    {
      type: 'rate_limit_event',
      rate_limit_info: { status: 'rejected', resetsAt: 1767225600, rateLimitType: 'seven_day' },
    },
  ];
  const withResult = await runSdk({
    prompt: 'x',
    queryFn: () => fakeQuery([...events, OK_RESULT]),
  });
  assert.equal(withResult.limitHit, true);
  const noResult = await runSdk({ prompt: 'x', queryFn: () => fakeQuery(events) });
  assert.equal(noResult.status, 'error');
  assert.equal(noResult.limitHit, true);
  const thrown = await runSdk({
    prompt: 'x',
    queryFn: () =>
      (async function* () {
        yield events[0];
        throw new Error('boom');
      })(),
  });
  assert.equal(thrown.limitHit, true);
  assert.equal(thrown.rateLimit?.status, 'rejected');
});

test('runSdk: no-result and throw paths have limitHit false without a rejected event', async () => {
  const none = await runSdk({ prompt: 'x', queryFn: () => fakeQuery([]) });
  assert.equal(none.limitHit, false);
  const thrown = await runSdk({
    prompt: 'x',
    queryFn: () =>
      (async function* () {
        yield* [];
        throw new Error('boom');
      })(),
  });
  assert.equal(thrown.limitHit, false);
});

test('runSdk: the usage-limit banner result sets limitHit', async () => {
  const q = () =>
    fakeQuery([
      {
        ...OK_RESULT,
        result: "You've hit your weekly limit · resets Jun 15 at 7am",
      },
    ]);
  const r = await runSdk({ prompt: 'x', queryFn: q });
  assert.equal(r.status, 'error');
  assert.equal(r.limitHit, true);
});

test('runSdk: an is_error result with api_error_status 429 sets limitHit', async () => {
  const q = () =>
    fakeQuery([{ ...OK_RESULT, is_error: true, api_error_status: 429, result: 'Too many' }]);
  const r = await runSdk({ prompt: 'x', queryFn: q });
  assert.equal(r.limitHit, true);
});

test('runSdk: credentialEnv is applied after the billToPool strip', async () => {
  let env: Record<string, string> | undefined;
  const q = (args: { options: { env: Record<string, string> } }) => {
    env = args.options.env;
    return fakeQuery([OK_RESULT]);
  };
  await runSdk({
    prompt: 'x',
    queryFn: q,
    billToPool: true,
    baseEnv: { ANTHROPIC_API_KEY: 'x', CLAUDE_CODE_OAUTH_TOKEN: 'old', PATH: '/b' },
    credentialEnv: {
      set: { CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-FAKE-robin' },
      unset: ['ANTHROPIC_API_KEY'],
    },
  });
  assert.deepEqual(env, {
    CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-FAKE-robin',
    PATH: '/b',
    ROBIN_INTERNAL_SDK: '1',
  });
});

test('runSdk: credentialEnv can set an API key even when billToPool strips it', async () => {
  let env: Record<string, string> | undefined;
  const q = (args: { options: { env: Record<string, string> } }) => {
    env = args.options.env;
    return fakeQuery([OK_RESULT]);
  };
  await runSdk({
    prompt: 'x',
    queryFn: q,
    billToPool: true,
    baseEnv: { PATH: '/b' },
    credentialEnv: { set: { ANTHROPIC_API_KEY: 'sk-ant-api03-FAKE-credit' }, unset: [] },
  });
  assert.equal(env?.ANTHROPIC_API_KEY, 'sk-ant-api03-FAKE-credit');
});

test('runSdk: no credentialEnv leaves the env unchanged', async () => {
  let env: Record<string, string> | undefined;
  const q = (args: { options: { env: Record<string, string> } }) => {
    env = args.options.env;
    return fakeQuery([OK_RESULT]);
  };
  await runSdk({
    prompt: 'x',
    queryFn: q,
    billToPool: true,
    baseEnv: { ANTHROPIC_API_KEY: 'x', CLAUDE_CODE_OAUTH_TOKEN: 'old', PATH: '/b' },
  });
  assert.deepEqual(env, {
    CLAUDE_CODE_OAUTH_TOKEN: 'old',
    PATH: '/b',
    ROBIN_INTERNAL_SDK: '1',
  });
});

test('runSdk: buildEnv never passes credential source vars', async () => {
  let env: Record<string, string> | undefined;
  const q = (args: { options: { env: Record<string, string> } }) => {
    env = args.options.env;
    return fakeQuery([OK_RESULT]);
  };
  await runSdk({
    prompt: 'x',
    queryFn: q,
    billToPool: true,
    baseEnv: {
      CLAUDE_TOKEN_ROBIN: 'sk-ant-oat01-FAKE-robin',
      CLAUDE_TOKEN_SHARED: 'sk-ant-oat01-FAKE-shared',
      CLAUDE_CREDIT_KEY_ROBIN: 'sk-ant-api03-FAKE-credit',
      CLAUDE_CREDIT_KEY_SHARED: 'sk-ant-api03-FAKE-credit-shared',
      PATH: '/b',
    },
    credentialEnv: {
      set: { CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-FAKE-robin' },
      unset: ['ANTHROPIC_API_KEY', 'CLAUDE_API_KEY'],
    },
  });
  for (const k of CREDENTIAL_SOURCE_VARS) assert.equal(k in (env ?? {}), false, k);
  assert.deepEqual(env, {
    CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-FAKE-robin',
    PATH: '/b',
    ROBIN_INTERNAL_SDK: '1',
  });
});

test('runSdk: credential source vars are stripped even without credentialEnv', async () => {
  let env: Record<string, string> | undefined;
  const q = (args: { options: { env: Record<string, string> } }) => {
    env = args.options.env;
    return fakeQuery([OK_RESULT]);
  };
  await runSdk({
    prompt: 'x',
    queryFn: q,
    baseEnv: { CLAUDE_TOKEN_SHARED: 'sk-ant-oat01-FAKE-shared', PATH: '/b' },
  });
  assert.deepEqual(env, { PATH: '/b', ROBIN_INTERNAL_SDK: '1' });
});
