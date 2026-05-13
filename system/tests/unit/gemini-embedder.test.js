// Tests for the Gemini embedder's batch chunking. The 429/5xx exponential
// backoff path is exercised by code review rather than unit tests — the
// backoff starts at 4s and grows, which would dominate the test suite if
// run with real timers, and switching to fake timers couples tightly to
// implementation choices (setTimeout vs await/sleep).

import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const __tmpHome = join(
  tmpdir(),
  `robin-gemini-test-${process.pid}-${Math.random().toString(36).slice(2)}`,
);
mkdirSync(join(__tmpHome, 'config', 'secrets'), { recursive: true });
writeFileSync(join(__tmpHome, 'config', 'secrets', '.env'), 'GEMINI_API_KEY=fake-key\n', {
  mode: 0o600,
});
process.env.ROBIN_HOME = __tmpHome;

const { createGeminiEmbedder } = await import('../../data/embed/gemini.js');

function mockFetchOk(payloads) {
  let call = 0;
  return async (_url, init) => {
    const body = JSON.parse(init.body);
    payloads.push(body.requests.length);
    call += 1;
    // Return one embedding per request in the batch.
    return {
      ok: true,
      status: 200,
      json: async () => ({
        embeddings: body.requests.map(() => ({ values: new Array(3072).fill(0.1 * call) })),
      }),
    };
  };
}

test('Gemini embedBatch with <=100 inputs sends a single batch', async () => {
  const payloads = [];
  const origFetch = globalThis.fetch;
  globalThis.fetch = mockFetchOk(payloads);
  try {
    const embedder = await createGeminiEmbedder();
    const inputs = new Array(73).fill('text');
    const vecs = await embedder.embedBatch(inputs);
    assert.equal(vecs.length, 73);
    assert.deepEqual(payloads, [73]);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('Gemini embedBatch with 100 inputs sends a single batch (boundary)', async () => {
  const payloads = [];
  const origFetch = globalThis.fetch;
  globalThis.fetch = mockFetchOk(payloads);
  try {
    const embedder = await createGeminiEmbedder();
    const inputs = new Array(100).fill('text');
    const vecs = await embedder.embedBatch(inputs);
    assert.equal(vecs.length, 100);
    assert.deepEqual(payloads, [100]);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('Gemini embedBatch with 200 inputs splits into 100 + 100', async () => {
  const payloads = [];
  const origFetch = globalThis.fetch;
  globalThis.fetch = mockFetchOk(payloads);
  try {
    const embedder = await createGeminiEmbedder();
    const inputs = new Array(200).fill('text');
    const vecs = await embedder.embedBatch(inputs);
    assert.equal(vecs.length, 200);
    assert.deepEqual(payloads, [100, 100]);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('Gemini embedBatch with 250 inputs splits into 100 + 100 + 50', async () => {
  const payloads = [];
  const origFetch = globalThis.fetch;
  globalThis.fetch = mockFetchOk(payloads);
  try {
    const embedder = await createGeminiEmbedder();
    const inputs = new Array(250).fill('text');
    const vecs = await embedder.embedBatch(inputs);
    assert.equal(vecs.length, 250);
    assert.deepEqual(payloads, [100, 100, 50]);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('Gemini embedBatch falls back to single-embed on 404/405', async () => {
  let batchCalls = 0;
  let singleCalls = 0;
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (url.includes('batchEmbedContents')) {
      batchCalls += 1;
      return { ok: false, status: 404, text: async () => 'not found' };
    }
    if (url.includes('embedContent')) {
      singleCalls += 1;
      return {
        ok: true,
        status: 200,
        json: async () => ({ embedding: { values: new Array(3072).fill(0.5) } }),
      };
    }
    throw new Error(`unexpected url: ${url}`);
  };
  try {
    const embedder = await createGeminiEmbedder();
    const inputs = new Array(3).fill('text');
    const vecs = await embedder.embedBatch(inputs);
    assert.equal(vecs.length, 3);
    assert.equal(batchCalls, 1);
    assert.equal(singleCalls, 3);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('Gemini embedBatch surfaces non-retriable errors (400) as GeminiError', async () => {
  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: false,
    status: 400,
    text: async () => 'bad request',
  });
  try {
    const embedder = await createGeminiEmbedder();
    await assert.rejects(embedder.embedBatch(['text']), (e) => e.name === 'GeminiError');
  } finally {
    globalThis.fetch = origFetch;
  }
});
