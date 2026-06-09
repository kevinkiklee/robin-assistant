import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AnthropicProvider } from './anthropic.ts';

/** Build a Response-like object the provider's fetch path understands. */
function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** A successful Anthropic Messages API payload. */
function messagesOk(opts?: {
  text?: string;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
}) {
  return {
    id: 'msg_1',
    type: 'message',
    role: 'assistant',
    content: [{ type: 'text', text: opts?.text ?? 'hello' }],
    model: 'claude-fable-5',
    usage: {
      input_tokens: opts?.inputTokens ?? 1_000_000,
      output_tokens: opts?.outputTokens ?? 1_000_000,
      ...(opts?.cacheReadTokens !== undefined
        ? { cache_read_input_tokens: opts.cacheReadTokens }
        : {}),
    },
  };
}

/** Swap in a fake fetch for the duration of `fn`, then restore the original. */
async function withFetch(
  fake: typeof fetch,
  fn: () => Promise<void>,
): Promise<{ calls: Array<{ url: string; init: RequestInit }> }> {
  const original = globalThis.fetch;
  const calls: Array<{ url: string; init: RequestInit }> = [];
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return fake(url, init);
  }) as typeof fetch;
  try {
    await fn();
  } finally {
    globalThis.fetch = original;
  }
  return { calls };
}

test('anthropic: invoke parses text + usage + computes cost', async () => {
  const p = new AnthropicProvider({ apiKey: 'test', model: 'claude-fable-5' });
  let result: Awaited<ReturnType<typeof p.invoke>> | undefined;
  await withFetch(
    async () => jsonResponse(200, messagesOk()),
    async () => {
      result = await p.invoke({ messages: [{ role: 'user', content: 'hi' }] });
    },
  );
  assert.ok(result);
  assert.equal(result.text, 'hello');
  assert.equal(result.usage.inputTokens, 1_000_000);
  assert.equal(result.usage.outputTokens, 1_000_000);
  assert.equal(result.provider, 'anthropic');
  // 1M input @ $10/M + 1M output @ $50/M = $60
  assert.ok(Math.abs(result.costUsd - 60) < 0.01, `cost was ${result.costUsd}`);
});

test('anthropic: concatenates multiple text blocks', async () => {
  const p = new AnthropicProvider({ apiKey: 'test' });
  let result: Awaited<ReturnType<typeof p.invoke>> | undefined;
  await withFetch(
    async () =>
      jsonResponse(200, {
        content: [
          { type: 'text', text: 'foo' },
          { type: 'thinking', text: 'IGNORED' },
          { type: 'text', text: 'bar' },
        ],
        usage: { input_tokens: 10, output_tokens: 5 },
      }),
    async () => {
      result = await p.invoke({ messages: [{ role: 'user', content: 'hi' }] });
    },
  );
  assert.ok(result);
  assert.equal(result.text, 'foobar');
});

test('anthropic: system prompt is sent top-level (not a message) with cache_control', async () => {
  const p = new AnthropicProvider({ apiKey: 'test' });
  const { calls } = await withFetch(
    async () => jsonResponse(200, messagesOk()),
    async () => {
      await p.invoke({
        systemPrompt: 'You are Robin.',
        messages: [{ role: 'user', content: 'hi' }],
        cacheable: true,
      });
    },
  );
  const body = JSON.parse(String(calls[0].init.body));
  // No system role in the messages array.
  assert.ok(Array.isArray(body.messages));
  assert.equal(body.messages.length, 1);
  assert.equal(body.messages[0].role, 'user');
  assert.ok(!body.messages.some((m: { role: string }) => m.role === 'system'));
  // System is top-level, structured with cache_control.
  assert.ok(Array.isArray(body.system));
  assert.equal(body.system[0].type, 'text');
  assert.equal(body.system[0].text, 'You are Robin.');
  assert.deepEqual(body.system[0].cache_control, { type: 'ephemeral' });
});

test('anthropic: sends required headers', async () => {
  const p = new AnthropicProvider({ apiKey: 'sk-test' });
  const { calls } = await withFetch(
    async () => jsonResponse(200, messagesOk()),
    async () => {
      await p.invoke({ messages: [{ role: 'user', content: 'hi' }] });
    },
  );
  assert.equal(calls[0].url, 'https://api.anthropic.com/v1/messages');
  const headers = calls[0].init.headers as Record<string, string>;
  assert.equal(headers['x-api-key'], 'sk-test');
  assert.equal(headers['anthropic-version'], '2023-06-01');
  assert.equal(headers['content-type'], 'application/json');
});

test('anthropic: max_tokens defaults to a bounded value when req.maxTokens unset', async () => {
  const p = new AnthropicProvider({ apiKey: 'test' });
  const { calls } = await withFetch(
    async () => jsonResponse(200, messagesOk()),
    async () => {
      await p.invoke({ messages: [{ role: 'user', content: 'hi' }] });
    },
  );
  const body = JSON.parse(String(calls[0].init.body));
  assert.equal(body.max_tokens, 4096);
});

// Regression — Fable 5 and Opus 4.7+ removed `temperature` and return HTTP 400
// if it's sent, even temperature:0 (verified live on Opus 4.7 2026-05-24). The
// adapter must NOT include it in the request body, regardless of what the
// caller passes.
test('anthropic: never sends temperature (Fable 5 / Opus 4.7+ reject it)', async () => {
  const p = new AnthropicProvider({ apiKey: 'test' });
  const { calls } = await withFetch(
    async () => jsonResponse(200, messagesOk()),
    async () => {
      await p.invoke({ messages: [{ role: 'user', content: 'hi' }], temperature: 0 });
    },
  );
  const body = JSON.parse(String(calls[0].init.body));
  assert.ok(!('temperature' in body), 'temperature must be omitted from the request body');
});

test('anthropic: respects explicit req.maxTokens', async () => {
  const p = new AnthropicProvider({ apiKey: 'test' });
  const { calls } = await withFetch(
    async () => jsonResponse(200, messagesOk()),
    async () => {
      await p.invoke({ messages: [{ role: 'user', content: 'hi' }], maxTokens: 256 });
    },
  );
  const body = JSON.parse(String(calls[0].init.body));
  assert.equal(body.max_tokens, 256);
});

test('anthropic: cache_read_input_tokens billed at 10% in costUsd', async () => {
  const p = new AnthropicProvider({ apiKey: 'test' });
  let result: Awaited<ReturnType<typeof p.invoke>> | undefined;
  await withFetch(
    // Anthropic reports `input_tokens` (uncached) separately from
    // `cache_read_input_tokens`. Here the whole 1M prompt was a cache hit:
    // input_tokens=0, cache_read=1M, output=0.
    async () =>
      jsonResponse(
        200,
        messagesOk({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 1_000_000 }),
      ),
    async () => {
      result = await p.invoke({ messages: [{ role: 'user', content: 'hi' }] });
    },
  );
  assert.ok(result);
  assert.equal(result.usage.cachedInputTokens, 1_000_000);
  // 1M cached input @ 10% of $10/M = $1.00 (no uncached input, no output).
  assert.ok(Math.abs(result.costUsd - 1.0) < 0.01, `cost was ${result.costUsd}`);
});

test('anthropic: retries on 429 then succeeds', async () => {
  const p = new AnthropicProvider({ apiKey: 'test', sleep: async () => {} });
  let attempts = 0;
  const { calls } = await withFetch(
    async () => {
      attempts += 1;
      if (attempts === 1) return jsonResponse(429, { error: 'rate limited' });
      return jsonResponse(200, messagesOk({ text: 'recovered' }));
    },
    async () => {
      const r = await p.invoke({ messages: [{ role: 'user', content: 'hi' }] });
      assert.equal(r.text, 'recovered');
    },
  );
  assert.equal(calls.length, 2);
});

test('anthropic: throws with status after exhausting retries on persistent 500', async () => {
  const p = new AnthropicProvider({ apiKey: 'test', sleep: async () => {}, maxRetries: 4 });
  let attempts = 0;
  await withFetch(
    async () => {
      attempts += 1;
      return jsonResponse(500, { error: 'server error' });
    },
    async () => {
      await assert.rejects(p.invoke({ messages: [{ role: 'user', content: 'hi' }] }), /500/);
    },
  );
  // initial attempt + retries
  assert.equal(attempts, 4);
});

test('anthropic: does NOT retry on 400', async () => {
  const p = new AnthropicProvider({ apiKey: 'test', sleep: async () => {} });
  let attempts = 0;
  await withFetch(
    async () => {
      attempts += 1;
      return jsonResponse(400, { error: 'bad request' });
    },
    async () => {
      await assert.rejects(p.invoke({ messages: [{ role: 'user', content: 'hi' }] }), /400/);
    },
  );
  assert.equal(attempts, 1);
});
