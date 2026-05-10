import assert from 'node:assert/strict';
import { afterEach, beforeEach, mock, test } from 'node:test';

const ORIGINAL_FETCH = globalThis.fetch;
const ORIGINAL_OLLAMA_HOST = process.env.OLLAMA_HOST;

beforeEach(() => {
  Reflect.deleteProperty(process.env, 'OLLAMA_HOST');
});

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
  if (ORIGINAL_OLLAMA_HOST === undefined) {
    Reflect.deleteProperty(process.env, 'OLLAMA_HOST');
  } else {
    process.env.OLLAMA_HOST = ORIGINAL_OLLAMA_HOST;
  }
});

test('embed() uses /api/embed (newer endpoint) when available', async () => {
  const calls = [];
  globalThis.fetch = mock.fn(async (url, opts) => {
    calls.push({ url, opts });
    return {
      ok: true,
      status: 200,
      json: async () => ({ embeddings: [[0.1, 0.2, 0.3]] }),
      text: async () => '',
    };
  });
  const { createOllamaEmbedder } = await import(
    `../../src/embed/ollama.js?cb=${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
  const e = await createOllamaEmbedder();
  const v = await e.embed('hello');
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/api\/embed$/);
  assert.ok(v instanceof Float32Array);
  assert.deepEqual(Array.from(v), [Math.fround(0.1), Math.fround(0.2), Math.fround(0.3)]);
});

test('embed() falls back to /api/embeddings on 404', async () => {
  const urls = [];
  let n = 0;
  globalThis.fetch = mock.fn(async (url) => {
    urls.push(url);
    n += 1;
    if (n === 1) {
      return {
        ok: false,
        status: 404,
        json: async () => ({}),
        text: async () => 'not found',
      };
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({ embedding: [0.4, 0.5] }),
      text: async () => '',
    };
  });
  const { createOllamaEmbedder } = await import(
    `../../src/embed/ollama.js?cb=${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
  const e = await createOllamaEmbedder();
  const v = await e.embed('hello');
  assert.equal(urls.length, 2);
  assert.match(urls[0], /\/api\/embed$/);
  assert.match(urls[1], /\/api\/embeddings$/);
  assert.ok(v instanceof Float32Array);
  assert.equal(v.length, 2);
  assert.equal(v[0], Math.fround(0.4));
  assert.equal(v[1], Math.fround(0.5));
});

test('healthCheck() succeeds when ollama reachable + model present', async () => {
  globalThis.fetch = mock.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ({ models: [{ name: 'qwen3-embedding:8b' }] }),
    text: async () => '',
  }));
  const { createOllamaEmbedder } = await import(
    `../../src/embed/ollama.js?cb=${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
  const e = await createOllamaEmbedder();
  await e.healthCheck();
});

test('healthCheck() throws when ollama unreachable', async () => {
  globalThis.fetch = mock.fn(async () => {
    throw new Error('connection refused');
  });
  const { createOllamaEmbedder } = await import(
    `../../src/embed/ollama.js?cb=${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
  const e = await createOllamaEmbedder();
  await assert.rejects(() => e.healthCheck(), /connection refused/);
});

test('healthCheck() throws when model missing', async () => {
  globalThis.fetch = mock.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ({ models: [{ name: 'llama3' }] }),
    text: async () => '',
  }));
  const { createOllamaEmbedder } = await import(
    `../../src/embed/ollama.js?cb=${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
  const e = await createOllamaEmbedder();
  await assert.rejects(() => e.healthCheck(), /qwen3-embedding:8b is not installed/);
});

test('OLLAMA_HOST env override is honoured', async () => {
  process.env.OLLAMA_HOST = 'http://10.0.0.5:11434';
  const urls = [];
  globalThis.fetch = mock.fn(async (url) => {
    urls.push(url);
    return {
      ok: true,
      status: 200,
      json: async () => ({ models: [{ name: 'qwen3-embedding:8b' }] }),
      text: async () => '',
    };
  });
  // Re-import to pick up the env var (module-level constant).
  const { createOllamaEmbedder } = await import(
    `../../src/embed/ollama.js?cb=${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
  const e = await createOllamaEmbedder();
  await e.healthCheck();
  assert.equal(urls.length, 1);
  assert.match(urls[0], /^http:\/\/10\.0\.0\.5:11434\/api\/tags$/);
});
