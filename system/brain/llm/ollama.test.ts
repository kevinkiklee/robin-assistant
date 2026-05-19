import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startMockServer } from './_test-server.ts';
import { OllamaProvider } from './ollama.ts';

test('ollama: invoke returns text + usage from mock /api/chat', async () => {
  const { url, server } = await startMockServer([
    {
      method: 'POST',
      path: '/api/chat',
      body: { message: { content: 'hello world' }, prompt_eval_count: 7, eval_count: 3 },
    },
  ]);
  const p = new OllamaProvider({ baseUrl: url, chatModel: 'm' });
  const r = await p.invoke({ messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(r.text, 'hello world');
  assert.equal(r.usage.inputTokens, 7);
  assert.equal(r.usage.outputTokens, 3);
  assert.equal(r.provider, 'ollama');
  server.close();
});

test('ollama: embed returns 1d arrays per input', async () => {
  const { url, server } = await startMockServer([
    { method: 'POST', path: '/api/embeddings', body: { embedding: [0.1, 0.2, 0.3] } },
  ]);
  const p = new OllamaProvider({ baseUrl: url, chatModel: 'm', embedModel: 'e' });
  const r = await p.embed(['one']);
  assert.deepEqual(r, [[0.1, 0.2, 0.3]]);
  server.close();
});

test('ollama: invoke throws on non-OK status', async () => {
  const { url, server } = await startMockServer([
    { method: 'POST', path: '/api/chat', status: 500, body: { error: 'broken' } },
  ]);
  const p = new OllamaProvider({ baseUrl: url, chatModel: 'm' });
  await assert.rejects(p.invoke({ messages: [{ role: 'user', content: 'hi' }] }), /ollama chat 500/);
  server.close();
});
