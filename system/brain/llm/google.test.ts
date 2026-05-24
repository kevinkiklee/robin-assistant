import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { z } from 'zod';
import { GoogleProvider } from './google.ts';

type FetchCall = { url: string; init: RequestInit | undefined };

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

/**
 * Install a fetch mock that returns queued responses in order. Each entry is
 * either a {status, body} pair or a function producing one. Captured calls are
 * pushed onto `calls`.
 */
function mockFetch(responses: Array<{ status?: number; body: unknown }>, calls: FetchCall[]): void {
  let i = 0;
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    const r = responses[Math.min(i, responses.length - 1)];
    i += 1;
    const status = r.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      async json() {
        return r.body;
      },
      async text() {
        return JSON.stringify(r.body);
      },
    } as Response;
  }) as typeof fetch;
}

function bodyOf(call: FetchCall): Record<string, unknown> {
  return JSON.parse(String(call.init?.body)) as Record<string, unknown>;
}

const zeroSleep = async () => {};

test('google: invoke maps roles, parses text + usage, computes cost', async () => {
  const calls: FetchCall[] = [];
  mockFetch(
    [
      {
        body: {
          candidates: [{ content: { parts: [{ text: 'hello ' }, { text: 'world' }] } }],
          usageMetadata: { promptTokenCount: 1_000_000, candidatesTokenCount: 1_000_000 },
        },
      },
    ],
    calls,
  );
  const p = new GoogleProvider({ apiKey: 'k', model: 'gemini-3-pro', sleep: zeroSleep });
  const r = await p.invoke({
    systemPrompt: 'be terse',
    messages: [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'yo' },
      { role: 'user', content: 'again' },
    ],
  });

  assert.equal(r.text, 'hello world');
  assert.equal(r.usage.inputTokens, 1_000_000);
  assert.equal(r.usage.outputTokens, 1_000_000);
  // input $2.00/M * 1M + output $12.00/M * 1M = 14.00
  assert.ok(Math.abs(r.costUsd - 14.0) < 0.001, `cost was ${r.costUsd}`);
  assert.equal(r.provider, 'google');

  const call = calls[0];
  assert.ok(call.url.includes('/v1beta/models/gemini-3-pro:generateContent'));
  const headers = call.init?.headers as Record<string, string>;
  assert.equal(headers['x-goog-api-key'], 'k');

  const body = bodyOf(call);
  // system → system_instruction (not a contents role)
  assert.deepEqual(body.system_instruction, { parts: [{ text: 'be terse' }] });
  const contents = body.contents as Array<{ role: string; parts: Array<{ text: string }> }>;
  assert.deepEqual(
    contents.map((c) => c.role),
    ['user', 'model', 'user'],
  );
  assert.equal(contents[0].parts[0].text, 'hi');
  assert.equal(contents[1].parts[0].text, 'yo');
});

test('google: maxOutputTokens defaults to a bounded value when unset', async () => {
  const calls: FetchCall[] = [];
  mockFetch(
    [{ body: { candidates: [{ content: { parts: [{ text: 'x' }] } }], usageMetadata: {} } }],
    calls,
  );
  const p = new GoogleProvider({ apiKey: 'k', sleep: zeroSleep });
  await p.invoke({ messages: [{ role: 'user', content: 'hi' }] });
  const gen = bodyOf(calls[0]).generationConfig as Record<string, unknown>;
  assert.equal(gen.maxOutputTokens, 4096);
});

test('google: maxTokens override is forwarded', async () => {
  const calls: FetchCall[] = [];
  mockFetch(
    [{ body: { candidates: [{ content: { parts: [{ text: 'x' }] } }], usageMetadata: {} } }],
    calls,
  );
  const p = new GoogleProvider({ apiKey: 'k', sleep: zeroSleep });
  await p.invoke({ messages: [{ role: 'user', content: 'hi' }], maxTokens: 123 });
  const gen = bodyOf(calls[0]).generationConfig as Record<string, unknown>;
  assert.equal(gen.maxOutputTokens, 123);
});

test('google: outputSchema sets responseMimeType application/json', async () => {
  const calls: FetchCall[] = [];
  mockFetch(
    [{ body: { candidates: [{ content: { parts: [{ text: '{}' }] } }], usageMetadata: {} } }],
    calls,
  );
  const p = new GoogleProvider({ apiKey: 'k', sleep: zeroSleep });
  await p.invoke({
    messages: [{ role: 'user', content: 'hi' }],
    outputSchema: z.object({ ok: z.boolean() }),
  });
  const gen = bodyOf(calls[0]).generationConfig as Record<string, unknown>;
  assert.equal(gen.responseMimeType, 'application/json');
});

test('google: embed(single string) returns one vector', async () => {
  const calls: FetchCall[] = [];
  const vec = [0.1, 0.2, 0.3];
  mockFetch([{ body: { embedding: { values: vec } } }], calls);
  const p = new GoogleProvider({ apiKey: 'k', embedDims: 3, sleep: zeroSleep });
  const out = await p.embed('hello');
  assert.equal(out.length, 1);
  assert.deepEqual(out[0], vec);

  const call = calls[0];
  assert.ok(call.url.includes(':embedContent'));
  const body = bodyOf(call);
  assert.deepEqual(body.content, { parts: [{ text: 'hello' }] });
  assert.equal(body.outputDimensionality, 3);
});

test('google: embed(array) returns one vector per input', async () => {
  const calls: FetchCall[] = [];
  const a = [1, 2, 3];
  const b = [4, 5, 6];
  mockFetch([{ body: { embeddings: [{ values: a }, { values: b }] } }], calls);
  const p = new GoogleProvider({ apiKey: 'k', embedDims: 3, sleep: zeroSleep });
  const out = await p.embed(['one', 'two']);
  assert.equal(out.length, 2);
  assert.deepEqual(out[0], a);
  assert.deepEqual(out[1], b);

  const call = calls[0];
  assert.ok(call.url.includes(':batchEmbedContents'));
  const body = bodyOf(call) as { requests: Array<{ content: unknown }> };
  assert.equal(body.requests.length, 2);
  assert.deepEqual(body.requests[0].content, { parts: [{ text: 'one' }] });
});

test('google: retries on 429 then succeeds', async () => {
  const calls: FetchCall[] = [];
  mockFetch(
    [
      { status: 429, body: { error: 'rate' } },
      {
        body: {
          candidates: [{ content: { parts: [{ text: 'ok' }] } }],
          usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 },
        },
      },
    ],
    calls,
  );
  const p = new GoogleProvider({ apiKey: 'k', sleep: zeroSleep });
  const r = await p.invoke({ messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(r.text, 'ok');
  assert.equal(calls.length, 2);
});

test('google: throws with status after persistent 500', async () => {
  const calls: FetchCall[] = [];
  mockFetch([{ status: 500, body: { error: 'boom' } }], calls);
  const p = new GoogleProvider({ apiKey: 'k', sleep: zeroSleep });
  await assert.rejects(p.invoke({ messages: [{ role: 'user', content: 'hi' }] }), /google 500/);
  assert.ok(calls.length >= 4, `expected >=4 attempts, got ${calls.length}`);
});

test('google: does not retry on 400', async () => {
  const calls: FetchCall[] = [];
  mockFetch([{ status: 400, body: { error: 'bad' } }], calls);
  const p = new GoogleProvider({ apiKey: 'k', sleep: zeroSleep });
  await assert.rejects(p.invoke({ messages: [{ role: 'user', content: 'hi' }] }), /google 400/);
  assert.equal(calls.length, 1);
});

test('google: defaults match spec', async () => {
  const p = new GoogleProvider({ apiKey: 'k' });
  assert.equal(p.name, 'google');
  assert.deepEqual([...p.capabilities].sort(), ['agentic', 'embed', 'reasoning', 'summarize']);
});
