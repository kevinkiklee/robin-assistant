import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import { createGeminiAdapter } from '../../runtime/hosts/gemini.js';

function fakeSpawnWithStats(stats) {
  const envelope = JSON.stringify({ session_id: 's', response: 'ok', stats });
  return mock.fn(() => ({
    stdout: {
      on: (event, cb) => {
        if (event === 'data') setImmediate(() => cb(Buffer.from(envelope)));
      },
    },
    stderr: { on: () => {} },
    stdin: { write: () => {}, end: () => {} },
    on: (event, cb) => {
      if (event === 'exit') setImmediate(() => cb(0));
    },
  }));
}

test('cache_read_tokens reflects sum of stats.models[*].tokens.cached', async () => {
  const fakeSpawn = fakeSpawnWithStats({
    models: {
      'gemini-2.5-flash-lite': { tokens: { prompt: 100, candidates: 5, cached: 0 } },
      'gemini-2.5-flash': { tokens: { prompt: 200, candidates: 12, cached: 80 } },
    },
  });
  const adapter = createGeminiAdapter({ spawn: fakeSpawn });
  const result = await adapter.invokeLLM([{ role: 'user', content: 'q' }], { tier: 'fast' });
  assert.equal(result.usage.cache_read_tokens, 80);
  assert.equal(result.usage.input_tokens, 300);
  assert.equal(result.usage.output_tokens, 17);
});

test('cache_read_tokens is 0 when no models report cached tokens', async () => {
  const fakeSpawn = fakeSpawnWithStats({
    models: {
      'gemini-2.5-flash': { tokens: { prompt: 50, candidates: 3 } }, // no cached field
    },
  });
  const adapter = createGeminiAdapter({ spawn: fakeSpawn });
  const result = await adapter.invokeLLM([{ role: 'user', content: 'q' }], { tier: 'fast' });
  assert.equal(result.usage.cache_read_tokens, 0);
});

test('usage shape is well-formed even when stats.models is missing', async () => {
  const fakeSpawn = fakeSpawnWithStats({});
  const adapter = createGeminiAdapter({ spawn: fakeSpawn });
  const result = await adapter.invokeLLM([{ role: 'user', content: 'q' }], { tier: 'fast' });
  assert.equal(result.usage.input_tokens, 0);
  assert.equal(result.usage.output_tokens, 0);
  assert.equal(result.usage.cache_read_tokens, 0);
});
