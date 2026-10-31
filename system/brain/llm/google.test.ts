import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
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

test('google: invoke throws — provider is embed-only (Claude-only policy)', async () => {
  const p = new GoogleProvider({ apiKey: 'k', sleep: zeroSleep });
  await assert.rejects(p.invoke({ messages: [{ role: 'user', content: 'hi' }] }), /embed-only/);
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
  const headers = call.init?.headers as Record<string, string>;
  assert.equal(headers['x-goog-api-key'], 'k');
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
  const vec = [0.5];
  mockFetch(
    [{ status: 429, body: { error: 'rate' } }, { body: { embedding: { values: vec } } }],
    calls,
  );
  const p = new GoogleProvider({ apiKey: 'k', embedDims: 1, sleep: zeroSleep });
  const out = await p.embed('hi');
  assert.deepEqual(out, [vec]);
  assert.equal(calls.length, 2);
});

test('google: throws with status after persistent 500', async () => {
  const calls: FetchCall[] = [];
  mockFetch([{ status: 500, body: { error: 'boom' } }], calls);
  const p = new GoogleProvider({ apiKey: 'k', sleep: zeroSleep });
  await assert.rejects(p.embed('hi'), /google 500/);
  assert.ok(calls.length >= 4, `expected >=4 attempts, got ${calls.length}`);
});

test('google: does not retry on 400', async () => {
  const calls: FetchCall[] = [];
  mockFetch([{ status: 400, body: { error: 'bad' } }], calls);
  const p = new GoogleProvider({ apiKey: 'k', sleep: zeroSleep });
  await assert.rejects(p.embed('hi'), /google 400/);
  assert.equal(calls.length, 1);
});

test('google: defaults match spec', async () => {
  const p = new GoogleProvider({ apiKey: 'k' });
  assert.equal(p.name, 'google');
  assert.deepEqual([...p.capabilities], ['embed']);
});
