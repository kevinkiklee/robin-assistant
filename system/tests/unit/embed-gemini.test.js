import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mock, test } from 'node:test';

let tmpHome;
let originalFetch;

test.beforeEach(() => {
  tmpHome = join(tmpdir(), `robin-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(join(tmpHome, 'secrets'), { recursive: true });
  writeFileSync(join(tmpHome, 'secrets', '.env'), 'GEMINI_API_KEY=test-key\n', 'utf-8');
  process.env.ROBIN_HOME = tmpHome;
  originalFetch = globalThis.fetch;
});

test.afterEach(() => {
  globalThis.fetch = originalFetch;
  rmSync(tmpHome, { recursive: true, force: true });
});

test('embed() POSTs to embedContent endpoint', async () => {
  const calls = [];
  globalThis.fetch = mock.fn(async (url, opts) => {
    calls.push({ url, opts });
    return { ok: true, json: async () => ({ embedding: { values: [0.1, 0.2] } }) };
  });
  const { createGeminiEmbedder } = await import(`../../src/embed/gemini.js?cb=${Date.now()}`);
  const e = await createGeminiEmbedder();
  const v = await e.embed('hello');
  assert.match(calls[0].url, /embedContent.*key=test-key/);
  assert.ok(v instanceof Float32Array);
  assert.equal(v.length, 2);
  assert.ok(Math.abs(v[0] - 0.1) < 1e-6);
  assert.ok(Math.abs(v[1] - 0.2) < 1e-6);
});

test('embedBatch() POSTs to batchEmbedContents', async () => {
  const calls = [];
  globalThis.fetch = mock.fn(async (url, opts) => {
    calls.push({ url, opts });
    return {
      ok: true,
      json: async () => ({ embeddings: [{ values: [0.1] }, { values: [0.2] }] }),
    };
  });
  const { createGeminiEmbedder } = await import(`../../src/embed/gemini.js?cb=${Date.now()}`);
  const e = await createGeminiEmbedder();
  const vs = await e.embedBatch(['a', 'b']);
  assert.match(calls[0].url, /batchEmbedContents.*key=test-key/);
  assert.equal(vs.length, 2);
  assert.ok(vs[0] instanceof Float32Array);
  assert.ok(vs[1] instanceof Float32Array);
});

test('429 surfaces as GeminiError.status === 429', async () => {
  globalThis.fetch = mock.fn(async () => ({
    ok: false,
    status: 429,
    text: async () => 'rate limited',
  }));
  const { createGeminiEmbedder } = await import(`../../src/embed/gemini.js?cb=${Date.now()}`);
  const e = await createGeminiEmbedder();
  try {
    await e.embed('hello');
    assert.fail('should throw');
  } catch (err) {
    assert.equal(err.status, 429);
  }
});

test('healthCheck() requires GEMINI_API_KEY', async () => {
  rmSync(join(tmpHome, 'secrets', '.env'));
  writeFileSync(join(tmpHome, 'secrets', '.env'), '', 'utf-8');
  const { createGeminiEmbedder } = await import(`../../src/embed/gemini.js?cb=${Date.now()}`);
  const e = await createGeminiEmbedder();
  await assert.rejects(() => e.healthCheck(), /missing secret.*GEMINI_API_KEY/);
});
